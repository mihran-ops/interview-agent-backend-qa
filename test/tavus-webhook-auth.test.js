'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://fixture.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fixture-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'fixture-anon-key';
const AUTH_SECRET = Buffer.alloc(32, 7).toString('base64url');
process.env.TAVUS_WEBHOOK_SECRET = AUTH_SECRET;

const {
  TAVUS_WEBHOOK_AUTH_QUERY_PARAM,
  buildAuthenticatedTavusWebhookUrl,
  getTavusWebhookAuthReadiness,
  omitProviderCallbackUrls,
  redactTavusWebhookAuth,
  verifyTavusWebhookRequest,
} = require('../src/lib/tavusWebhookAuth');
const router = require('../routes/webhook');

async function postWebhook({ query = '', body = {}, rawBody = null } = {}) {
  const app = express();
  app.use('/webhook', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/webhook/tavus${query}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawBody === null ? JSON.stringify(body) : rawBody,
      },
    );
    return {
      status: response.status,
      body: await response.json(),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function captureConsole(callback) {
  const captured = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const method of Object.keys(original)) {
    console[method] = (...args) => captured.push([method, ...args]);
  }
  try {
    await callback();
  } finally {
    Object.assign(console, original);
  }
  return captured;
}

test('active Tavus route rejects a missing callback secret before handler logic', async () => {
  const response = await postWebhook({
    body: {
      event_type: 'synthetic.unknown',
      conversation_id: 'synthetic-conversation',
    },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'webhook_authentication_failed',
  });
});

test('active Tavus route rejects an incorrect callback secret before handler logic', async () => {
  const response = await postWebhook({
    query: '?tavus_webhook_token=deliberately-wrong',
    body: {
      event_type: 'synthetic.unknown',
      conversation_id: 'synthetic-conversation',
    },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'webhook_authentication_failed',
  });
});

test('active Tavus route rejects empty, malformed, and duplicate callback authentication', async () => {
  for (const query of [
    `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=`,
    `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=not%20base64url`,
    `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=one&${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=two`,
  ]) {
    const response = await postWebhook({
      query,
      body: { event_type: 'synthetic.unknown' },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      ok: false,
      error: 'webhook_authentication_failed',
    });
  }
});

test('authentication runs before JSON parsing and therefore before product mutation', async () => {
  const response = await postWebhook({ rawBody: '{not-json' });
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'webhook_authentication_failed',
  });
});

test('authenticated malformed JSON receives a bounded validation response', async () => {
  const response = await postWebhook({
    query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
    rawBody: '{not-json',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'invalid_webhook_payload',
  });
});

