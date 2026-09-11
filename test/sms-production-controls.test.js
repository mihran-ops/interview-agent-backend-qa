'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  DEFAULT_LIMITS,
  createProductionRateLimitGates,
  finalizeSmsSpend,
  keyedSubject,
  readSmsProductionControlConfig,
  releaseSmsSpend,
  reserveSmsSpend,
} = require('../src/services/smsProductionControls');
const {
  lookupSmsLineType,
  normalizeTelnyxLineType,
  readTelnyxLookupConfig,
} = require('../src/services/telnyxNumberLookup');

const SECRET = Buffer.alloc(32, 17);
const FINGERPRINT = 'c'.repeat(64);
const CANDIDATE_ID = '85000000-0000-4000-8000-000000000001';
const RESERVATION_ID = '85000000-0000-4000-8000-000000000002';

function productionEnv(overrides = {}) {
  return {
    SMS_ENVIRONMENT: 'production',
    SMS_PROVIDER: 'telnyx',
    SMS_LOOKUP_ENABLED: 'true',
    SMS_LOOKUP_PROVIDER: 'telnyx',
    SMS_DAILY_SPEND_CAP_CENTS: '100',
    SMS_MESSAGE_RESERVE_CENTS: '2',
    SMS_ABUSE_HMAC_SECRET: SECRET.toString('base64'),
    TELNYX_API_KEY: 'test-only-key',
    ...overrides,
  };
}

test('production control and lookup configuration fail closed', () => {
  assert.equal(readSmsProductionControlConfig(productionEnv()).valid, true);
  assert.equal(readTelnyxLookupConfig(productionEnv()).valid, true);
  assert.equal(readSmsProductionControlConfig(productionEnv({ SMS_ENVIRONMENT: 'qa' })).valid, true);
  for (const [key, value] of [
    ['SMS_ENVIRONMENT', 'staging'],
    ['SMS_PROVIDER', 'other'],
    ['SMS_DAILY_SPEND_CAP_CENTS', '0'],
    ['SMS_MESSAGE_RESERVE_CENTS', '101'],
    ['SMS_ABUSE_HMAC_SECRET', 'short'],
  ]) assert.equal(readSmsProductionControlConfig(productionEnv({ [key]: value })).valid, false, key);
  assert.equal(readTelnyxLookupConfig(productionEnv({ SMS_LOOKUP_ENABLED: 'false' })).valid, false);
  assert.equal(readTelnyxLookupConfig(productionEnv({ SMS_LOOKUP_CACHE_SECONDS: '2592000' })).valid, true);
  assert.equal(readTelnyxLookupConfig(productionEnv({ SMS_LOOKUP_CACHE_SECONDS: '2592001' })).valid, false);
});

test('abuse subjects are keyed, scoped, deterministic, and contain no raw IP or identifiers', async () => {
  const rawIp = '203.0.113.42';
  const rawCandidate = CANDIDATE_ID;
  const first = keyedSubject(SECRET, 'ip', rawIp);
  const same = keyedSubject(SECRET, 'ip', rawIp);
  const otherScope = keyedSubject(SECRET, 'candidate', rawIp);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, otherScope);
  assert.equal(first.includes(rawIp), false);

  const calls = [];
  const gates = createProductionRateLimitGates({
    config: readSmsProductionControlConfig(productionEnv()),
    candidateId: rawCandidate,
    clientId: 'client-fixture',
    roleId: 'role-fixture',
    destinationFingerprint: FINGERPRINT,
    requestIp: rawIp,
    provider: 'telnyx',
    country: 'US',
    rateLimiter: async (value) => { calls.push(value); return { allowed: true }; },
  });
  assert.equal(gates.length, 7);
  for (const gate of gates) assert.equal((await gate()).allowed, true);
  assert.deepEqual(calls.map((value) => value.routeName), [
    'sms_destination_cooldown', 'sms_resource_15m', 'sms_candidate_15m',
    'sms_destination_hour', 'sms_destination_day', 'sms_ip_hour', 'sms_provider_country_day',
  ]);
  assert.deepEqual(calls.map((value) => value.maxCount), [
    1, DEFAULT_LIMITS.resourceMax, DEFAULT_LIMITS.candidateMax,
    DEFAULT_LIMITS.destinationHourMax, DEFAULT_LIMITS.destinationDayMax,
    DEFAULT_LIMITS.ipHourMax, DEFAULT_LIMITS.providerCountryDayMax,
  ]);
  const encoded = JSON.stringify(calls);
  assert.equal(encoded.includes(rawIp), false);
  assert.equal(encoded.includes(rawCandidate), false);
});

