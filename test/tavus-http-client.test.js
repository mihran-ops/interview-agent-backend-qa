'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  DEFAULT_TAVUS_BASE_URL,
  OPERATION_CONFIG,
  RETRY_SAFETY,
  TavusProviderError,
  TIMEOUTS,
  createTavusHttpClient,
  parseRetryAfterMs,
  sanitizeProviderText,
} = require('../src/clients/tavus');

function response(statusCode, value, headers = {}) {
  const text = value === undefined
    ? ''
    : (typeof value === 'string' ? value : JSON.stringify(value));
  return {
    statusCode,
    headers,
    body: {
      async text() {
        return text;
      },
    },
  };
}

function createHarness(sequence, options = {}) {
  const calls = [];
  const sleeps = [];
  const telemetry = [];
  let index = 0;
  const client = createTavusHttpClient({
    apiKey: 'synthetic-tavus-secret',
    now: options.now,
    random: () => options.random ?? 0.5,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    telemetry: (event) => telemetry.push(event),
    transport: async (url, requestOptions) => {
      calls.push({ url, options: requestOptions });
      const item = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      if (typeof item === 'function') return item(url, requestOptions);
      if (item instanceof Error) throw item;
      return item;
    },
    timeouts: options.timeouts,
  });
  return { calls, client, sleeps, telemetry };
}

test('configuration centralizes the Tavus base URL, API header, timeouts, and operation safety', async () => {
  assert.equal(DEFAULT_TAVUS_BASE_URL, 'https://tavusapi.com/v2');
  assert.equal(TIMEOUTS.read.requestMs, 8000);
  assert.equal(TIMEOUTS.health_read.operationMs, 4500);
  assert.equal(OPERATION_CONFIG.create_conversation.retrySafety, RETRY_SAFETY.NOT_SAFE_TO_RETRY);
  assert.equal(OPERATION_CONFIG.list_conversations.retrySafety, RETRY_SAFETY.SAFE_TO_RETRY);

  const { calls, client } = createHarness([response(200, { data: [] })]);
  await client.listConversations({ limit: 100, page: 1 });
  assert.equal(calls[0].url, 'https://tavusapi.com/v2/conversations?limit=100&page=1');
  assert.equal(calls[0].options.headers['x-api-key'], 'synthetic-tavus-secret');
  assert.equal(calls[0].options.headers.authorization, undefined);
});

test('2xx JSON and 204 no-content responses succeed', async () => {
  const json = createHarness([response(200, { conversation_id: 'synthetic' })]);
  assert.deepEqual(await json.client.getConversation('synthetic'), { conversation_id: 'synthetic' });

  const empty = createHarness([response(204)]);
  assert.equal(await empty.client.endConversation('synthetic'), null);
});

test('malformed success JSON becomes a bounded normalized error', async () => {
  const { client } = createHarness([response(200, '{invalid-json')]);
  await assert.rejects(
    () => client.getConversation('synthetic'),
    (error) => error instanceof TavusProviderError
      && error.category === 'malformed_response'
      && error.status === 200
      && error.attemptCount === 1,
  );
});

test('non-JSON HTTP failures retain status classification without exposing the body', async () => {
  const { client } = createHarness([response(400, 'candidate@example.test raw provider body')]);
  const error = await client.getConversation('synthetic').then(() => null, (caught) => caught);
  assert.ok(error instanceof TavusProviderError);
  assert.equal(error.status, 400);
  assert.equal(error.category, 'validation');
  assert.doesNotMatch(JSON.stringify(error.toJSON()), /candidate@example|raw provider body/i);
});

test('request timeout aborts and produces deterministic normalized timeout failure', async () => {
  const { client } = createHarness([
    (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  ], {
    timeouts: {
      read: { requestMs: 5, connectMs: 5, headersMs: 5, bodyMs: 5 },
    },
  });

  await assert.rejects(
    () => client.getConversation('synthetic', { maxAttempts: 1 }),
    (error) => error instanceof TavusProviderError
      && error.category === 'timeout'
      && error.timeout === true
      && error.timeoutPhase === 'request'
      && error.attemptCount === 1,
  );
});

test('safe reads retry transient reset, DNS, timeout, 408, 429, 502, 503, and 504 only', async () => {
  for (const transient of [
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }),
  ]) {
    const { calls, client } = createHarness([transient, response(200, { ok: true })]);
    assert.deepEqual(await client.getConversation('synthetic'), { ok: true });
    assert.equal(calls.length, 2);
  }

  for (const status of [408, 429, 502, 503, 504]) {
    const { calls, client } = createHarness([
      response(status, { code: `synthetic_${status}` }),
      response(200, { ok: true }),
    ]);
    assert.deepEqual(await client.getConversation('synthetic'), { ok: true });
    assert.equal(calls.length, 2, String(status));
  }
});

test('400, 401, 403, 404, 409, and 500 never retry', async () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    const { calls, client } = createHarness([
      response(status, { code: `synthetic_${status}`, message: 'bounded failure' }),
      response(200, { should_not_happen: true }),
    ]);
    await assert.rejects(
      () => client.getConversation('synthetic'),
      (error) => error instanceof TavusProviderError
        && error.status === status
        && error.attemptCount === 1,
    );
    assert.equal(calls.length, 1, String(status));
  }
});

