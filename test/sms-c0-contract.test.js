'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  assertSmsProviderResult,
  deriveSmsIdempotencyIdentity,
  safeSmsTelemetry,
} = require('../src/services/smsProviderContract');
const { analyzeSmsSegments, buildOtpSmsMessage } = require('../src/services/smsMessage');
const { FAKE_SMS_MODES, createFakeSmsProvider } = require('../src/services/smsFakeProvider');
const {
  applyDeliveryStatusFixture,
  normalizeDeliveryCallbackFixture,
} = require('../src/services/smsDeliveryCallbackContract');
const {
  networkDestinationAllowed,
  orchestrateOtpSmsDelivery,
  qaDestinationAllowed,
  validateCommittedChallenge,
} = require('../src/services/smsDeliveryOrchestrator');

const CHALLENGE_ID = '81000000-0000-4000-8000-000000000001';
const SECOND_CHALLENGE_ID = '81000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-08-12T12:00:00.000Z');
const EXPIRES_AT = '2026-08-12T12:10:00.000Z';
const CANDIDATE = Object.freeze({ id: 'candidate-fixture', phone_e164: '+15555550100', phone_country_code: 'US' });
const FINGERPRINT = 'a'.repeat(64);

function committedChallenge(challengeId = CHALLENGE_ID) {
  return Object.freeze({ challengeId, code: '123456', expiresAt: EXPIRES_AT, channel: 'sms', committed: true });
}

function harnessOptions({ mode = 'accepted', candidate = CANDIDATE, suppressed = false, adapter, recordMetadata } = {}) {
  const order = [];
  const records = [];
  const selectedAdapter = adapter || createFakeSmsProvider({ mode, environment: 'qa', now: () => NOW });
  const wrappedAdapter = Object.freeze({
    ...selectedAdapter,
    async sendOtpSms(request) {
      order.push('adapter');
      return selectedAdapter.sendOtpSms(request);
    },
  });
  return {
    order,
    records,
    adapter: selectedAdapter,
    options: {
      db: {},
      environment: 'qa',
      candidate,
      destinationFingerprint: FINGERPRINT,
      authorizeAndBind: async () => { order.push('authorize'); return { valid: true }; },
      checkSuppressed: async () => { order.push('suppression'); return suppressed; },
      rateLimitGates: [async () => { order.push('rate'); return { allowed: true }; }],
      issueChallenge: async () => { order.push('commit'); return committedChallenge(); },
      adapter: wrappedAdapter,
      recordMetadata: recordMetadata || (async (_db, value) => { order.push(value.event); records.push(value); return value; }),
    },
  };
}

test('challenge commit and send-request persistence strictly precede the one adapter call', async () => {
  const harness = harnessOptions();
  const result = await orchestrateOtpSmsDelivery(harness.options);
  assert.equal(result.outcome, 'accepted');
  assert.equal(harness.adapter.getCallCount(), 1);
  assert.deepEqual(harness.order, ['authorize', 'suppression', 'rate', 'commit', 'send_requested', 'adapter', 'provider_accepted']);
  assert.equal(harness.records[1].providerMessageId.startsWith('fake_'), true);
});

test('adapter cannot run when the issuance callback does not prove commit', async () => {
  const harness = harnessOptions();
  harness.options.issueChallenge = async () => ({ ...committedChallenge(), committed: false });
  await assert.rejects(() => orchestrateOtpSmsDelivery(harness.options), /committed SMS challenge/);
  assert.equal(harness.adapter.getCallCount(), 0);
  assert.throws(() => validateCommittedChallenge({}));
});

test('a send-request metadata failure prevents adapter invocation', async () => {
  const harness = harnessOptions({ recordMetadata: async () => { throw new Error('bounded database failure'); } });
  await assert.rejects(() => orchestrateOtpSmsDelivery(harness.options), /bounded database failure/);
  assert.equal(harness.adapter.getCallCount(), 0);
});

test('send-request failure releases a production spend reservation before surfacing', async () => {
  const harness = harnessOptions({ recordMetadata: async () => { throw new Error('bounded database failure'); } });
  const releases = [];
  harness.options.environment = 'production';
  harness.options.spendGate = async () => ({ allowed: true });
  harness.options.releaseSpend = async (outcome) => { releases.push(outcome); return true; };
  await assert.rejects(() => orchestrateOtpSmsDelivery(harness.options), /bounded database failure/);
  assert.deepEqual(releases, ['misconfigured']);
  assert.equal(harness.adapter.getCallCount(), 0);
});

