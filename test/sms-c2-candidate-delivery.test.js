'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createFakeSmsProvider } = require('../src/services/smsFakeProvider');
const {
  SMS_CONSENT_COPY_VERSION,
  deliverCandidateSmsOtp,
  normalizeConsentCopyVersion,
  readCandidateSmsConfiguration,
} = require('../src/services/candidateSmsDelivery');

const CHALLENGE_ID = '84000000-0000-4000-8000-000000000001';
const EXPIRES_AT = '2026-08-16T18:10:00.000Z';
const NOW = new Date('2026-08-16T18:00:00.000Z');
const CANDIDATE = Object.freeze({
  id: '84000000-0000-4000-8000-000000000002',
  phone_e164: '+15555550184',
  phone_country_code: 'US',
});
const BINDING = Object.freeze({
  clientId: '84000000-0000-4000-8000-000000000003',
  roleId: '84000000-0000-4000-8000-000000000004',
  submissionId: '84000000-0000-4000-8000-000000000005',
});

function env(overrides = {}) {
  return {
    NODE_ENV: 'test',
    SMS_CANDIDATE_UI_ENABLED: 'true',
    SMS_ENABLED: 'true',
    SMS_ENVIRONMENT: 'local',
    SMS_PROVIDER: 'fake',
    SMS_CONSENT_COPY_VERSION,
    OTP_HMAC_SECRET_VERSION: '1',
    OTP_HMAC_SECRET_V1: Buffer.alloc(32, 41).toString('base64'),
    ...overrides,
  };
}

function harness({ mode = 'accepted', candidate = CANDIDATE, suppressed = false } = {}) {
  const records = [];
  const issues = [];
  const adapter = createFakeSmsProvider({ mode, environment: 'local', now: () => NOW });
  return {
    adapter,
    issues,
    records,
    options: {
      db: {},
      candidate,
      ...BINDING,
      consentCopyVersion: SMS_CONSENT_COPY_VERSION,
      env: env(),
      now: () => NOW,
      adapter,
      checkSuppressed: async () => suppressed,
      issueChallenge: async (_db, input) => {
        issues.push(input);
        return {
          challengeId: CHALLENGE_ID,
          code: '123456',
          expiresAt: EXPIRES_AT,
          channel: 'sms',
        };
      },
      recordMetadata: async (_db, value) => {
        records.push(value);
        return value;
      },
    },
  };
}

test('candidate SMS delivery is disabled unless every independent gate is enabled', () => {
  assert.equal(readCandidateSmsConfiguration(env()).valid, true);
  for (const overrides of [
    { SMS_CANDIDATE_UI_ENABLED: 'false' },
    { SMS_ENABLED: 'false' },
    { SMS_ENVIRONMENT: 'production' },
    { SMS_PROVIDER: 'telnyx' },
    { SMS_CONSENT_COPY_VERSION: 'other-copy' },
    { NODE_ENV: 'production' },
  ]) assert.equal(readCandidateSmsConfiguration(env(overrides)).valid, false);
  assert.equal(normalizeConsentCopyVersion(SMS_CONSENT_COPY_VERSION), SMS_CONSENT_COPY_VERSION);
  assert.equal(normalizeConsentCopyVersion('other-copy'), null);
});

