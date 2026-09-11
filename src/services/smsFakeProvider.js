'use strict';

const {
  assertSmsProviderRequest,
  deriveSmsIdempotencyIdentity,
} = require('./smsProviderContract');
const { buildOtpSmsMessage } = require('./smsMessage');

const FAKE_SMS_MODES = Object.freeze([
  'accepted',
  'rejected',
  'transient_preacceptance',
  'ambiguous_outcome',
  'invalid_destination',
  'blocked_destination',
  'timeout_before_dispatch',
  'timeout_after_dispatch',
]);

function fakeResult(mode, idempotencyIdentity) {
  if (mode === 'accepted') {
    return Object.freeze({
      provider: 'fake',
      messageId: `fake_${idempotencyIdentity.slice(0, 32)}`,
      status: 'queued',
      outcome: 'accepted',
      failureCategory: null,
    });
  }
  const outcome = mode === 'timeout_before_dispatch'
    ? 'transient_preacceptance'
    : mode === 'timeout_after_dispatch' ? 'ambiguous_outcome' : mode;
  const failureCategory = outcome === 'rejected' ? 'provider_rejected' : outcome;
  const status = ['rejected', 'invalid_destination', 'blocked_destination'].includes(outcome)
    ? 'rejected'
    : outcome === 'ambiguous_outcome' ? null : 'failed';
  return Object.freeze({ provider: 'fake', messageId: null, status, outcome, failureCategory });
}

function createFakeSmsProvider({ mode = 'accepted', environment, now = () => new Date() } = {}) {
  if (!FAKE_SMS_MODES.includes(mode)) throw new TypeError('fake mode is invalid');
  if (!['local', 'qa'].includes(environment)) throw new Error('fake SMS provider is disabled outside local and QA');
  let callCount = 0;
  return Object.freeze({
    name: 'fake',
    network: 'none',
    getCallCount: () => callCount,
    async sendOtpSms(request) {
      assertSmsProviderRequest(request);
      if (request.environment !== environment || request.environment === 'production') {
        throw new Error('fake SMS provider environment mismatch');
      }
      callCount += 1;
      buildOtpSmsMessage({ code: request.code, expiresAt: request.expiresAt, now: now() });
      const identity = deriveSmsIdempotencyIdentity(request);
      return fakeResult(mode, identity);
    },
  });
}

module.exports = { FAKE_SMS_MODES, createFakeSmsProvider };
