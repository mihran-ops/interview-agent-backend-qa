'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  getSmsOtpEligibility,
  isSmsDestinationSuppressed,
  lineTypeAllowsSms,
  normalizeSmsLineType,
} = require('../src/services/smsOtpFoundation');
const {
  SMS_PROVIDER_SAFE_ERRORS,
  assertSmsProviderRequest,
  assertSmsProviderResult,
} = require('../src/services/smsProviderContract');

const US = { phone_e164: '+15551234567', phone_country_code: 'US' };

test('US canonical phone is foundation-eligible while provider delivery stays disabled', () => {
  assert.deepEqual(getSmsOtpEligibility(US), {
    eligible: true,
    reason: null,
    country: 'US',
    phone_present: true,
    delivery_enabled: false,
  });
});

test('PH, unknown, missing canonical, legacy-only, and suppressed destinations are ineligible', () => {
  assert.equal(getSmsOtpEligibility({ phone_e164: '+639171234567', phone_country_code: 'PH' }).reason, 'country_not_supported');
  assert.equal(getSmsOtpEligibility({ phone_e164: '+15551234567', phone_country_code: 'CA' }).reason, 'country_not_supported');
  assert.equal(getSmsOtpEligibility({ phone_country_code: 'US' }).reason, 'canonical_phone_missing');
  assert.equal(getSmsOtpEligibility({ phone: '5551234567' }).reason, 'canonical_phone_missing');
  assert.equal(getSmsOtpEligibility(US, { suppressed: true }).reason, 'destination_suppressed');
});

test('future line-type contract allows only mobile and fails closed', () => {
  assert.equal(lineTypeAllowsSms('mobile'), true);
  for (const type of ['landline', 'voip', 'unknown', 'new-provider-value']) {
    assert.equal(lineTypeAllowsSms(type), false, type);
  }
  assert.equal(normalizeSmsLineType('NEW-PROVIDER-VALUE'), 'unknown');
  assert.equal(getSmsOtpEligibility(US, { lookupEnabled: true, lookupFailed: true }).reason, 'lookup_failed');
});

test('suppression lookup uses only a fingerprint and fails closed on invalid input or RPC errors', async () => {
  const fingerprint = 'a'.repeat(64);
  let args;
  const db = { rpc: async (name, value) => { args = { name, value }; return { data: false, error: null }; } };
  assert.equal(await isSmsDestinationSuppressed(db, fingerprint), false);
  assert.deepEqual(args, {
    name: 'service_is_sms_destination_suppressed',
    value: { p_destination_fingerprint: fingerprint, p_scope: 'authentication' },
  });
  assert.equal(await isSmsDestinationSuppressed(db, '+15551234567'), true);
  assert.equal(await isSmsDestinationSuppressed({ rpc: async () => ({ error: new Error('down') }) }, fingerprint), true);
});

test('provider-neutral contract accepts bounded inputs and safe results', () => {
  assert.equal(assertSmsProviderRequest({
    toE164: '+15551234567', code: '123456',
    challengeId: '81000000-0000-4000-8000-000000000001',
    expiresAt: '2026-08-12T00:10:00.000Z', environment: 'qa',
  }), true);
  assert.equal(assertSmsProviderResult({ provider: 'provider_a', messageId: 'message-1', status: 'queued', outcome: 'accepted' }), true);
  assert.deepEqual(SMS_PROVIDER_SAFE_ERRORS, [
    'invalid_destination', 'blocked_destination', 'provider_rejected',
    'transient_preacceptance', 'ambiguous_outcome', 'misconfigured',
  ]);
});

test('provider-neutral contract rejects raw-format destinations and unbounded provider responses', () => {
  assert.throws(() => assertSmsProviderRequest({
    toE164: '(555) 123-4567', code: '123456',
    challengeId: '81000000-0000-4000-8000-000000000001',
    expiresAt: '2026-08-12T00:10:00.000Z', environment: 'qa',
  }));
  assert.throws(() => assertSmsProviderResult({ provider: 'twilio', messageId: 'message-1', status: 'delivered' }));
});