test('all fake-provider modes are deterministic, bounded, and called exactly once', async () => {
  const expectations = {
    accepted: 'accepted',
    rejected: 'rejected',
    transient_preacceptance: 'transient_preacceptance',
    ambiguous_outcome: 'ambiguous_outcome',
    invalid_destination: 'invalid_destination',
    blocked_destination: 'blocked_destination',
    timeout_before_dispatch: 'transient_preacceptance',
    timeout_after_dispatch: 'ambiguous_outcome',
  };
  for (const mode of FAKE_SMS_MODES) {
    const harness = harnessOptions({ mode });
    const result = await orchestrateOtpSmsDelivery(harness.options);
    assert.equal(result.outcome, expectations[mode], mode);
    assert.equal(result.retryAttempted, false, mode);
    assert.equal(result.failoverAttempted, false, mode);
    assert.equal(harness.adapter.getCallCount(), 1, mode);
    assert.equal(JSON.stringify(result).includes('123456'), false, mode);
    assert.equal(JSON.stringify(result).includes(CANDIDATE.phone_e164), false, mode);
  }
});

test('an adapter throw after invocation becomes ambiguous without retry or failover', async () => {
  let calls = 0;
  const adapter = Object.freeze({ name: 'fake', network: 'none', sendOtpSms: async () => { calls += 1; throw new Error('raw provider body'); } });
  const harness = harnessOptions({ adapter });
  const result = await orchestrateOtpSmsDelivery(harness.options);
  assert.equal(result.outcome, 'ambiguous_outcome');
  assert.equal(result.retryAttempted, false);
  assert.equal(result.failoverAttempted, false);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('raw provider body'), false);
});

test('accepted-provider metadata failure is fail-closed as ambiguous and never resends', async () => {
  let records = 0;
  const harness = harnessOptions({
    recordMetadata: async (_db, value) => {
      records += 1;
      if (value.event === 'provider_accepted') throw new Error('database unavailable');
      return value;
    },
  });
  const result = await orchestrateOtpSmsDelivery(harness.options);
  assert.equal(result.outcome, 'ambiguous_outcome');
  assert.equal(harness.adapter.getCallCount(), 1);
  assert.equal(records, 2);
});

test('spend settlement failure cannot turn an accepted provider response into a client retry', async () => {
  const harness = harnessOptions();
  harness.options.environment = 'production';
  harness.options.adapter = {
    name: 'fake',
    network: 'none',
    async sendOtpSms() {
      return { provider: 'fake', messageId: 'production-fixture', status: 'queued', outcome: 'accepted', failureCategory: null };
    },
  };
  harness.options.spendGate = async () => ({ allowed: true });
  harness.options.finalizeSpend = async () => { throw new Error('database unavailable'); };
  const result = await orchestrateOtpSmsDelivery(harness.options);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.adapterCalled, true);
});

test('suppressed and ineligible destinations stop before challenge creation or adapter invocation', async () => {
  const suppressed = harnessOptions({ suppressed: true });
  const suppressedResult = await orchestrateOtpSmsDelivery(suppressed.options);
  assert.deepEqual(suppressedResult, { outcome: 'blocked_destination', challengeCreated: false, adapterCalled: false });
  assert.equal(suppressed.adapter.getCallCount(), 0);
  assert.equal(suppressed.order.includes('commit'), false);

  const ineligible = harnessOptions({ candidate: { phone_e164: '+639171234567', phone_country_code: 'PH' } });
  const ineligibleResult = await orchestrateOtpSmsDelivery(ineligible.options);
  assert.equal(ineligibleResult.outcome, 'invalid_destination');
  assert.equal(ineligible.adapter.getCallCount(), 0);
  assert.equal(ineligible.order.includes('commit'), false);
});

test('authorization and rate gates fail closed before issuance', async () => {
  const authorization = harnessOptions();
  authorization.options.authorizeAndBind = async () => ({ valid: false });
  assert.equal((await orchestrateOtpSmsDelivery(authorization.options)).outcome, 'misconfigured');
  assert.equal(authorization.adapter.getCallCount(), 0);

  const rate = harnessOptions();
  rate.options.rateLimitGates = [async () => ({ allowed: false })];
  assert.equal((await orchestrateOtpSmsDelivery(rate.options)).outcome, 'blocked_destination');
  assert.equal(rate.adapter.getCallCount(), 0);
});

