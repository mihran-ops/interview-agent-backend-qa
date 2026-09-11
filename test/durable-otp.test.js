'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ENV = {
  OTP_HMAC_SECRET_VERSION: '1',
  OTP_HMAC_SECRET_V1: Buffer.alloc(32, 7).toString('base64'),
};
process.env.OTP_HMAC_SECRET_VERSION = ENV.OTP_HMAC_SECRET_VERSION;
process.env.OTP_HMAC_SECRET_V1 = ENV.OTP_HMAC_SECRET_V1;
const ID = {
  challenge: '81000000-0000-4000-8000-000000000001',
  candidate: '81000000-0000-4000-8000-000000000002',
  client: '81000000-0000-4000-8000-000000000003',
  role: '81000000-0000-4000-8000-000000000004',
  submission: '81000000-0000-4000-8000-000000000005',
  interview: '81000000-0000-4000-8000-000000000006',
};

const otp = require('../src/services/otpChallenge');
const launch = require('../src/middleware/otpLaunchCapability');
const { OTP_DELIVERY_CHANNELS, createEmailOtpDelivery } = require('../src/services/otpDelivery');

function binding(overrides = {}) {
  return {
    candidate_id: ID.candidate,
    client_id: ID.client,
    role_id: ID.role,
    submission_id: ID.submission,
    interview_attempt_id: ID.interview,
    recovery_authorization_id: '',
    ...overrides,
  };
}

test('CSPRNG output is always a six-digit string', () => {
  for (let index = 0; index < 1000; index += 1) assert.match(otp.generateOtpCode(), /^\d{6}$/);
});

test('missing HMAC secret fails closed', () => {
  assert.throws(() => otp.getOtpSecret(1, {}), { code: 'OTP_CONFIGURATION_ERROR' });
});

test('short HMAC secret fails closed', () => {
  assert.throws(() => otp.getOtpSecret(1, { OTP_HMAC_SECRET_V1: 'short' }), { code: 'OTP_CONFIGURATION_ERROR' });
});

test('version mismatch fails closed', () => {
  assert.throws(() => otp.getOtpSecret(1, { ...ENV, OTP_HMAC_SECRET_VERSION: '2' }), { code: 'OTP_CONFIGURATION_ERROR' });
});

test('base64 HMAC secret decodes to 32 bytes', () => {
  assert.equal(otp.getOtpSecret(1, ENV).length, 32);
});

test('canonical binding requires candidate, client, and role UUIDs', () => {
  assert.throws(() => otp.canonicalBinding({}), { code: 'INVALID_OTP_BINDING' });
});

test('canonical binding normalizes UUID case without changing resource identity', () => {
  assert.equal(otp.canonicalBinding(binding({ candidate_id: ID.candidate.toUpperCase() })).candidate_id, ID.candidate);
});

test('binding fingerprint is deterministic', () => {
  assert.equal(otp.bindingFingerprint(binding()), otp.bindingFingerprint(binding()));
});

test('binding fingerprint changes with the submission', () => {
  assert.notEqual(otp.bindingFingerprint(binding()), otp.bindingFingerprint(binding({ submission_id: null })));
});

test('destination fingerprint is deterministic and does not reveal the email', () => {
  const fingerprint = otp.destinationFingerprint(' Candidate@Example.Test ', 1, ENV);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, otp.destinationFingerprint('candidate@example.test', 1, ENV));
  assert.doesNotMatch(fingerprint, /candidate|example/i);
});

test('SMS destination fingerprint requires canonical E.164 and is channel-separated', () => {
  const sms = otp.destinationFingerprint('+15551234567', 1, ENV, 'sms');
  assert.match(sms, /^[0-9a-f]{64}$/);
  assert.notEqual(sms, otp.destinationFingerprint('+15551234567', 1, ENV, 'email'));
  assert.throws(() => otp.destinationFingerprint('(555) 123-4567', 1, ENV, 'sms'), {
    code: 'INVALID_OTP_DESTINATION',
  });
});

test('verifier is deterministic for the same challenge and binding', () => {
  const args = { challengeId: ID.challenge, code: '012345', binding: binding(), env: ENV };
  assert.equal(otp.verifierHmac(args), otp.verifierHmac(args));
});

test('verifier changes when the OTP changes', () => {
  const common = { challengeId: ID.challenge, binding: binding(), env: ENV };
  assert.notEqual(otp.verifierHmac({ ...common, code: '012345' }), otp.verifierHmac({ ...common, code: '012346' }));
});