test('correct callback secret enters the existing handler behavior', async () => {
  const response = await postWebhook({
    query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
    body: {
      event_type: 'synthetic.unknown',
      conversation_id: 'synthetic-conversation',
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, ignored: true });
});

test('authenticated empty payload is rejected before callback processing', async () => {
  const response = await postWebhook({
    query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
    body: {},
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'invalid_webhook_payload',
  });
});

test('authenticated conflicting conversation identifiers are rejected', async () => {
  const response = await postWebhook({
    query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
    body: {
      event_type: 'synthetic.unknown',
      conversation_id: 'synthetic-conversation-a',
      properties: { conversation_id: 'synthetic-conversation-b' },
    },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'invalid_webhook_payload',
  });
});

test('authenticated root primitives and missing envelope fields are rejected generically', async () => {
  for (const body of [null, [], 'payload', 7, { conversation_id: 'synthetic-conversation' }]) {
    const response = await postWebhook({
      query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      ok: false,
      error: 'invalid_webhook_payload',
    });
  }
});

test('authenticated missing and wrong-type conversation identifiers are rejected', async () => {
  for (const body of [
    { event_type: 'synthetic.unknown' },
    { event_type: 'synthetic.unknown', conversation_id: 7 },
    { event_type: 'synthetic.unknown', conversation_id: [] },
    { event_type: 'synthetic.unknown', conversation_id: {} },
  ]) {
    const response = await postWebhook({
      query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      ok: false,
      error: 'invalid_webhook_payload',
    });
  }
});

test('validation rejection logs are bounded and exclude raw callback contents', async () => {
  const sentinels = [
    'candidate@example.test',
    'synthetic transcript never log',
    'https://example.invalid/recording?signature=never-log',
    AUTH_SECRET,
    'synthetic-tavus-api-key-never-log',
  ];
  const logs = await captureConsole(async () => {
    const response = await postWebhook({
      query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
      body: {
        event_type: 'application.recording_ready',
        conversation_id: 'conversation-a',
        properties: {
          conversation_id: 'conversation-b',
          transcript: sentinels[1],
          recording_url: sentinels[2],
          candidate_email: sentinels[0],
          webhook_secret: AUTH_SECRET,
          api_key: sentinels[4],
        },
      },
    });
    assert.equal(response.status, 400);
  });
  const serialized = JSON.stringify(logs);
  for (const sentinel of sentinels) assert.equal(serialized.includes(sentinel), false);
  assert.match(serialized, /conflicting_conversation_ids/);
  assert.match(serialized, /identifier_conflict/);
});

test('every rejected envelope returns before any database or provider operation', async () => {
  let databaseCalls = 0;
  router._setSupabaseAdminForTest({
    from() {
      databaseCalls += 1;
      throw new Error('database must not be reached');
    },
    rpc() {
      databaseCalls += 1;
      throw new Error('database must not be reached');
    },
  });
  try {
    const invalidPayloads = [
      {},
      { event_type: 'system.shutdown' },
      { event_type: 'system.shutdown', conversation_id: 7 },
      {
        event_type: 'system.shutdown',
        conversation_id: 'conversation-a',
        properties: { conversation_id: 'conversation-b' },
      },
      {
        event_type: 'application.transcription_ready',
        conversation_id: 'conversation-a',
        properties: { transcript: 'invalid' },
      },
    ];
    for (const body of invalidPayloads) {
      const response = await postWebhook({
        query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
        body,
      });
      assert.equal(response.status, 400);
    }
    assert.equal(databaseCalls, 0);
  } finally {
    router._setSupabaseAdminForTest(undefined);
  }
});

test('known valid event for an unbound conversation performs reads only and is safely ignored', async () => {
  const tracker = { reads: 0, mutations: 0 };
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      tracker.reads += 1;
      return { data: null, error: null };
    },
    update() {
      tracker.mutations += 1;
      return this;
    },
    insert() {
      tracker.mutations += 1;
      return this;
    },
  };
  router._setSupabaseAdminForTest({
    from() { return query; },
    rpc() {
      tracker.mutations += 1;
      throw new Error('mutation must not be reached');
    },
  });
  try {
    const response = await postWebhook({
      query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
      body: {
        event_type: 'system.replica_joined',
        conversation_id: 'synthetic-nonexistent-conversation',
        properties: { face_id: 'synthetic-face' },
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, ignored: true });
    assert.equal(tracker.reads, 2);
    assert.equal(tracker.mutations, 0);
  } finally {
    router._setSupabaseAdminForTest(undefined);
  }
});

test('missing server configuration fails closed and readiness is bounded', async () => {
  const previous = process.env.TAVUS_WEBHOOK_SECRET;
  delete process.env.TAVUS_WEBHOOK_SECRET;
  try {
    const response = await postWebhook({
      query: `?${TAVUS_WEBHOOK_AUTH_QUERY_PARAM}=${encodeURIComponent(AUTH_SECRET)}`,
      body: { event_type: 'synthetic.unknown' },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      ok: false,
      error: 'webhook_authentication_failed',
    });
    assert.deepEqual(getTavusWebhookAuthReadiness(), {
      ok: false,
      configured: false,
      status: 'missing_or_invalid',
    });
  } finally {
    process.env.TAVUS_WEBHOOK_SECRET = previous;
  }
});

test('verification hashes to fixed length and uses timing-safe comparison', () => {
  assert.deepEqual(
    verifyTavusWebhookRequest({
      query: { [TAVUS_WEBHOOK_AUTH_QUERY_PARAM]: AUTH_SECRET },
    }),
    { ok: true, status: 200, category: null },
  );
  assert.deepEqual(
    verifyTavusWebhookRequest({
      query: { [TAVUS_WEBHOOK_AUTH_QUERY_PARAM]: Buffer.alloc(32, 8).toString('base64url') },
    }),
    { ok: false, status: 401, category: 'invalid_secret' },
  );
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'tavusWebhookAuth.js'),
    'utf8',
  );
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /crypto\.timingSafeEqual\(expectedDigest, providedDigest\)/);
  assert.doesNotMatch(source, /provided\s*===\s*expected|expected\s*===\s*provided/);
});