test('production controls run rates, lookup, and spend before challenge commit', async () => {
  const harness = harnessOptions();
  const order = harness.order;
  harness.options.environment = 'production';
  harness.options.adapter = {
    name: 'fake',
    network: 'none',
    async sendOtpSms() {
      order.push('adapter');
      return { provider: 'fake', messageId: 'production-fixture', status: 'queued', outcome: 'accepted', failureCategory: null };
    },
  };
  harness.options.rateLimitGates = [async () => { order.push('production-rate'); return { allowed: true }; }];
  harness.options.lookupLineType = async () => { order.push('lookup'); return { ok: true, lineType: 'mobile' }; };
  harness.options.spendGate = async () => { order.push('spend'); return { allowed: true }; };
  harness.options.finalizeSpend = async (outcome) => { order.push(`spend-${outcome}`); return true; };
  const result = await orchestrateOtpSmsDelivery(harness.options);
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(order, [
    'authorize', 'suppression', 'production-rate', 'lookup', 'spend',
    'commit', 'send_requested', 'adapter', 'provider_accepted', 'spend-accepted',
  ]);
});

test('line lookup and spend breaker fail closed before challenge creation', async () => {
  for (const lookup of [
    { ok: true, lineType: 'landline' },
    { ok: true, lineType: 'voip' },
    { ok: true, lineType: 'unknown' },
    { ok: false, lineType: 'unknown' },
  ]) {
    const harness = harnessOptions();
    harness.options.environment = 'production';
    harness.options.lookupLineType = async () => lookup;
    const result = await orchestrateOtpSmsDelivery(harness.options);
    assert.equal(result.outcome, 'invalid_destination');
    assert.equal(result.challengeCreated, false);
    assert.equal(harness.order.includes('commit'), false);
  }

  const spend = harnessOptions();
  spend.options.environment = 'production';
  spend.options.lookupLineType = async () => ({ ok: true, lineType: 'mobile' });
  spend.options.spendGate = async () => ({ allowed: false });
  const result = await orchestrateOtpSmsDelivery(spend.options);
  assert.equal(result.outcome, 'blocked_destination');
  assert.equal(result.challengeCreated, false);
  assert.equal(spend.order.includes('commit'), false);
});

test('network delivery remains explicit while production is a valid orchestration environment', async () => {
  assert.throws(() => createFakeSmsProvider(), /disabled/);
  assert.throws(() => createFakeSmsProvider({ environment: 'production' }), /disabled/);
  const harness = harnessOptions();
  harness.options.environment = undefined;
  await assert.rejects(() => orchestrateOtpSmsDelivery(harness.options), /environment is invalid/);
  harness.options.environment = 'production';
  harness.options.adapter = {
    name: 'fake',
    network: 'none',
    async sendOtpSms() {
      return { provider: 'fake', messageId: 'production-fixture', status: 'queued', outcome: 'accepted', failureCategory: null };
    },
  };
  assert.equal((await orchestrateOtpSmsDelivery(harness.options)).outcome, 'accepted');
  harness.options.environment = 'qa';
  harness.options.adapter = { name: 'provider_a', network: 'https', sendOtpSms: async () => ({}) };
  await assert.rejects(() => orchestrateOtpSmsDelivery(harness.options), /network SMS adapters are disabled/);
});

test('QA and production transport accept every eligible fingerprint without a destination allowlist', () => {
  assert.equal(qaDestinationAllowed({ environment: 'qa', destinationFingerprint: FINGERPRINT, adapterNetwork: 'none' }), true);
  assert.equal(qaDestinationAllowed({ environment: 'qa', destinationFingerprint: FINGERPRINT, adapterNetwork: 'https' }), true);
  assert.equal(qaDestinationAllowed({ environment: 'qa', destinationFingerprint: 'not-a-fingerprint', adapterNetwork: 'https' }), false);
  assert.equal(networkDestinationAllowed({ environment: 'production', destinationFingerprint: FINGERPRINT, adapterNetwork: 'https' }), true);
  assert.equal(networkDestinationAllowed({ environment: 'local', destinationFingerprint: FINGERPRINT, adapterNetwork: 'https' }), false);
});

test('idempotency identity is stable, challenge-specific, and independent of phone/code fields', () => {
  const first = deriveSmsIdempotencyIdentity({ environment: 'qa', challengeId: CHALLENGE_ID, code: '111111', toE164: '+15555550100' });
  const same = deriveSmsIdempotencyIdentity({ environment: 'qa', challengeId: CHALLENGE_ID, code: '999999', toE164: '+15555550199' });
  const second = deriveSmsIdempotencyIdentity({ environment: 'qa', challengeId: SECOND_CHALLENGE_ID });
  const production = deriveSmsIdempotencyIdentity({ environment: 'production', challengeId: CHALLENGE_ID });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, second);
  assert.notEqual(first, production);
  assert.equal(first.includes('111111'), false);
});