test('verifier changes when the challenge ID changes', () => {
  const common = { code: '012345', binding: binding(), env: ENV };
  assert.notEqual(otp.verifierHmac({ ...common, challengeId: ID.challenge }), otp.verifierHmac({ ...common, challengeId: cryptoRandomUuid() }));
});

test('verifier changes when a bound resource changes', () => {
  const common = { challengeId: ID.challenge, code: '012345', env: ENV };
  assert.notEqual(otp.verifierHmac({ ...common, binding: binding() }), otp.verifierHmac({ ...common, binding: binding({ interview_attempt_id: null }) }));
});

test('channel remains HMAC-bound for verifier and binding fingerprints', () => {
  const common = { challengeId: ID.challenge, code: '012345', binding: binding(), env: ENV };
  assert.notEqual(
    otp.verifierHmac({ ...common, channel: 'email' }),
    otp.verifierHmac({ ...common, channel: 'sms' }),
  );
  assert.notEqual(otp.bindingFingerprint(binding(), 'email'), otp.bindingFingerprint(binding(), 'sms'));
});

test('verifier rejects non-six-digit input', () => {
  assert.throws(() => otp.verifierHmac({ challengeId: ID.challenge, code: '12345', binding: binding(), env: ENV }), { code: 'INVALID_OTP_CODE' });
});

test('timing-safe hex equality accepts equal digests and rejects unequal digests', () => {
  assert.equal(otp.timingSafeHexEqual('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(otp.timingSafeHexEqual('a'.repeat(64), 'b'.repeat(64)), false);
});

test('issue RPC receives only HMAC/fingerprints and never plaintext code or email', async () => {
  let call;
  const db = { rpc: async (name, args) => {
    call = { name, args };
    return { data: [{ challenge_id: args.p_challenge_id, expires_at: new Date().toISOString() }], error: null };
  } };
  const result = await otp.issueOtpChallenge(db, {
    email: 'candidate@example.test', candidateId: ID.candidate, clientId: ID.client,
    roleId: ID.role, submissionId: ID.submission, env: ENV,
  });
  assert.equal(call.name, 'service_issue_otp_challenge');
  assert.match(call.args.p_verifier_hmac_hex, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(call.args).includes(result.code), false);
  assert.equal(JSON.stringify(call.args).includes('candidate@example.test'), false);
});

test('synthetic SMS issuance uses the consent-bound service boundary without exposing phone or code', async () => {
  let call;
  const db = { rpc: async (name, args) => {
    call = { name, args };
    return { data: [{ challenge_id: args.p_challenge_id, expires_at: new Date().toISOString() }], error: null };
  } };
  const result = await otp.issueOtpChallenge(db, {
    channel: 'sms', phoneE164: '+15551234567', candidateId: ID.candidate,
    clientId: ID.client, roleId: ID.role, submissionId: ID.submission,
    smsSelectionAt: '2026-08-12T00:00:00.000Z', consentCopyVersion: 'sms-qa-v1', env: ENV,
  });
  assert.equal(call.name, 'service_issue_sms_otp_challenge');
  assert.equal(call.args.p_sms_selection_at, '2026-08-12T00:00:00.000Z');
  assert.equal(call.args.p_consent_copy_version, 'sms-qa-v1');
  assert.equal(JSON.stringify(call.args).includes(result.code), false);
  assert.equal(JSON.stringify(call.args).includes('+15551234567'), false);
});

test('synthetic SMS issuance fails before RPC without explicit consent evidence', async () => {
  let called = false;
  const db = { rpc: async () => { called = true; return { data: null, error: null }; } };
  await assert.rejects(otp.issueOtpChallenge(db, {
    channel: 'sms', phoneE164: '+15551234567', candidateId: ID.candidate,
    clientId: ID.client, roleId: ID.role, env: ENV,
  }), { code: 'SMS_CONSENT_EVIDENCE_REQUIRED' });
  assert.equal(called, false);
});

test('consume uses constant-time result and sends only a boolean to the atomic RPC', async () => {
  const expected = otp.verifierHmac({ challengeId: ID.challenge, code: '123456', binding: binding(), env: ENV });
  const calls = [];
  const db = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'service_get_otp_challenge_context') return { data: [{ challenge_id: ID.challenge, pepper_version: 1, verifier_hmac_hex: expected, ...binding() }], error: null };
    return { data: [{ status: 'verified', challenge_id: ID.challenge, ...binding() }], error: null };
  } };
  assert.equal((await otp.consumeOtpChallenge(db, { challengeId: ID.challenge, code: '123456', env: ENV })).status, 'verified');
  assert.deepEqual(calls[1].args, { p_challenge_id: ID.challenge, p_verifier_matches: true });
});

