'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { after, before, test } = require('node:test');

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SENDGRID_API_KEY = 'SG.synthetic';
process.env.SENDGRID_FROM = 'qa@example.test';
process.env.OTP_HMAC_SECRET_VERSION = '1';
process.env.OTP_HMAC_SECRET_V1 = Buffer.alloc(32, 31).toString('base64');

const otp = require('../src/services/otpChallenge');

const ID = {
  challenge: '83000000-0000-4000-8000-000000000001',
  candidate: '83000000-0000-4000-8000-000000000002',
  client: '83000000-0000-4000-8000-000000000003',
  role: '83000000-0000-4000-8000-000000000004',
  submission: '83000000-0000-4000-8000-000000000005',
};

const binding = {
  candidate_id: ID.candidate,
  client_id: ID.client,
  role_id: ID.role,
  submission_id: ID.submission,
  interview_attempt_id: null,
  recovery_authorization_id: null,
};

class FakeQuery {
  constructor(db, table) { this.db = db; this.table = table; this.filters = []; }
  select() { return this; }
  eq(field, value) { this.filters.push([field, String(value)]); return this; }
  async maybeSingle() {
    const row = this.table === 'candidates' ? this.db.candidate
      : this.table === 'roles' ? this.db.role
        : this.table === 'clients' ? this.db.client : null;
    if (!row || this.filters.some(([field, value]) => String(row[field] || '') !== value)) return { data: null, error: null };
    return { data: row, error: null };
  }
}