test('provider-neutral message uses live expiry and remains one GSM-7 segment', () => {
  const message = buildOtpSmsMessage({ code: '123456', expiresAt: EXPIRES_AT, now: NOW });
  assert.equal(message.body, 'alphaScreen: Your verification code is 123456. It expires in 10 minutes. Do not share it.');
  assert.deepEqual(message.analysis, {
    encoding: 'GSM-7', units: 89, segments: 1, singleSegmentLimit: 160, multipartSegmentLimit: 153,
  });
  const oneMinute = buildOtpSmsMessage({ code: '123456', expiresAt: '2026-08-12T12:00:01.000Z', now: NOW });
  assert.match(oneMinute.body, /1 minute\./);
});

test('GSM analysis accounts for extension characters and detects Unicode regressions', () => {
  assert.deepEqual(analyzeSmsSegments("It's fine ^{}"), {
    encoding: 'GSM-7', units: 16, segments: 1, singleSegmentLimit: 160, multipartSegmentLimit: 153,
  });
  assert.equal(analyzeSmsSegments('smart “quote”').encoding, 'UCS-2');
  assert.equal(analyzeSmsSegments('em — dash').encoding, 'UCS-2');
  assert.equal(analyzeSmsSegments('special ✓').encoding, 'UCS-2');
  assert.throws(() => buildOtpSmsMessage({ code: '123456', expiresAt: EXPIRES_AT, now: NOW, complianceSuffix: 'x'.repeat(100) }), /segment limit/);
});

test('callback fixture is normalized and delivery transitions are monotonic telemetry only', () => {
  assert.deepEqual(normalizeDeliveryCallbackFixture({
    provider: 'provider_a', messageId: 'message-1', eventId: 'event-1', status: 'delivered', occurredAt: EXPIRES_AT,
  }), {
    provider: 'provider_a', messageId: 'message-1', eventId: 'event-1', status: 'delivered', occurredAt: EXPIRES_AT,
  });
  assert.deepEqual(applyDeliveryStatusFixture('queued', 'delivered'), { applied: true, status: 'delivered', terminal: true });
  assert.deepEqual(applyDeliveryStatusFixture('delivered', 'queued'), { applied: false, status: 'delivered' });
  assert.throws(() => normalizeDeliveryCallbackFixture({ provider: 'provider_a', messageId: 'message-1', eventId: 'event\nraw', status: 'sent', occurredAt: EXPIRES_AT }));
});

test('bounded telemetry contains no OTP, E.164, body, message ID, idempotency identity, or raw response', () => {
  const telemetry = safeSmsTelemetry({
    provider: 'provider_a', status: 'queued', outcome: 'accepted', country: 'US',
    code: '123456', toE164: CANDIDATE.phone_e164, body: 'secret body', messageId: 'message-1', raw: 'raw response',
  });
  assert.deepEqual(telemetry, { provider: 'provider_a', status: 'queued', outcome: 'accepted', country: 'US' });
  const encoded = JSON.stringify(telemetry);
  for (const secret of ['123456', CANDIDATE.phone_e164, 'secret body', 'message-1', 'raw response']) assert.equal(encoded.includes(secret), false);
});

test('fake-provider implementation has no network dependency or provider-specific default', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'smsFakeProvider.js'), 'utf8');
  assert.doesNotMatch(source, /axios|node-fetch|https|http\.request|fetch\s*\(/);
  assert.doesNotMatch(source, /telnyx|signalwire|twilio/i);
  const orchestrator = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'smsDeliveryOrchestrator.js'), 'utf8');
  assert.doesNotMatch(orchestrator, /\.from\(['"]otp_challenges|private_auth\.otp_challenges|update\s+private_auth/i);
});

test('provider result contract rejects native/raw or inconsistent outcomes', () => {
  assert.equal(assertSmsProviderResult({ provider: 'fake', messageId: 'message-1', status: 'queued', outcome: 'accepted', failureCategory: null }), true);
  assert.equal(assertSmsProviderResult({ provider: 'fake', messageId: null, status: null, outcome: 'ambiguous_outcome', failureCategory: 'ambiguous_outcome' }), true);
  assert.throws(() => assertSmsProviderResult({ provider: 'fake', messageId: 'native', status: 'failed', outcome: 'ambiguous_outcome', failureCategory: 'raw provider response' }));
});