test('unsafe create/document/persona/PAL/dictionary/end mutations never retry transient failures', async () => {
  for (const invoke of [
    (client) => client.createConversation({ conversation_name: 'synthetic' }),
    (client) => client.createDocument({ document_name: 'synthetic', document_url: 'https://example.invalid/kb' }),
    (client) => client.createPersona({ name: 'synthetic' }),
    (client) => client.patchPersona('synthetic', [{ op: 'replace', path: '/name', value: 'synthetic' }]),
    (client) => client.patchPal('synthetic', [{ op: 'replace', path: '/name', value: 'synthetic' }]),
    (client) => client.publishPal('synthetic'),
    (client) => client.createPronunciationDictionary({ name: 'synthetic', rules: [] }),
    (client) => client.updatePronunciationDictionary('synthetic', [{ op: 'replace', path: '/rules', value: [] }]),
    (client) => client.endConversation('synthetic'),
  ]) {
    const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const { calls, client } = createHarness([reset, response(200, { should_not_happen: true })]);
    await assert.rejects(() => invoke(client), TavusProviderError);
    assert.equal(calls.length, 1);
  }
});

test('Retry-After seconds/date parsing is capped and honored only by a safe operation', async () => {
  assert.equal(parseRetryAfterMs('2', { nowMs: 0, capMs: 1000 }), 1000);
  assert.equal(parseRetryAfterMs('invalid', { nowMs: 0, capMs: 1000 }), null);
  const date = new Date(2500).toUTCString();
  assert.equal(parseRetryAfterMs(date, { nowMs: 0, capMs: 1000 }), 1000);

  const { client, sleeps } = createHarness([
    response(429, { code: 'rate_limited' }, { 'retry-after': '2' }),
    response(200, { ok: true }),
  ]);
  await client.getConversation('synthetic');
  assert.deepEqual(sleeps, [1000]);
});

test('backoff is exponential, jittered within bounds, capped, bounded, and uses fake sleep', async () => {
  const reset = () => Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  const { calls, client, sleeps } = createHarness([
    reset(),
    reset(),
    response(200, { ok: true }),
  ], { random: 0.5 });
  await client.getConversation('synthetic');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test('provider errors expose the normalized adapter contract without raw response data', async () => {
  const { client } = createHarness([
    response(503, {
      code: 'provider_busy',
      message: 'contact candidate@example.test with x-api-key: secret at https://signed.invalid/file?token=secret',
      transcript: 'must never escape',
    }),
    response(503, { code: 'provider_busy' }),
    response(503, { code: 'provider_busy' }),
  ]);
  const error = await client.getConversation('synthetic').then(() => null, (caught) => caught);
  assert.ok(error instanceof TavusProviderError);
  assert.equal(error.status, 503);
  assert.equal(error.httpStatus, 503);
  assert.equal(error.providerCode, 'provider_busy');
  assert.equal(error.attemptCount, 3);
  assert.equal(error.retryable, true);
  assert.equal(Object.hasOwn(error, 'response'), false);
  assert.doesNotMatch(JSON.stringify(error.toJSON()), /candidate@example|token=secret|must never escape|x-api-key: secret/i);
});

test('telemetry contains bounded metadata and never includes key, URL, headers, or payload', async () => {
  const { client, telemetry } = createHarness([
    response(503, { code: 'temporary' }),
    response(200, { conversation_id: 'synthetic' }),
  ]);
  await client.createReadRequestForTest('get_conversation', '/conversations/synthetic');
  assert.deepEqual(telemetry.map((event) => event.event), [
    'tavus_request_started',
    'tavus_request_retry',
    'tavus_request_started',
    'tavus_request_succeeded',
  ]);
  const serialized = JSON.stringify(telemetry);
  assert.doesNotMatch(serialized, /synthetic-tavus-secret|x-api-key|https?:|conversation_id|payload/i);
});

test('health read uses at most two attempts and the dedicated finite timeout profile', async () => {
  const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  const { calls, client } = createHarness([reset, reset, response(200, { should_not_happen: true })]);
  await assert.rejects(() => client.listConversations({ limit: 100 }, { health: true }), TavusProviderError);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headersTimeout, TIMEOUTS.health_read.headersMs);
  assert.equal(calls[0].options.bodyTimeout, TIMEOUTS.health_read.bodyMs);
});

test('health read refuses a retry that would exceed the overall operation budget', async () => {
  const moments = [0, 0, 4450];
  const { calls, client, sleeps } = createHarness([
    response(503, { code: 'temporary' }),
    response(200, { should_not_happen: true }),
  ], {
    now: () => moments.shift() ?? 4450,
  });
  await assert.rejects(() => client.listConversations({ limit: 100 }, { health: true }), TavusProviderError);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('sanitizer removes credentials, emails, and signed URL material', () => {
  const sanitized = sanitizeProviderText(
    'Bearer token x-api-key: secret candidate@example.test https://signed.invalid/file?token=secret',
  );
  assert.doesNotMatch(sanitized, /token|secret|candidate@example|signed\.invalid/i);
});
