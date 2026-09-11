'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const { orchestrateOtpSmsDelivery } = require('../src/services/smsDeliveryOrchestrator');
const {
  TelnyxTransportError,
  createTelnyxSmsProvider,
  readTelnyxConfig,
  requestTelnyxMessage,
} = require('../src/clients/telnyx');

const NOW = new Date('2026-08-12T12:00:00.000Z');
const EXPIRES_AT = '2026-08-12T12:10:00.000Z';
const CHALLENGE_ID = '83000000-0000-4000-8000-000000000001';
const DESTINATION_FINGERPRINT = 'a'.repeat(64);
const ENV = Object.freeze({
  SMS_ENABLED: 'true',
  SMS_ENVIRONMENT: 'qa',
  SMS_PROVIDER: 'telnyx',
  TELNYX_API_KEY: 'test-only-api-key',
  TELNYX_MESSAGING_PROFILE_ID: 'test-profile',
  TELNYX_SENDER_E164: '+15555550199',
  TELNYX_MESSAGING_WEBHOOK_URL: 'https://ia-backend-qa.onrender.com/webhook/telnyx/sms',
  TELNYX_TIMEOUT_MS: '5000',
});

function request(environment = 'qa') {
  return {
    toE164: '+15555550100',
    code: '123456',
    challengeId: CHALLENGE_ID,
    expiresAt: EXPIRES_AT,
    environment,
  };
}

function providerFor(responseOrError, providerEnv = ENV) {
  let calls = 0;
  let invocation = null;
  const provider = createTelnyxSmsProvider({
    env: providerEnv,
    now: () => NOW,
    transport: async (value) => {
      calls += 1;
      invocation = value;
      if (responseOrError instanceof Error) throw responseOrError;
      return responseOrError;
    },
  });
  return { provider, calls: () => calls, invocation: () => invocation };
}

test('accepted response returns one opaque Telnyx message binding and sends only transport fields', async () => {
  const harness = providerFor({ statusCode: 200, body: JSON.stringify({ data: { id: 'opaque-message-1', to: [{ status: 'queued' }] } }) });
  assert.deepEqual(await harness.provider.sendOtpSms(request()), {
    provider: 'telnyx', messageId: 'opaque-message-1', status: 'queued', outcome: 'accepted', failureCategory: null,
  });
  assert.equal(harness.calls(), 1);
  assert.deepEqual(Object.keys(harness.invocation().body).sort(), ['encoding', 'from', 'text', 'to', 'type', 'webhook_url']);
  assert.equal(harness.invocation().body.from, ENV.TELNYX_SENDER_E164);
  assert.equal(harness.invocation().body.to, request().toE164);
  assert.match(harness.invocation().body.text, /123456.*10 minutes/);
  assert.equal(harness.invocation().body.webhook_url, ENV.TELNYX_MESSAGING_WEBHOOK_URL);
  const encoded = JSON.stringify(harness.invocation().body);
  for (const forbidden of [CHALLENGE_ID, 'candidate', 'client', 'role', 'submission']) assert.equal(encoded.includes(forbidden), false);
});

test('accepted sent response normalizes sent while malformed success is ambiguous', async () => {
  const sent = providerFor({ statusCode: 202, body: JSON.stringify({ data: { id: 'opaque-message-2', to: [{ status: 'sent' }] } }) });
  assert.equal((await sent.provider.sendOtpSms(request())).status, 'sent');
  const malformed = providerFor({ statusCode: 200, body: '{"data":{"id":"opaque-message-3"}}' });
  assert.equal((await malformed.provider.sendOtpSms(request())).outcome, 'ambiguous_outcome');
});

test('Telnyx HTTP failures map only to bounded provider-neutral outcomes', async () => {
  const cases = [
    [400, '90000', 'rejected'],
    [400, '40001', 'invalid_destination'],
    [403, '40300', 'blocked_destination'],
    [401, '10000', 'misconfigured'],
    [403, '40305', 'misconfigured'],
    [429, '10011', 'transient_preacceptance'],
    [429, '40333', 'rejected'],
    [503, '10001', 'transient_preacceptance'],
  ];
  for (const [statusCode, code, outcome] of cases) {
    const rawProviderText = `raw-${statusCode}-${code}`;
    const harness = providerFor({ statusCode, body: JSON.stringify({ errors: [{ code, detail: rawProviderText }] }) });
    const result = await harness.provider.sendOtpSms(request());
    assert.equal(result.outcome, outcome);
    assert.equal(JSON.stringify(result).includes(rawProviderText), false);
    assert.equal(harness.calls(), 1);
  }
});

test('pre-dispatch failures are transient while post-dispatch failures and timeouts are ambiguous', async () => {
  for (const kind of ['connection_error', 'timeout']) {
    const before = providerFor(new TelnyxTransportError(kind, false));
    assert.equal((await before.provider.sendOtpSms(request())).outcome, 'transient_preacceptance');
    const after = providerFor(new TelnyxTransportError(kind, true));
    assert.equal((await after.provider.sendOtpSms(request())).outcome, 'ambiguous_outcome');
    assert.equal(before.calls(), 1);
    assert.equal(after.calls(), 1);
  }
});