test('incorrect OTP sends a false verifier decision to the atomic RPC', async () => {
  const expected = otp.verifierHmac({ challengeId: ID.challenge, code: '123456', binding: binding(), env: ENV });
  let consumed;
  const db = { rpc: async (name, args) => {
    if (name === 'service_get_otp_challenge_context') return { data: [{ challenge_id: ID.challenge, pepper_version: 1, verifier_hmac_hex: expected, ...binding() }], error: null };
    consumed = args;
    return { data: [{ status: 'invalid' }], error: null };
  } };
  assert.equal((await otp.consumeOtpChallenge(db, { challengeId: ID.challenge, code: '999999', env: ENV })).status, 'invalid');
  assert.equal(consumed.p_verifier_matches, false);
});

test('launch capability is scoped and round-trips through a signed opaque cookie value', () => {
  const token = launch.createOtpLaunchCapability({ challenge_id: ID.challenge, ...binding() }, { now: 100_000, env: ENV });
  const payload = launch.verifyOtpLaunchCapability(token, { now: 100_001, env: ENV });
  assert.equal(payload.purpose, 'interview_launch');
  assert.equal(payload.candidate_id, ID.candidate);
  assert.doesNotMatch(token, /candidate|interview_launch/);
});

test('launch capability rejects signature tampering', () => {
  const token = launch.createOtpLaunchCapability({ challenge_id: ID.challenge, ...binding() }, { now: 100_000, env: ENV });
  assert.equal(launch.verifyOtpLaunchCapability(`${token}x`, { now: 100_001, env: ENV }), null);
});

test('launch capability rejects expiry', () => {
  const token = launch.createOtpLaunchCapability({ challenge_id: ID.challenge, ...binding() }, { now: 100_000, env: ENV });
  assert.equal(launch.verifyOtpLaunchCapability(token, { now: 500_000, env: ENV }), null);
});

test('launch cookie satisfies the browser-enforced __Host- contract', () => {
  const headers = [];
  const token = launch.setOtpLaunchCapability({ append: (_name, value) => headers.push(value) }, { challenge_id: ID.challenge, ...binding() }, { now: 100_000, env: ENV });
  assert.equal(launch.verifyOtpLaunchCapability(token, { now: 100_001, env: ENV }).candidate_id, ID.candidate);
  assert.match(headers[0], /^__Host-alphascreen_otp_launch=/);
  assert.match(headers[0], /HttpOnly/);
  assert.match(headers[0], /Secure/);
  assert.match(headers[0], /SameSite=Lax/);
  assert.match(headers[0], /Path=\/(?:;|$)/);
  assert.doesNotMatch(headers[0], /Domain=/);
});

test('launch middleware rejects a missing cookie before provider work', () => {
  let status;
  const req = { headers: {}, body: { candidate_id: ID.candidate, role_id: ID.role } };
  const res = { append() {}, status(value) { status = value; return this; }, json(value) { return value; } };
  launch.requireOtpLaunchCapability(req, res, () => assert.fail('next must not run'));
  assert.equal(status, 401);
});

test('launch middleware accepts the dedicated header without a cookie', () => {
  const origin = 'https://candidate.example.test';
  const token = launch.createOtpLaunchCapability({ challenge_id: ID.challenge, ...binding(), request_origin: origin }, { env: ENV });
  const req = {
    headers: { [launch.HEADER_NAME]: token, origin },
    body: { candidate_id: ID.candidate, role_id: ID.role },
  };
  const res = { append() {}, status() { return this; }, json(value) { return value; } };
  let nextCalled = false;
  launch.requireOtpLaunchCapability(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.otp_launch_capability.client_id, ID.client);
});