test('QA and production Telnyx delivery require lookup, spend, abuse, and provider configuration', () => {
  const production = env({
    NODE_ENV: 'production',
    SMS_ENVIRONMENT: 'production',
    SMS_PROVIDER: 'telnyx',
    SMS_LOOKUP_ENABLED: 'true',
    SMS_LOOKUP_PROVIDER: 'telnyx',
    SMS_DAILY_SPEND_CAP_CENTS: '100',
    SMS_MESSAGE_RESERVE_CENTS: '2',
    SMS_ABUSE_HMAC_SECRET: Buffer.alloc(32, 42).toString('base64'),
    TELNYX_API_KEY: 'test-only-api-key',
    TELNYX_MESSAGING_PROFILE_ID: 'test-profile',
    TELNYX_SENDER_E164: '+15555550199',
  });
  assert.equal(readCandidateSmsConfiguration(production).valid, true);
  assert.equal(readCandidateSmsConfiguration({ ...production, SMS_ENVIRONMENT: 'qa' }).valid, true);
  for (const key of [
    'SMS_LOOKUP_ENABLED',
    'SMS_DAILY_SPEND_CAP_CENTS',
    'SMS_MESSAGE_RESERVE_CENTS',
    'SMS_ABUSE_HMAC_SECRET',
  ]) {
    assert.equal(readCandidateSmsConfiguration({ ...production, [key]: '' }).valid, false, key);
  }
});

test('accepted fake delivery commits consent-bound challenge before one adapter call', async () => {
  const current = harness();
  const result = await deliverCandidateSmsOtp(current.options);
  assert.deepEqual(result, {
    outcome: 'accepted',
    challengeCreated: true,
    challengeId: CHALLENGE_ID,
    emailFallbackAvailable: false,
  });
  assert.equal(current.adapter.getCallCount(), 1);
  assert.equal(current.issues.length, 1);
  assert.equal(current.issues[0].channel, 'sms');
  assert.equal(current.issues[0].smsSelectionAt, NOW.toISOString());
  assert.equal(current.issues[0].consentCopyVersion, SMS_CONSENT_COPY_VERSION);
  assert.deepEqual(current.records.map((record) => record.event), ['send_requested', 'provider_accepted']);
});

test('every non-accepted outcome offers email without retrying or leaking phone, OTP, or provider ID', async () => {
  for (const mode of [
    'rejected',
    'transient_preacceptance',
    'ambiguous_outcome',
    'invalid_destination',
    'blocked_destination',
    'timeout_before_dispatch',
    'timeout_after_dispatch',
  ]) {
    const current = harness({ mode });
    const result = await deliverCandidateSmsOtp(current.options);
    assert.equal(result.emailFallbackAvailable, true, mode);
    assert.equal(result.challengeCreated, true, mode);
    assert.equal(current.adapter.getCallCount(), 1, mode);
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes(CANDIDATE.phone_e164), false, mode);
    assert.equal(encoded.includes('123456'), false, mode);
    assert.equal(encoded.includes('fake_'), false, mode);
  }
});

test('suppression and non-US destinations fail before challenge creation and provider invocation', async () => {
  const suppressed = harness({ suppressed: true });
  const suppressedResult = await deliverCandidateSmsOtp(suppressed.options);
  assert.equal(suppressedResult.outcome, 'blocked_destination');
  assert.equal(suppressedResult.challengeCreated, false);
  assert.equal(suppressed.adapter.getCallCount(), 0);
  assert.equal(suppressed.issues.length, 0);

  const philippines = harness({
    candidate: { ...CANDIDATE, phone_e164: '+639171234567', phone_country_code: 'PH' },
  });
  const philippinesResult = await deliverCandidateSmsOtp(philippines.options);
  assert.equal(philippinesResult.outcome, 'invalid_destination');
  assert.equal(philippinesResult.challengeCreated, false);
  assert.equal(philippines.adapter.getCallCount(), 0);
  assert.equal(philippines.issues.length, 0);
});

test('missing consent or disabled configuration creates no challenge and calls no adapter', async () => {
  for (const options of [
    { consentCopyVersion: '' },
    { env: env({ SMS_ENABLED: 'false' }) },
  ]) {
    const current = harness();
    const result = await deliverCandidateSmsOtp({ ...current.options, ...options });
    assert.equal(result.outcome, 'misconfigured');
    assert.equal(result.challengeCreated, false);
    assert.equal(result.emailFallbackAvailable, true);
    assert.equal(current.adapter.getCallCount(), 0);
    assert.equal(current.issues.length, 0);
  }
});
