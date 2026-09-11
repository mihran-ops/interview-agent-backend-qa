const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_HEALTH_FRESHNESS_MS,
  createSupportVoiceSessionStore,
} = require('../src/services/supportVoiceSessionStore');

const SESSION_ID = 'A'.repeat(22);
const DIGEST = 'b'.repeat(64);
const USER = 'c'.repeat(64);

test('store uses only the five service-role RPC contracts with bounded arguments', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'service_support_voice_session_health') return { data: true, error: null };
      if (name === 'service_reserve_support_voice_session') return { data: [{ status: 'created', session_id: SESSION_ID, expires_at: new Date(Date.now() + 60_000).toISOString() }], error: null };
      if (name === 'service_consume_support_voice_session') return { data: [{ status: 'consumed', session_id: SESSION_ID, user_fingerprint: USER, expires_at: new Date(Date.now() + 600_000).toISOString() }], error: null };
      if (name === 'service_close_support_voice_session') return { data: [{ status: 'closed', session_id: SESSION_ID, expires_at: new Date(Date.now() + 600_000).toISOString() }], error: null };
      if (name === 'service_close_pending_support_voice_sessions') return { data: 1, error: null };
      throw new Error('unexpected RPC');
    },
  };
  const store = createSupportVoiceSessionStore({ serviceDb: db });
  assert.equal(await store.probe(), true);
  assert.equal((await store.reserve({ sessionId: SESSION_ID, credentialDigest: DIGEST, userFingerprint: USER })).status, 'created');
  assert.equal((await store.consume({ credentialDigest: DIGEST })).status, 'consumed');
  assert.equal((await store.close({ sessionId: SESSION_ID, reason: 'ended' })).status, 'closed');
  assert.equal(await store.closePending({ userFingerprint: USER }), 1);
  assert.deepEqual(calls.map((call) => call.name), [
    'service_support_voice_session_health',
    'service_reserve_support_voice_session',
    'service_consume_support_voice_session',
    'service_close_support_voice_session',
    'service_close_pending_support_voice_sessions',
  ]);
  assert.deepEqual(calls[1].args, {
    p_session_id: SESSION_ID,
    p_credential_digest_hex: DIGEST,
    p_user_fingerprint: USER,
  });
});

test('readiness becomes stale after five seconds and only a successful probe restores it', async () => {
  let now = 1000;
  let succeed = true;
  const store = createSupportVoiceSessionStore({
    serviceDb: { rpc: async () => succeed ? { data: true, error: null } : { data: null, error: { code: 'down' } } },
    now: () => now,
  });
  assert.equal(store.isHealthy(), false);
  assert.equal(await store.probe(), true);
  assert.equal(store.isHealthy(), true);
  now += DEFAULT_HEALTH_FRESHNESS_MS + 1;
  assert.equal(store.isHealthy(), false);
  succeed = false;
  assert.equal(await store.probe(), false);
  assert.equal(store.isHealthy(), false);
  succeed = true;
  assert.equal(await store.probe(), true);
  assert.equal(store.isHealthy(), true);
});

test('reserve and consume failures immediately mark readiness unhealthy', async () => {
  const store = createSupportVoiceSessionStore({
    serviceDb: { rpc: async () => { throw new Error('database'); } },
    initialHealthy: true,
  });
  await assert.rejects(store.reserve({ sessionId: SESSION_ID, credentialDigest: DIGEST, userFingerprint: USER }));
  assert.equal(store.isHealthy(), false);
});

test('RPC deadline is finite and does not leak the underlying failure', async () => {
  const store = createSupportVoiceSessionStore({
    serviceDb: { rpc: () => new Promise(() => {}) },
    rpcTimeoutMs: 15,
    initialHealthy: true,
  });
  const started = Date.now();
  await assert.rejects(store.consume({ credentialDigest: DIGEST }), /SUPPORT_VOICE_SESSION_STORE_TIMEOUT/);
  assert.ok(Date.now() - started < 250);
  assert.equal(store.isHealthy(), false);
});

test('malformed RPC success payloads fail closed', async () => {
  const store = createSupportVoiceSessionStore({
    serviceDb: { rpc: async () => ({ data: [{ status: 'consumed', session_id: 'bad', user_fingerprint: USER, expires_at: 'bad' }], error: null }) },
    initialHealthy: true,
  });
  await assert.rejects(store.consume({ credentialDigest: DIGEST }), /SUPPORT_VOICE_SESSION_STORE_CONSUME/);
  assert.equal(store.isHealthy(), false);
});
