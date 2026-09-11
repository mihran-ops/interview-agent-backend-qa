const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const { createSupportVoiceGateway, isConfigurationReady, safeIp } = require('../src/services/supportVoiceGateway');
const { createBacking, createMemorySupportVoiceStore } = require('./helpers/supportVoiceTestStore');

const ORIGIN = 'https://alphasourceai-com.onrender.com';

function serviceDb(count = 1) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table };
      calls.push(call);
      return {
        select(columns, options) {
          call.columns = columns;
          call.options = options;
          return {
            eq(column, userId) {
              call.column = column;
              call.userId = userId;
              return {
                is(filter, value) {
                  call.filter = filter;
                  call.value = value;
                  return Promise.resolve({ data: null, count, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

async function harness({ memberCount = 1, enabled = true, globalAdmin = false, rateLimitImpl, pendingTtlMs, rateTimeoutMs, reserveFailureAfterCommit = false, providerCanary, allowedOrigin = ORIGIN, allowedOrigins } = {}) {
  let authCalls = 0;
  const rateCalls = [];
  const app = express();
  const env = {
    NODE_ENV: 'test',
    SUPPORT_VOICE_ENABLED: enabled ? 'true' : 'false',
    SUPPORT_VOICE_ALLOWED_ORIGIN: allowedOrigin,
    SUPPORT_VOICE_ALLOWED_ORIGINS: allowedOrigins,
    SUPPORT_VOICE_XFF_MODE: 'best_effort',
    XAI_API_KEY: 'xai-test-key-not-a-real-secret',
  };
  const db = serviceDb(memberCount);
  const backing = createBacking();
  const sessionStore = createMemorySupportVoiceStore({ backing, pendingTtlMs, reserveFailureAfterCommit });
  const gateway = createSupportVoiceGateway({
    env,
    serviceDb: db,
    sessionStore,
    requireAuth(req, res, next) {
      authCalls += 1;
      const token = String(req.headers.authorization || '');
      if (!token.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
      req.user = { id: token.slice(7), email: 'must-not-propagate@example.test' };
      req.userToken = token.slice(7);
      req.isGlobalAdmin = globalAdmin;
      next();
    },
    async rateLimit(input) {
      rateCalls.push(input);
      return rateLimitImpl ? rateLimitImpl(input) : { allowed: true, count: 1, remaining: 4, retryAfterSeconds: 0 };
    },
    rateTimeoutMs,
    providerCanary,
  });
  app.use('/api/support/voice', gateway.router);
  const server = http.createServer(app);
  gateway.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/support/voice`;
  return {
    base,
    db,
    backing,
    gateway,
    rateCalls,
    sessionStore,
    get authCalls() { return authCalls; },
    close: () => new Promise((resolve) => { gateway.finalizeAll(); server.close(resolve); }),
  };
}

function headers(user = 'user-one', origin = ORIGIN) {
  return { Origin: origin, Authorization: `Bearer ${user}` };
}

test('create is bodyless, authenticated, membership-gated, no-store, and returns only opaque credentials', async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['credential', 'expires_at', 'session_id']);
    assert.match(body.session_id, /^[A-Za-z0-9_-]{22}$/);
    assert.match(body.credential, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(body.credential.slice(0, 22), body.session_id);
    assert.equal(h.db.calls.length, 2);
    assert.deepEqual(h.rateCalls.map((call) => call.routeName), ['support_voice_session_create:user']);
    assert.equal(JSON.stringify(body).includes('user-one'), false);
  } finally {
    await h.close();
  }
});

test('ambiguous reserve failure closes a late durable row and never returns its credential', async () => {
  const h = await harness({ reserveFailureAfterCommit: true });
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
    assert.equal(response.status, 503);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.backing.sessions.size, 1);
    assert.equal([...h.backing.sessions.values()][0].phase, 'closed');
    assert.equal([...h.backing.sessions.values()][0].reason, 'response_failed');
  } finally {
    await h.close();
  }
});

test('missing or wrong Origin rejects before authentication, membership, rate limit, or reservation', async () => {
  const h = await harness();
  try {
    for (const origin of [undefined, 'https://app.alphasourceai.com']) {
      const requestHeaders = { Authorization: 'Bearer user-one' };
      if (origin) requestHeaders.Origin = origin;
      const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: requestHeaders });
      assert.equal(response.status, 403);
    }
    assert.equal(h.authCalls, 0);
    assert.equal(h.db.calls.length, 0);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.backing.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('an explicit bounded origin list authorizes both production dashboard hostnames and rejects lookalikes', async () => {
  const origins = ['https://www.alphasourceai.com', 'https://app.alphasourceai.com'];
  const h = await harness({ allowedOrigin: '', allowedOrigins: origins.join(',') });
  try {
    for (const origin of origins) {
      const response = await fetch(`${h.base}/health`, { headers: { Origin: origin } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
    for (const origin of ['https://alphasourceai.com.evil.example', 'https://www.alphasourceai.com:444']) {
      const response = await fetch(`${h.base}/health`, { headers: { Origin: origin } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  } finally {
    await h.close();
  }
});

test('nonempty body is rejected before auth and consumes no limiter bucket', async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 400);
    assert.equal(h.authCalls, 0);
    assert.equal(h.rateCalls.length, 0);
  } finally {
    await h.close();
  }
});

test('chunked request bodies are rejected before authentication or limiter work', async () => {
  const h = await harness();
  try {
    const target = new URL(`${h.base}/sessions`);
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { ...headers(), 'Transfer-Encoding': 'chunked' },
      }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
      request.write('{}');
      request.end();
    });
    assert.equal(status, 400);
    assert.equal(h.authCalls, 0);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.backing.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('unaffiliated authenticated user is denied and service count queries return no rows', async () => {
  const h = await harness({ memberCount: 0 });
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
    assert.equal(response.status, 403);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.backing.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('one pending session per user and bodyless abandon is uniform', async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 201);
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 409);
    const abandoned = await fetch(`${h.base}/sessions/pending`, { method: 'DELETE', headers: headers() });
    assert.equal(abandoned.status, 204);
    assert.equal(await abandoned.text(), '');
    assert.equal([...h.backing.sessions.values()].filter((row) => ['pending', 'active'].includes(row.phase)).length, 0);
    assert.equal((await fetch(`${h.base}/sessions/pending`, { method: 'DELETE', headers: headers() })).status, 204);
  } finally {
    await h.close();
  }
});

test('concurrent same-user creates reserve atomically and the process cap stops the twenty-first user', async () => {
  const h = await harness();
  try {
    const concurrent = await Promise.all([
      fetch(`${h.base}/sessions`, { method: 'POST', headers: headers('same-user') }),
      fetch(`${h.base}/sessions`, { method: 'POST', headers: headers('same-user') }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
    assert.equal([...h.backing.sessions.values()].filter((row) => ['pending', 'active'].includes(row.phase)).length, 1);
    for (let index = 1; index < 20; index += 1) {
      const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers(`user-${index}`) });
      assert.equal(response.status, 201);
    }
    assert.equal([...h.backing.sessions.values()].filter((row) => ['pending', 'active'].includes(row.phase)).length, 20);
    const overflow = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers('user-overflow') });
    assert.equal(overflow.status, 503);
    assert.equal([...h.backing.sessions.values()].filter((row) => ['pending', 'active'].includes(row.phase)).length, 20);
  } finally {
    await h.close();
  }
});

test('pending credentials expire and release the per-user slot', async () => {
  const h = await harness({ pendingTtlMs: 25 });
  try {
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 201);
    assert.equal([...h.backing.sessions.values()].filter((row) => ['pending', 'active'].includes(row.phase)).length, 1);
  } finally {
    await h.close();
  }
});

test('disabled feature fails closed before limiter or reservation', async () => {
  const h = await harness({ enabled: false });
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
    assert.equal(response.status, 503);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.backing.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('failed provider contract canary blocks reservation before microphone-backed session creation', async () => {
  const providerCanary = {
    ready: () => false,
    snapshot: () => ({
      provider_contract_ok: false,
      provider_last_attempt_at: '2026-08-27T12:00:00.000Z',
      provider_last_success_at: null,
      provider_last_failure_category: 'provider_attestation',
      provider_consecutive_failures: 2,
    }),
    start() {},
    stop() {},
  };
  const h = await harness({ providerCanary });
  try {
    const health = h.gateway.publicHealth();
    assert.equal(health.configured, true);
    assert.equal(health.available, false);
    assert.equal(health.provider_contract_ok, false);
    assert.equal(health.provider_last_failure_category, 'provider_attestation');
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
    assert.equal(response.status, 503);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.backing.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('limiter denial, timeout, exception, and malformed results fail closed without a credential', async () => {
  const cases = [
    async () => ({ allowed: false }),
    async () => { throw new Error('database'); },
    async () => null,
    () => new Promise(() => {}),
  ];
  for (const rateLimitImpl of cases) {
    const h = await harness({ rateLimitImpl, rateTimeoutMs: 15 });
    try {
      const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
      assert.ok([429, 503].includes(response.status));
      assert.equal([...h.backing.sessions.values()].filter((row) => ['pending', 'active'].includes(row.phase)).length, 0);
      assert.equal(JSON.stringify(await response.json()).includes('database'), false);
    } finally {
      await h.close();
    }
  }
});

test('global admin bypass is boolean-only and reserves the same minimal session schema', async () => {
  const member = await harness();
  const admin = await harness({ memberCount: 0, globalAdmin: true });
  try {
    assert.equal((await fetch(`${member.base}/sessions`, { method: 'POST', headers: headers('member') })).status, 201);
    assert.equal((await fetch(`${admin.base}/sessions`, { method: 'POST', headers: headers('admin') })).status, 201);
    const memberEntry = [...member.backing.sessions.values()][0];
    const adminEntry = [...admin.backing.sessions.values()][0];
    assert.deepEqual(Object.keys(memberEntry).sort(), Object.keys(adminEntry).sort());
    for (const entry of [memberEntry, adminEntry]) {
      const serialized = JSON.stringify(entry);
      assert.equal(serialized.includes('member'), false);
      assert.equal(serialized.includes('admin'), false);
      assert.equal(serialized.includes('client'), false);
      assert.equal(serialized.includes('email'), false);
    }
    assert.equal(admin.db.calls.length, 0);
  } finally {
    await member.close();
    await admin.close();
  }
});

test('XFF modes accept only the first normalized public address and follow the explicit fail-closed table', () => {
  const req = (value) => ({ headers: value === undefined ? {} : { 'x-forwarded-for': value } });
  assert.equal(safeIp(req('8.8.8.8, 10.0.0.1'), 'strict'), '8.8.8.8');
  assert.equal(safeIp(req('2606:4700:4700::1111'), 'strict'), '2606:4700:4700::1111');
  for (const value of [undefined, '', '999.1.1.1', '10.0.0.1', '127.0.0.1', '169.254.1.1', '192.168.1.1', '203.0.113.10', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
    assert.throws(() => safeIp(req(value), 'strict'), /SUPPORT_VOICE_IP_UNAVAILABLE/);
    assert.equal(safeIp(req(value), 'best_effort'), null);
  }
});

test('voice readiness requires exact XFF mode, provider key, knowledge, durable store, allowed origin, and production-safe local flag', () => {
  const base = {
    NODE_ENV: 'production',
    SUPPORT_VOICE_ENABLED: 'true',
    SUPPORT_VOICE_ALLOWED_ORIGIN: ORIGIN,
    SUPPORT_VOICE_XFF_MODE: 'best_effort',
    XAI_API_KEY: 'xai-test-key-not-a-real-secret',
  };
  assert.equal(isConfigurationReady(base, { ok: true }, true), true);
  assert.equal(isConfigurationReady({
    ...base,
    SUPPORT_VOICE_ALLOWED_ORIGIN: '',
    SUPPORT_VOICE_ALLOWED_ORIGINS: 'https://www.alphasourceai.com, https://app.alphasourceai.com',
  }, { ok: true }, true), true);
  for (const mode of [undefined, '', 'strict ', 'STRICT', 'garbage']) {
    assert.equal(isConfigurationReady({ ...base, SUPPORT_VOICE_XFF_MODE: mode }, { ok: true }, true), false);
  }
  assert.equal(isConfigurationReady({ ...base, SUPPORT_VOICE_ALLOW_LOCAL_DEV: 'true' }, { ok: true }, true), false);
  assert.equal(isConfigurationReady({ ...base, SUPPORT_VOICE_ALLOWED_ORIGIN: 'http://example.test' }, { ok: true }, true), false);
  assert.equal(isConfigurationReady({ ...base, SUPPORT_VOICE_ALLOWED_ORIGIN: '' }, { ok: true }, true), false);
  assert.equal(isConfigurationReady({ ...base, SUPPORT_VOICE_ALLOWED_ORIGINS: 'http://example.test' }, { ok: true }, true), false);
  assert.equal(isConfigurationReady({ ...base, XAI_API_KEY: '' }, { ok: true }, true), false);
  assert.equal(isConfigurationReady(base, { ok: false }, true), false);
  assert.equal(isConfigurationReady(base, { ok: true }, false), false);
});

test('positive preflight is exact and side-effect free', async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.base}/sessions`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST, DELETE, OPTIONS');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization');
    assert.equal(h.authCalls, 0);
    assert.equal(h.rateCalls.length, 0);
  } finally {
    await h.close();
  }
});

test('WebSocket server transport disables compression and enforces the exact browser payload cap', async () => {
  const h = await harness();
  try {
    assert.equal(h.gateway._state.wss.options.maxPayload, 48 * 1024);
    assert.equal(h.gateway._state.wss.options.perMessageDeflate, false);
  } finally {
    await h.close();
  }
});

test('durable session-store health fails closed and recovers only after a successful probe state', async () => {
  const h = await harness();
  try {
    assert.equal(h.gateway.publicHealth().session_store_ok, true);
    h.sessionStore._state.setHealthyForTest(false);
    assert.equal(h.gateway.publicHealth().session_store_ok, false);
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 503);
    h.sessionStore._state.setHealthyForTest(true);
    assert.equal(h.gateway.publicHealth().session_store_ok, true);
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 201);
  } finally {
    await h.close();
  }
});