test('spend reservation uses bounded service RPCs and releases only definite failures', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'service_reserve_sms_spend') return { data: [{ allowed: true, reserved_total_cents: 2 }], error: null };
      return { data: true, error: null };
    },
  };
  const config = readSmsProductionControlConfig(productionEnv());
  assert.deepEqual(await reserveSmsSpend(db, {
    reservationId: RESERVATION_ID,
    config,
    country: 'US',
    destinationFingerprint: FINGERPRINT,
    candidateId: CANDIDATE_ID,
    resourceFingerprint: 'd'.repeat(64),
  }), { allowed: true, reservationId: RESERVATION_ID });
  assert.equal(await releaseSmsSpend(db, RESERVATION_ID, 'provider_rejected'), true);
  assert.equal(await finalizeSmsSpend(db, RESERVATION_ID, 'accepted'), true);
  assert.deepEqual(calls.map((value) => value.name), [
    'service_reserve_sms_spend', 'service_release_sms_spend', 'service_finalize_sms_spend',
  ]);
  assert.equal(JSON.stringify(calls).includes('+1'), false);
  assert.deepEqual(await reserveSmsSpend({ rpc: async () => ({ data: null, error: new Error('down') }) }, {
    reservationId: RESERVATION_ID,
    config,
    country: 'US',
    destinationFingerprint: FINGERPRINT,
    candidateId: CANDIDATE_ID,
    resourceFingerprint: 'd'.repeat(64),
  }), { allowed: false });
});

test('Telnyx line type normalization allows only explicit mobile classification', () => {
  assert.equal(normalizeTelnyxLineType({ data: { portability: { line_type: 'mobile' } } }), 'mobile');
  assert.equal(normalizeTelnyxLineType({ data: { carrier: { type: 'wireless' } } }), 'mobile');
  assert.equal(normalizeTelnyxLineType({ data: { portability: { line_type: 'landline' } } }), 'landline');
  assert.equal(normalizeTelnyxLineType({ data: { portability: { line_type: 'voip' } } }), 'voip');
  assert.equal(normalizeTelnyxLineType({ data: {} }), 'unknown');
});

test('live line lookup caches fingerprint-only results and fails closed', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'service_get_sms_line_type_cache') return { data: [], error: null };
      return { data: null, error: null };
    },
  };
  const result = await lookupSmsLineType({
    db,
    toE164: '+15555550100',
    destinationFingerprint: FINGERPRINT,
    env: productionEnv(),
    transport: async () => ({
      statusCode: 200,
      body: JSON.stringify({ data: { portability: { line_type: 'mobile' } } }),
    }),
    now: () => new Date('2026-08-17T12:00:00.000Z'),
  });
  assert.deepEqual(result, { ok: true, lineType: 'mobile', cached: false });
  assert.deepEqual(calls.map((value) => value.name), [
    'service_get_sms_line_type_cache', 'service_put_sms_line_type_cache',
  ]);
  assert.equal(JSON.stringify(calls).includes('+15555550100'), false);

  const failed = await lookupSmsLineType({
    db,
    toE164: '+15555550100',
    destinationFingerprint: FINGERPRINT,
    env: productionEnv(),
    transport: async () => { throw new Error('provider detail'); },
  });
  assert.deepEqual(failed, { ok: false, lineType: 'unknown', cached: false });
});