function install(filename, exports) {
  const resolved = require.resolve(filename);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function buildDb() {
  const initialVerifier = otp.verifierHmac({ challengeId: ID.challenge, code: '123456', binding });
  const challenges = new Map([[ID.challenge, {
    challenge_id: ID.challenge,
    purpose: 'interview_access',
    channel: 'email',
    pepper_version: 1,
    verifier_hmac_hex: initialVerifier,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null,
    superseded_at: null,
    attempt_count: 0,
    max_attempts: 5,
    ...binding,
  }]]);
  return {
    candidate: { id: ID.candidate, role_id: ID.role, client_id: ID.client, email: 'candidate@example.test' },
    role: { id: ID.role, client_id: ID.client, status: 'active' },
    client: { id: ID.client, billing_status: 'active', access_override_mode: 'force_active' },
    challenges,
    rpcCalls: [],
    delivery: [],
    from(table) { return new FakeQuery(this, table); },
    async rpc(name, args) {
      this.rpcCalls.push({ name, args });
      if (name === 'service_get_otp_challenge_context') return { data: this.challenges.get(args.p_challenge_id) || null, error: null };
      if (name === 'service_consume_otp_challenge') {
        const row = this.challenges.get(args.p_challenge_id);
        if (!row) return { data: [{ status: 'not_found' }], error: null };
        if (row.consumed_at) return { data: [{ status: 'consumed', ...binding, challenge_id: row.challenge_id }], error: null };
        if (row.superseded_at) return { data: [{ status: 'superseded', ...binding, challenge_id: row.challenge_id }], error: null };
        if (!args.p_verifier_matches) {
          row.attempt_count += 1;
          return { data: [{ status: 'invalid', ...binding, challenge_id: row.challenge_id }], error: null };
        }
        row.consumed_at = new Date().toISOString();
        return { data: [{ status: 'verified', ...binding, challenge_id: row.challenge_id }], error: null };
      }
      if (name === 'service_claim_consumed_otp_recovery') {
        const row = this.challenges.get(args.p_challenge_id);
        const now = Date.now();
        const consumedAt = Date.parse(String(row?.consumed_at || ''));
        const recentResourceClaim = [...this.challenges.values()].some((candidate) => (
          candidate !== row
          && candidate.candidate_id === row?.candidate_id
          && candidate.client_id === row?.client_id
          && candidate.role_id === row?.role_id
          && Number.isFinite(Date.parse(String(candidate.recovery_reissued_at || '')))
          && now - Date.parse(candidate.recovery_reissued_at) < 60_000
        ));
        if (!row || row.superseded_at || row.recovery_reissued_at
          || !Number.isFinite(consumedAt) || now - consumedAt > 30 * 60 * 1000
          || recentResourceClaim || this.challenges.has(args.p_replacement_challenge_id)) {
          return { data: [{ status: 'not_claimed' }], error: null };
        }
        row.recovery_reissued_at = new Date(now).toISOString();
        row.recovery_replacement_challenge_id = args.p_replacement_challenge_id;
        return { data: [{ status: 'claimed' }], error: null };
      }
      if (name === 'service_issue_otp_challenge') {
        for (const row of this.challenges.values()) if (!row.consumed_at && !row.superseded_at) row.superseded_at = new Date().toISOString();
        this.challenges.set(args.p_challenge_id, {
          challenge_id: args.p_challenge_id,
          purpose: 'interview_access',
          channel: 'email',
          pepper_version: args.p_pepper_version,
          verifier_hmac_hex: args.p_verifier_hmac_hex,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          consumed_at: null,
          superseded_at: null,
          attempt_count: 0,
          max_attempts: 5,
          candidate_id: args.p_candidate_id,
          client_id: args.p_client_id,
          role_id: args.p_role_id,
          submission_id: args.p_submission_id,
          interview_attempt_id: args.p_interview_attempt_id,
          recovery_authorization_id: args.p_recovery_authorization_id,
        });
        return { data: [{ challenge_id: args.p_challenge_id, expires_at: new Date(Date.now() + 600_000).toISOString() }], error: null };
      }
      if (name === 'service_mark_otp_challenge_delivery') {
        this.delivery.push(args);
        return { data: true, error: null };
      }
      return { data: null, error: { message: `unexpected_rpc:${name}` } };
    },
  };
}

let server;
let base;
let db;
let sentCodes;

before(async () => {
  db = buildDb();
  sentCodes = [];
  install('../src/clients/supabase', { supabase: db, supabaseAdmin: db });
  install('../src/services/roleInterviewAvailability', {
    getRoleInterviewAvailability: async () => ({ remaining_interviews: 3 }),
    syncRoleInterviewLimitNotification: async () => {},
  });
  install('../src/services/rateLimit', {
    getRequestSubjectKey: () => 'synthetic',
    checkAndIncrementRateLimit: async () => ({ allowed: true }),
  });
  const sg = require('@sendgrid/mail');
  sg.setApiKey = () => {};
  sg.send = async (message) => {
    const match = String(message.text || '').match(/\b(\d{6})\b/);
    if (match) sentCodes.push(match[1]);
    return [{ statusCode: 202 }];
  };
  delete require.cache[require.resolve('../src/routes/public/verifyOtp')];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.request_id = 'otp-route-test'; next(); });
  app.use('/api/candidate/verify-otp', require('../src/routes/public/verifyOtp'));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/candidate/verify-otp`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    cacheControl: response.headers.get('cache-control') || '',
    cookie: response.headers.get('set-cookie') || '',
  };
}

test('verification requires an opaque challenge ID and six-digit code', async () => {
  assert.equal((await post('', { code: '123456' })).status, 400);
  assert.equal((await post('', { challenge_id: ID.challenge, code: '12345' })).status, 400);
});

test('wrong challenge code fails generically and increments through the atomic consume boundary', async () => {
  const result = await post('', { challenge_id: ID.challenge, code: '999999' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'VERIFICATION_FAILED');
  assert.equal(db.challenges.get(ID.challenge).attempt_count, 1);
});

test('correct challenge code sets a short-lived Secure HttpOnly launch capability', async () => {
  const result = await post('', { challenge_id: ID.challenge, code: '123456' });
  assert.equal(result.status, 200);
  assert.equal(result.body.verified, true);
  assert.equal(typeof result.body.launch_capability, 'string');
  assert.equal(result.body.launch_capability_expires_in_seconds, 5 * 60);
  assert.equal(result.cacheControl, 'private, no-store');
  assert.match(result.cookie, /__Host-alphascreen_otp_launch=/);
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /Secure/);
  assert.doesNotMatch(result.cookie, /123456|candidate@example/i);
});

test('replay of a consumed challenge is rejected', async () => {
  const result = await post('', { challenge_id: ID.challenge, code: '123456' });
  assert.notEqual(result.status, 200);
  assert.equal(result.body.code, 'OTP_USED');
});

test('resend accepts only challenge ID, returns a replacement ID, and sends a fresh code', async () => {
  const seedId = '83000000-0000-4000-8000-000000000011';
  db.challenges.set(seedId, {
    ...db.challenges.get(ID.challenge), challenge_id: seedId, consumed_at: null, superseded_at: null,
  });
  const result = await post('/resend', { challenge_id: seedId });
  assert.equal(result.status, 200);
  assert.match(result.body.challenge_id, /^[0-9a-f-]{36}$/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentCodes.length, 1);
  assert.notEqual(result.body.challenge_id, seedId);
  assert.ok(db.challenges.get(seedId).superseded_at);
});

test('superseded resend code cannot verify while the fresh emailed code can', async () => {
  const active = [...db.challenges.values()].find((row) => !row.consumed_at && !row.superseded_at);
  assert.ok(active);
  const old = await post('', { challenge_id: '83000000-0000-4000-8000-000000000011', code: '123456' });
  assert.equal(old.body.code, 'STALE_ACCESS_INVALIDATED');
  const fresh = await post('', { challenge_id: active.challenge_id, code: sentCodes[0] });
  assert.equal(fresh.status, 200);
});

test('unknown resend remains enumeration-safe and creates no challenge', async () => {
  const before = db.challenges.size;
  const result = await post('/resend', { challenge_id: '83000000-0000-4000-8000-000000000099' });
  assert.equal(result.status, 200);
  assert.equal(result.body.challenge_id, undefined);
  assert.equal(db.challenges.size, before);
});

test('a recently consumed challenge can issue one fresh recovery code', async () => {
  const seedId = '83000000-0000-4000-8000-000000000077';
  db.challenges.set(seedId, {
    ...db.challenges.get(ID.challenge),
    challenge_id: seedId,
    consumed_at: new Date().toISOString(),
    superseded_at: null,
  });
  const sentBefore = sentCodes.length;
  const result = await post('/resend', { challenge_id: seedId, channel: 'email' });
  assert.equal(result.status, 200);
  assert.match(result.body.challenge_id, /^[0-9a-f-]{36}$/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentCodes.length, sentBefore + 1);
  const replay = await post('/resend', { challenge_id: seedId, channel: 'email' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.challenge_id, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentCodes.length, sentBefore + 1);
  assert.match(db.challenges.get(seedId).recovery_replacement_challenge_id, /^[0-9a-f-]{36}$/);
});

test('concurrent recovery requests atomically issue only one replacement code', async () => {
  for (const row of db.challenges.values()) {
    row.recovery_reissued_at = null;
    row.recovery_replacement_challenge_id = null;
  }
  const seedId = '83000000-0000-4000-8000-000000000079';
  db.challenges.set(seedId, {
    ...db.challenges.get(ID.challenge),
    challenge_id: seedId,
    consumed_at: new Date().toISOString(),
    superseded_at: null,
  });
  const sentBefore = sentCodes.length;
  const results = await Promise.all([
    post('/resend', { challenge_id: seedId, channel: 'email' }),
    post('/resend', { challenge_id: seedId, channel: 'email' }),
  ]);
  assert.equal(results.filter((result) => result.body.challenge_id).length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentCodes.length, sentBefore + 1);
});

test('resource cooldown prevents another consumed seed from invalidating the fresh recovery code', async () => {
  for (const row of db.challenges.values()) {
    row.recovery_reissued_at = null;
    row.recovery_replacement_challenge_id = null;
  }
  const firstSeed = '83000000-0000-4000-8000-000000000081';
  const secondSeed = '83000000-0000-4000-8000-000000000082';
  for (const seedId of [firstSeed, secondSeed]) {
    db.challenges.set(seedId, {
      ...db.challenges.get(ID.challenge),
      challenge_id: seedId,
      consumed_at: new Date().toISOString(),
      superseded_at: null,
    });
  }
  const sentBefore = sentCodes.length;
  const first = await post('/resend', { challenge_id: firstSeed, channel: 'email' });
  const second = await post('/resend', { challenge_id: secondSeed, channel: 'email' });
  assert.match(first.body.challenge_id, /^[0-9a-f-]{36}$/);
  assert.equal(second.body.challenge_id, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentCodes.length, sentBefore + 1);
});

test('an old consumed challenge stays enumeration-safe and cannot issue a code', async () => {
  const seedId = '83000000-0000-4000-8000-000000000078';
  db.challenges.set(seedId, {
    ...db.challenges.get(ID.challenge),
    challenge_id: seedId,
    consumed_at: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
    superseded_at: null,
  });
  const before = db.challenges.size;
  const sentBefore = sentCodes.length;
  const result = await post('/resend', { challenge_id: seedId, channel: 'email' });
  assert.equal(result.status, 200);
  assert.equal(result.body.challenge_id, undefined);
  assert.equal(db.challenges.size, before);
  assert.equal(sentCodes.length, sentBefore);
});

test('SMS resend remains fail-closed when candidate SMS flags are disabled', async () => {
  const seedId = '83000000-0000-4000-8000-000000000088';
  db.challenges.set(seedId, {
    ...db.challenges.get(ID.challenge), challenge_id: seedId, consumed_at: null, superseded_at: null,
  });
  const before = db.challenges.size;
  const sentBefore = sentCodes.length;
  const result = await post('/resend', {
    challenge_id: seedId,
    channel: 'sms',
    consent_copy_version: 'sms-consent-v2',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.challenge_id, undefined);
  assert.equal(result.body.delivery_channel, 'sms');
  assert.equal(result.body.delivery_outcome, 'misconfigured');
  assert.equal(result.body.email_fallback_available, true);
  assert.equal(db.challenges.size, before);
  assert.equal(sentCodes.length, sentBefore);
});
