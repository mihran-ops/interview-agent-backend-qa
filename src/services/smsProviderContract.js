'use strict';

const crypto = require('crypto');

const SMS_PROVIDER_SAFE_ERRORS = Object.freeze([
  'invalid_destination',
  'blocked_destination',
  'provider_rejected',
  'transient_preacceptance',
  'ambiguous_outcome',
  'misconfigured',
]);

const SMS_DELIVERY_STATUSES = Object.freeze([
  'queued', 'sent', 'delivered', 'failed', 'undelivered', 'rejected',
]);
const SMS_SEND_OUTCOMES = Object.freeze([
  'accepted',
  'rejected',
  'transient_preacceptance',
  'ambiguous_outcome',
  'invalid_destination',
  'blocked_destination',
  'misconfigured',
]);
const SMS_PROVIDER_RESULT_STATUSES = SMS_DELIVERY_STATUSES;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSmsProviderRequest({ toE164, code, challengeId, expiresAt, environment } = {}) {
  if (!/^\+[1-9]\d{7,14}$/.test(String(toE164 || ''))) throw new TypeError('toE164 must be canonical E.164');
  if (!/^\d{6}$/.test(String(code || ''))) throw new TypeError('code must be six digits');
  if (!UUID_RE.test(String(challengeId || ''))) throw new TypeError('challengeId is required');
  if (!Number.isFinite(Date.parse(String(expiresAt || '')))) throw new TypeError('expiresAt is required');
  if (!['local', 'qa', 'production'].includes(String(environment || ''))) throw new TypeError('environment is invalid');
  return true;
}

function assertSmsProviderResult({ provider, messageId, status, outcome, failureCategory } = {}) {
  if (!/^[a-z0-9_-]{1,40}$/.test(String(provider || ''))) throw new TypeError('provider is invalid');
  if (!SMS_SEND_OUTCOMES.includes(String(outcome || ''))) throw new TypeError('outcome is invalid');
  if (outcome === 'accepted') {
    if (!String(messageId || '').trim() || String(messageId).length > 255 || /[\u0000-\u001f\u007f]/.test(String(messageId))) {
      throw new TypeError('messageId is invalid');
    }
    if (!['queued', 'sent'].includes(String(status || ''))) throw new TypeError('status is invalid');
    if (failureCategory != null) throw new TypeError('failureCategory is invalid');
  } else {
    if (messageId != null) throw new TypeError('messageId is invalid');
    const expectedStatus = ['rejected', 'invalid_destination', 'blocked_destination'].includes(outcome)
      ? 'rejected'
      : outcome === 'ambiguous_outcome' ? null : 'failed';
    if (status !== expectedStatus) throw new TypeError('status is invalid');
    if (!SMS_PROVIDER_SAFE_ERRORS.includes(String(failureCategory || ''))) {
      throw new TypeError('failureCategory is invalid');
    }
  }
  return true;
}

function deriveSmsIdempotencyIdentity({ environment, challengeId } = {}) {
  const normalizedEnvironment = String(environment || '').trim().toLowerCase();
  const normalizedChallengeId = String(challengeId || '').trim().toLowerCase();
  if (!['local', 'qa', 'production'].includes(normalizedEnvironment) || !UUID_RE.test(normalizedChallengeId)) {
    throw new TypeError('environment and challengeId are required');
  }
  return crypto.createHash('sha256')
    .update(`sms-send:v1\u0000${normalizedEnvironment}\u0000${normalizedChallengeId}`)
    .digest('hex');
}

function safeSmsTelemetry({ provider, status, outcome, country } = {}) {
  return Object.freeze({
    provider: /^[a-z0-9_-]{1,40}$/.test(String(provider || '')) ? provider : null,
    status: SMS_DELIVERY_STATUSES.includes(status) ? status : null,
    outcome: SMS_SEND_OUTCOMES.includes(outcome) ? outcome : 'misconfigured',
    country: /^[A-Z]{2}$/.test(String(country || '')) ? country : null,
  });
}

module.exports = {
  SMS_DELIVERY_STATUSES,
  SMS_SEND_OUTCOMES,
  SMS_PROVIDER_RESULT_STATUSES,
  SMS_PROVIDER_SAFE_ERRORS,
  assertSmsProviderRequest,
  assertSmsProviderResult,
  deriveSmsIdempotencyIdentity,
  safeSmsTelemetry,
};