test('launch middleware rejects a dedicated header from a different browser origin', () => {
  const token = launch.createOtpLaunchCapability({
    challenge_id: ID.challenge,
    ...binding(),
    request_origin: 'https://candidate.example.test',
  }, { env: ENV });
  const req = {
    headers: { [launch.HEADER_NAME]: token, origin: 'https://attacker.example.test' },
    body: { candidate_id: ID.candidate, role_id: ID.role },
  };
  const res = { append() {}, status(value) { this.statusCode = value; return this; }, json(value) { return value; } };
  launch.requireOtpLaunchCapability(req, res, () => assert.fail('next must not run'));
  assert.equal(res.statusCode, 401);
});

test('a malformed dedicated header does not fall back to a valid cookie', () => {
  const token = launch.createOtpLaunchCapability({ challenge_id: ID.challenge, ...binding() }, { env: ENV });
  const req = {
    headers: {
      [launch.HEADER_NAME]: `${token},${token}`,
      cookie: `${launch.COOKIE_NAME}=${encodeURIComponent(token)}`,
    },
    body: { candidate_id: ID.candidate, role_id: ID.role },
  };
  const res = { append() {}, status(value) { this.statusCode = value; return this; }, json(value) { return value; } };
  launch.requireOtpLaunchCapability(req, res, () => assert.fail('next must not run'));
  assert.equal(res.statusCode, 401);
});

test('conflicting valid header and cookie capabilities are rejected', () => {
  const headerToken = launch.createOtpLaunchCapability({ challenge_id: ID.challenge, ...binding() }, { env: ENV });
  const cookieToken = launch.createOtpLaunchCapability({ challenge_id: cryptoRandomUuid(), ...binding() }, { env: ENV });
  const req = {
    headers: {
      [launch.HEADER_NAME]: headerToken,
      cookie: `${launch.COOKIE_NAME}=${encodeURIComponent(cookieToken)}`,
    },
    body: { candidate_id: ID.candidate, role_id: ID.role },
  };
  const res = { append() {}, status(value) { this.statusCode = value; return this; }, json(value) { return value; } };
  launch.requireOtpLaunchCapability(req, res, () => assert.fail('next must not run'));
  assert.equal(res.statusCode, 401);
});

test('oversized and expired header capabilities are rejected', () => {
  const expired = launch.createOtpLaunchCapability(
    { challenge_id: ID.challenge, ...binding() },
    { now: Date.now() - ((launch.TTL_SECONDS + 1) * 1000), env: ENV },
  );
  for (const token of ['x'.repeat(4097), expired]) {
    const req = {
      headers: { [launch.HEADER_NAME]: token },
      body: { candidate_id: ID.candidate, role_id: ID.role },
    };
    const res = { append() {}, status(value) { this.statusCode = value; return this; }, json(value) { return value; } };
    launch.requireOtpLaunchCapability(req, res, () => assert.fail('next must not run'));
    assert.equal(res.statusCode, 401);
  }
});

test('launch middleware rejects a cross-candidate body binding', () => {
  const token = launch.createOtpLaunchCapability({ challenge_id: ID.challenge, ...binding() }, { env: ENV });
  const req = { headers: { cookie: `${launch.COOKIE_NAME}=${encodeURIComponent(token)}` }, body: { candidate_id: cryptoRandomUuid(), role_id: ID.role } };
  const res = { append() {}, status() { return this; }, json(value) { return value; } };
  launch.requireOtpLaunchCapability(req, res, () => assert.fail('next must not run'));
  assert.equal(req.otp_launch_capability, undefined);
});

test('email delivery marks sent without persisting the code in delivery-state RPC arguments', async () => {
  let message;
  const calls = [];
  const deliver = createEmailOtpDelivery({ env: { ...ENV, SENDGRID_API_KEY: 'test', SENDGRID_FROM: 'qa@example.test' }, send: async (value) => { message = value; } });
  const db = { rpc: async (name, args) => { calls.push({ name, args }); return { data: true, error: null }; } };
  await deliver({ db, challengeId: ID.challenge, destination: 'candidate@example.test', code: '123456' });
  assert.match(message.text, /123456/);
  assert.equal(JSON.stringify(calls).includes('123456'), false);
  assert.equal(calls[0].args.p_delivery_state, 'sent');
});

test('delivery abstraction keeps SMS explicitly disabled', () => {
  assert.deepEqual(OTP_DELIVERY_CHANNELS, { email: 'enabled', sms: 'planned_not_enabled' });
});

function cryptoRandomUuid() {
  return require('node:crypto').randomUUID();
}
