'use strict';

// The shared outbound HTTP client. Every branch is driven through an injected
// transport, so nothing here opens a socket.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  HttpClientError,
  RETRY_SAFETY,
  TIMEOUT_PROFILES,
  createHttpClient,
  mergeTimeouts,
  parseRetryAfterMs,
  readResponseText,
} = require('../src/clients/http');

function jsonResponse(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers,
    body: { text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) },
  };
}

function recordingClient(responses, overrides = {}) {
  const calls = [];
  const client = createHttpClient({
    name: 'test',
    transport: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
  return { client, calls };
}

test('a 2xx response returns the status, body and headers', async () => {
  const { client } = recordingClient([jsonResponse(200, { ok: true }, { 'x-id': 'abc' })]);
  const response = await client.request('https://vendor.test/thing');

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { ok: true });
  assert.equal(response.headers['x-id'], 'abc');
});

test('requestJson serialises the body and sets the content type', async () => {
  const { client, calls } = recordingClient([jsonResponse(200, { id: 'doc-1' })]);
  const response = await client.requestJson('https://vendor.test/documents', {
    method: 'POST',
    body: { name: 'a document' },
  });

  assert.deepEqual(response.data, { id: 'doc-1' });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.equal(calls[0].options.body, JSON.stringify({ name: 'a document' }));
});

test('a non-JSON body on a JSON request is reported, not returned as text', async () => {
  const { client } = recordingClient([jsonResponse(200, '<html>not json</html>')]);
  await assert.rejects(
    () => client.requestJson('https://vendor.test/thing'),
    (error) => error instanceof HttpClientError && error.category === 'malformed_response',
  );
});

test('an operation that is not safe to retry is attempted exactly once', async () => {
  const { client, calls } = recordingClient([jsonResponse(503, { error: 'busy' }), jsonResponse(200, {})]);
  await assert.rejects(() => client.request('https://vendor.test/thing', {
    method: 'POST',
    retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY,
    maxAttempts: 3,
  }), (error) => error.status === 503 && error.attemptCount === 1);

  assert.equal(calls.length, 1);
});

test('a retryable status is retried up to the attempt bound and then reported', async () => {
  const { client, calls } = recordingClient([
    jsonResponse(503, {}), jsonResponse(503, {}), jsonResponse(503, {}),
  ]);
  await assert.rejects(() => client.request('https://vendor.test/thing', {
    retrySafety: RETRY_SAFETY.SAFE_TO_RETRY,
    maxAttempts: 3,
  }), (error) => error.status === 503 && error.attemptCount === 3);

  assert.equal(calls.length, 3);
});

test('a retry that succeeds returns the successful response', async () => {
  const { client, calls } = recordingClient([jsonResponse(429, {}), jsonResponse(200, { ok: 1 })]);
  const response = await client.request('https://vendor.test/thing', {
    retrySafety: RETRY_SAFETY.SAFE_TO_RETRY,
    maxAttempts: 3,
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
});

test('a 4xx is not retried even when the operation is safe to retry', async () => {
  const { client, calls } = recordingClient([jsonResponse(404, {}), jsonResponse(200, {})]);
  await assert.rejects(() => client.request('https://vendor.test/thing', {
    retrySafety: RETRY_SAFETY.SAFE_TO_RETRY,
    maxAttempts: 3,
  }), (error) => error.status === 404 && error.category === 'request_rejected');

  assert.equal(calls.length, 1);
});

test('a retryable network error is retried; an unrecognised one is not', async () => {
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const { client, calls } = recordingClient([reset, jsonResponse(200, { ok: 1 })]);
  assert.equal((await client.request('https://vendor.test/thing', {
    retrySafety: RETRY_SAFETY.SAFE_TO_RETRY,
    maxAttempts: 2,
  })).status, 200);
  assert.equal(calls.length, 2);

  const odd = Object.assign(new Error('something else'), { code: 'EWHATEVER' });
  const second = recordingClient([odd, jsonResponse(200, {})]);
  await assert.rejects(() => second.client.request('https://vendor.test/thing', {
    retrySafety: RETRY_SAFETY.SAFE_TO_RETRY,
    maxAttempts: 3,
  }), (error) => error instanceof HttpClientError && error.category === 'network');
  assert.equal(second.calls.length, 1);
});

test('every attempt carries an abort signal and the profile timeouts', async () => {
  const { client, calls } = recordingClient([jsonResponse(200, {})]);
  await client.request('https://vendor.test/thing', { timeout: 'health_read' });

  const { options } = calls[0];
  assert.ok(options.signal, 'an abort signal must be attached');
  assert.equal(options.headersTimeout, TIMEOUT_PROFILES.health_read.headersMs);
  assert.equal(options.bodyTimeout, TIMEOUT_PROFILES.health_read.bodyMs);
  assert.equal(options.maxRedirections, 0);
});

test('an unknown timeout profile is refused rather than run unbounded', async () => {
  const { client } = recordingClient([jsonResponse(200, {})]);
  await assert.rejects(() => client.request('https://vendor.test/thing', { timeout: 'forever' }),
    /unknown_timeout_profile:forever/);
});

test('an operation budget shrinks the per-attempt timeout as it is spent', async () => {
  let clock = 0;
  const { client, calls } = recordingClient(
    [jsonResponse(503, {}), jsonResponse(200, {})],
    { now: () => { clock += 1500; return clock; } },
  );
  await client.request('https://vendor.test/thing', {
    timeout: 'health_read',
    retrySafety: RETRY_SAFETY.SAFE_TO_RETRY,
    maxAttempts: 2,
  });

  assert.equal(calls.length, 2);
});

test('timeout overrides cannot remove a bound', () => {
  const merged = mergeTimeouts({ read: { requestMs: 0, connectMs: -5 } });

  assert.equal(merged.read.requestMs, TIMEOUT_PROFILES.read.requestMs);
  assert.equal(merged.read.connectMs, TIMEOUT_PROFILES.read.connectMs);
});

test('Retry-After is honoured in both forms and never exceeds the ceiling', () => {
  assert.equal(parseRetryAfterMs('2', 0), 1000);
  // toUTCString has second resolution, so the date form is expressed in seconds.
  assert.equal(parseRetryAfterMs(new Date(2000).toUTCString(), 0), 1000);
  assert.equal(parseRetryAfterMs('not a delay', 0), null);
  assert.equal(parseRetryAfterMs(undefined, 0), null);
});

test('a response body is read only up to the byte cap', async () => {
  async function* chunks() {
    yield Buffer.alloc(600, 'a');
    yield Buffer.alloc(600, 'b');
  }
  assert.equal((await readResponseText(chunks(), 1000)).length, 1000);
});