test('canonical callback builder uses the QA route and encodes authentication safely', () => {
  const callback = buildAuthenticatedTavusWebhookUrl(
    'https://ia-backend-qa.onrender.com/webhook/tavus?existing=safe',
  );
  const url = new URL(callback);
  assert.equal(url.origin, 'https://ia-backend-qa.onrender.com');
  assert.equal(url.pathname, '/webhook/tavus');
  assert.equal(url.searchParams.get('existing'), 'safe');
  assert.equal(url.searchParams.get(TAVUS_WEBHOOK_AUTH_QUERY_PARAM), AUTH_SECRET);
  assert.doesNotMatch(callback, /\s/);
});

test('callback authentication is removed from logs, Sentry-shaped data, and provider responses', () => {
  const callback = buildAuthenticatedTavusWebhookUrl(
    'https://ia-backend-qa.onrender.com/webhook/tavus',
  );
  const redacted = redactTavusWebhookAuth({
    request: { url: callback },
    breadcrumbs: [{ data: { callback_url: callback } }],
    extra: { raw: `provider returned ${callback}`, secret: AUTH_SECRET },
  });
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, new RegExp(AUTH_SECRET));
  assert.match(serialized, /REDACTED/);

  const clientSafe = omitProviderCallbackUrls({
    conversation_id: 'synthetic-conversation',
    callback_url: callback,
    nested: { webhook_url: callback, status: 'active' },
  });
  assert.deepEqual(clientSafe, {
    conversation_id: 'synthetic-conversation',
    nested: { status: 'active' },
  });
});

test('all conversation-create paths use the canonical authenticated callback builder', () => {
  const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const route = read('routes/createTavusInterview.js');
  const legacyRoute = read('createTavusInterview.js');
  const legacyInternal = read('lib/createTavusInterviewInternal.js');
  const activeWebhook = read('routes/webhook.js');
  const tavusEventPipeline = read('src/services/tavusEvents/index.js');
  const legacyWebhook = read('handlers/tavusWebhook.js');
  const app = read('app.js');

  for (const source of [route, legacyRoute, legacyInternal]) {
    assert.match(source, /buildAuthenticatedTavusWebhookUrl/);
  }
  assert.doesNotMatch(legacyRoute, /callback_url:\s*`\$\{callbackBase\}/);
  assert.doesNotMatch(legacyInternal, /callback_url:\s*`\$\{callbackBase\}/);
  assert.match(
    activeWebhook,
    /router\.post\(\s*['"]\/tavus['"],\s*authenticateTavusWebhookRequest,\s*parseTavusWebhookJson,\s*handleTavusWebhookJsonError/,
  );
  // The event pipeline now lives in the service, so the ordering invariant spans two
  // files: the middleware chain pins authentication and bounded parsing ahead of the
  // event handler, and the handler is where payload validation runs.
  const authAt = activeWebhook.indexOf('authenticateTavusWebhookRequest,');
  const parseAt = activeWebhook.indexOf('parseTavusWebhookJson,', authAt);
  const handlerAt = activeWebhook.indexOf('tavusEvents.handleTavusWebhookEvent', parseAt);
  assert.ok(
    authAt !== -1 && parseAt > authAt && handlerAt > parseAt,
    'sender authentication and bounded JSON parsing must precede the event handler',
  );
  assert.match(tavusEventPipeline, /validateTavusWebhookPayload/);
  assert.doesNotMatch(activeWebhook, /validateTavusWebhookPayload/);
  assert.match(activeWebhook, /express\.json\(\{ limit: '10mb' \}\)/);
  assert.match(activeWebhook, /error: 'invalid_webhook_payload'/);
  assert.match(legacyWebhook, /verifyTavusWebhookRequest/);
  assert.match(legacyWebhook, /validateTavusWebhookPayload/);
  assert.doesNotMatch(legacyWebhook, /if\s*\(!secret\)\s*return true/);

  assert.ok(
    route.indexOf('const webhookUrl = buildAuthenticatedTavusWebhookUrl')
      < route.indexOf('const claimed = await claimInterviewAttempt'),
    'callback authentication configuration must be validated before an interview attempt is claimed',
  );
  assert.match(app, /const tavus_webhook_auth = getTavusWebhookAuthReadiness\(\)/);
  assert.match(app, /ok: supabase_auth\.ok === true && tavus_webhook_auth\.ok === true/);
  assert.match(app, /beforeSendTransaction\(event\)[\s\S]*redactTavusWebhookAuth\(event\)/);
  assert.match(app, /beforeSendSpan\(span\)[\s\S]*redactTavusWebhookAuth\(span\)/);
});