function mockHttpsRequest(mode) {
  let requests = 0;
  return {
    requests: () => requests,
    module: {
      request(options, onResponse) {
        requests += 1;
        assert.equal(options.hostname, 'api.telnyx.com');
        assert.equal(options.path, '/v2/messages');
        const requestEmitter = new EventEmitter();
        let timeoutCallback = null;
        requestEmitter.setTimeout = (_timeout, callback) => { timeoutCallback = callback; };
        requestEmitter.destroy = (error) => requestEmitter.emit('error', error);
        requestEmitter.end = () => {
          if (mode === 'connection_before') return requestEmitter.emit('error', new Error('raw failure'));
          if (mode === 'timeout_before') return timeoutCallback();
          requestEmitter.emit('finish');
          if (mode === 'timeout_after') return timeoutCallback();
          const response = new EventEmitter();
          response.statusCode = 200;
          response.destroy = (error) => response.emit('error', error);
          onResponse(response);
          response.emit('data', Buffer.from('{"data":{"id":"message","to":[{"status":"queued"}]}}'));
          response.emit('end');
        };
        return requestEmitter;
      },
    },
  };
}

test('finite transport distinguishes dispatch state for connection and timeout failures', async () => {
  for (const [mode, dispatched] of [['connection_before', false], ['timeout_before', false], ['timeout_after', true]]) {
    const mock = mockHttpsRequest(mode);
    await assert.rejects(
      requestTelnyxMessage({ apiKey: 'test-key', body: { from: '+15555550199' }, timeoutMs: 1000, httpsModule: mock.module }),
      (error) => error instanceof TelnyxTransportError && error.dispatched === dispatched,
    );
    assert.equal(mock.requests(), 1);
  }
  const success = mockHttpsRequest('success');
  assert.equal((await requestTelnyxMessage({ apiKey: 'test-key', body: {}, timeoutMs: 1000, httpsModule: success.module })).statusCode, 200);
  assert.equal(success.requests(), 1);
});

test('misconfiguration fails closed without reaching the network', async () => {
  for (const env of [
    { ...ENV, SMS_ENABLED: 'false' },
    { ...ENV, SMS_PROVIDER: 'other' },
    { ...ENV, TELNYX_API_KEY: '' },
    { ...ENV, TELNYX_MESSAGING_PROFILE_ID: '' },
    { ...ENV, TELNYX_SENDER_E164: '+639171234567' },
    { ...ENV, TELNYX_MESSAGING_WEBHOOK_URL: '' },
    { ...ENV, TELNYX_MESSAGING_WEBHOOK_URL: 'http://ia-backend-qa.onrender.com/webhook/telnyx/sms' },
    { ...ENV, TELNYX_MESSAGING_WEBHOOK_URL: 'https://api.alphasourceai.com/webhook/telnyx/sms' },
  ]) {
    let called = false;
    const provider = createTelnyxSmsProvider({ env, transport: async () => { called = true; } });
    assert.equal((await provider.sendOtpSms(request())).outcome, 'misconfigured');
    assert.equal(called, false);
  }
  assert.equal(readTelnyxConfig(ENV).valid, true);
});

test('production transport is valid only when provider and request environments match', async () => {
  const productionEnv = {
    ...ENV,
    SMS_ENVIRONMENT: 'production',
    TELNYX_MESSAGING_WEBHOOK_URL: 'https://api.alphasourceai.com/webhook/telnyx/sms',
  };
  const accepted = providerFor({
    statusCode: 200,
    body: JSON.stringify({ data: { id: 'opaque-message-production', to: [{ status: 'queued' }] } }),
  }, productionEnv);
  assert.equal(readTelnyxConfig(productionEnv).valid, true);
  assert.equal((await accepted.provider.sendOtpSms(request('production'))).outcome, 'accepted');
  assert.equal((await accepted.provider.sendOtpSms(request('qa'))).outcome, 'misconfigured');
  assert.equal(accepted.calls(), 1);
});

test('C1 uses C0 ordering: commit and send_requested precede exactly one Telnyx call and acceptance metadata', async () => {
  const order = [];
  const base = providerFor({ statusCode: 200, body: JSON.stringify({ data: { id: 'opaque-message-4', to: [{ status: 'queued' }] } }) }).provider;
  const adapter = {
    ...base,
    async sendOtpSms(value) { order.push('telnyx'); return base.sendOtpSms(value); },
  };
  const result = await orchestrateOtpSmsDelivery({
    db: {}, environment: 'qa', allowNetwork: true,
    candidate: { id: 'synthetic', phone_e164: '+15555550100', phone_country_code: 'US' },
    destinationFingerprint: DESTINATION_FINGERPRINT,
    authorizeAndBind: async () => ({ valid: true }),
    checkSuppressed: async () => false,
    rateLimitGates: [async () => ({ allowed: true })],
    issueChallenge: async () => { order.push('commit'); return { challengeId: CHALLENGE_ID, code: '123456', expiresAt: EXPIRES_AT, channel: 'sms', committed: true }; },
    adapter,
    recordMetadata: async (_db, value) => { order.push(value.event); return value; },
  });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.retryAttempted, false);
  assert.equal(result.failoverAttempted, false);
  assert.equal(base.getCallCount(), 1);
  assert.deepEqual(order, ['commit', 'send_requested', 'telnyx', 'provider_accepted']);
});

test('malformed network destination fingerprint is denied before challenge creation and Telnyx call', async () => {
  let committed = false;
  const base = providerFor({ statusCode: 200, body: '{}' }).provider;
  const result = await orchestrateOtpSmsDelivery({
    db: {}, environment: 'qa', allowNetwork: true,
    candidate: { id: 'synthetic', phone_e164: '+15555550100', phone_country_code: 'US' },
    destinationFingerprint: 'not-a-fingerprint',
    authorizeAndBind: async () => ({ valid: true }), checkSuppressed: async () => false,
    issueChallenge: async () => { committed = true; }, adapter: base,
  });
  assert.equal(result.outcome, 'blocked_destination');
  assert.equal(committed, false);
  assert.equal(base.getCallCount(), 0);
});
