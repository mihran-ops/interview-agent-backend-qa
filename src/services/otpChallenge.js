'use strict';

const crypto = require('crypto');

const OTP_PURPOSE = 'interview_access';
const OTP_CHANNEL_EMAIL = 'email';
const OTP_CHANNEL_SMS = 'sms';
const OTP_CODE_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PEPPER_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class OtpConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OtpConfigurationError';
    this.code = 'OTP_CONFIGURATION_ERROR';
  }
}

class OtpChallengeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OtpChallengeError';
    this.code = code;
  }
}

function getOtpSecret(version = OTP_PEPPER_VERSION, env = process.env) {
  const configuredVersion = Number(env.OTP_HMAC_SECRET_VERSION || OTP_PEPPER_VERSION);
  if (configuredVersion !== version) {
    throw new OtpConfigurationError(`OTP HMAC secret version ${version} is not configured`);
  }
  const raw = String(env[`OTP_HMAC_SECRET_V${version}`] || '').trim();
  if (!raw) throw new OtpConfigurationError(`OTP_HMAC_SECRET_V${version} is required`);

  let bytes;
  if (/^[0-9a-f]{64,}$/i.test(raw) && raw.length % 2 === 0) {
    bytes = Buffer.from(raw, 'hex');
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) {
    bytes = Buffer.from(raw, 'base64');
  } else {
    bytes = Buffer.from(raw, 'utf8');
  }
  if (bytes.length < 32) throw new OtpConfigurationError('OTP HMAC secret must contain at least 32 bytes');
  return bytes;
}

function framed(fields) {
  return fields.map((value) => {
    const normalized = value == null ? '' : String(value);
    return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`;
  }).join('|');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalChannel(value = OTP_CHANNEL_EMAIL) {
  const channel = String(value || '').trim().toLowerCase();
  if (![OTP_CHANNEL_EMAIL, OTP_CHANNEL_SMS].includes(channel)) {
    throw new OtpChallengeError('INVALID_OTP_CHANNEL');
  }
  return channel;
}

function canonicalBinding(binding = {}) {
  const values = {
    candidate_id: String(binding.candidate_id || '').trim().toLowerCase(),
    client_id: String(binding.client_id || '').trim().toLowerCase(),
    role_id: String(binding.role_id || '').trim().toLowerCase(),
    submission_id: String(binding.submission_id || '').trim().toLowerCase(),
    interview_attempt_id: String(binding.interview_attempt_id || '').trim().toLowerCase(),
    recovery_authorization_id: String(binding.recovery_authorization_id || '').trim().toLowerCase(),
  };
  for (const field of ['candidate_id', 'client_id', 'role_id']) {
    if (!UUID_RE.test(values[field])) throw new OtpChallengeError('INVALID_OTP_BINDING', `${field} is required`);
  }
  for (const field of ['submission_id', 'interview_attempt_id', 'recovery_authorization_id']) {
    if (values[field] && !UUID_RE.test(values[field])) throw new OtpChallengeError('INVALID_OTP_BINDING', `${field} is invalid`);
  }
  return values;
}

function bindingFingerprint(binding, channelInput = OTP_CHANNEL_EMAIL) {
  const b = canonicalBinding(binding);
  const channel = canonicalChannel(channelInput);
  return crypto.createHash('sha256').update(framed([
    OTP_PURPOSE,
    channel,
    b.candidate_id,
    b.client_id,
    b.role_id,
    b.submission_id,
    b.interview_attempt_id,
    b.recovery_authorization_id,
  ])).digest('hex');
}

function destinationFingerprint(destination, version = OTP_PEPPER_VERSION, env = process.env, channelInput = OTP_CHANNEL_EMAIL) {
  const channel = canonicalChannel(channelInput);
  const normalized = channel === OTP_CHANNEL_SMS
    ? String(destination || '').trim()
    : normalizeEmail(destination);
  if (channel === OTP_CHANNEL_SMS && !/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new OtpChallengeError('INVALID_OTP_DESTINATION', 'canonical E.164 destination is required');
  }
  if (!normalized) throw new OtpChallengeError('INVALID_OTP_DESTINATION', 'destination is required');
  return crypto.createHmac('sha256', getOtpSecret(version, env))
    .update(framed(['otp-destination', channel, normalized]))
    .digest('hex');
}

function verifierHmac({ challengeId, code, binding, channel: channelInput = OTP_CHANNEL_EMAIL, version = OTP_PEPPER_VERSION, env = process.env }) {
  const normalizedChallengeId = String(challengeId || '').trim().toLowerCase();
  const normalizedCode = String(code || '').trim();
  if (!UUID_RE.test(normalizedChallengeId)) throw new OtpChallengeError('INVALID_CHALLENGE_ID');
  if (!/^\d{6}$/.test(normalizedCode)) throw new OtpChallengeError('INVALID_OTP_CODE');
  const b = canonicalBinding(binding);
  const channel = canonicalChannel(channelInput);
  return crypto.createHmac('sha256', getOtpSecret(version, env))
    .update(framed([
      'otp-verifier',
      String(version),
      normalizedChallengeId,
      OTP_PURPOSE,
      channel,
      normalizedCode,
      b.candidate_id,
      b.client_id,
      b.role_id,
      b.submission_id,
      b.interview_attempt_id,
      b.recovery_authorization_id,
    ]))
    .digest('hex');
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function timingSafeHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(String(left || '')) || !/^[0-9a-f]{64}$/i.test(String(right || ''))) return false;
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rpcRow(data) {
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

async function issueOtpChallenge(db, {
  challengeId: requestedChallengeId = null,
  email,
  phoneE164,
  channel: channelInput = OTP_CHANNEL_EMAIL,
  candidateId,
  clientId,
  roleId,
  submissionId = null,
  interviewAttemptId = null,
  recoveryAuthorizationId = null,
  deliveryState = 'pending',
  smsSelectionAt = null,
  consentCopyVersion = null,
  env = process.env,
}) {
  const channel = canonicalChannel(channelInput);
  const challengeId = requestedChallengeId == null
    ? crypto.randomUUID()
    : String(requestedChallengeId).trim().toLowerCase();
  if (!UUID_RE.test(challengeId)) throw new OtpChallengeError('INVALID_CHALLENGE_ID');
  const code = generateOtpCode();
  const binding = canonicalBinding({
    candidate_id: candidateId,
    client_id: clientId,
    role_id: roleId,
    submission_id: submissionId,
    interview_attempt_id: interviewAttemptId,
    recovery_authorization_id: recoveryAuthorizationId,
  });
  const version = Number(env.OTP_HMAC_SECRET_VERSION || OTP_PEPPER_VERSION);
  const verifier = verifierHmac({ challengeId, code, binding, channel, version, env });
  const deliveryDestination = channel === OTP_CHANNEL_SMS ? phoneE164 : email;
  const destination = destinationFingerprint(deliveryDestination, version, env, channel);
  const fingerprint = bindingFingerprint(binding, channel);

  if (channel === OTP_CHANNEL_SMS && (!smsSelectionAt || !String(consentCopyVersion || '').trim())) {
    throw new OtpChallengeError('SMS_CONSENT_EVIDENCE_REQUIRED');
  }

  const rpcName = channel === OTP_CHANNEL_SMS
    ? 'service_issue_sms_otp_challenge'
    : 'service_issue_otp_challenge';
  const rpcArgs = {
    p_challenge_id: challengeId,
    p_purpose: OTP_PURPOSE,
    ...(channel === OTP_CHANNEL_EMAIL ? { p_channel: channel } : {}),
    p_pepper_version: version,
    p_verifier_hmac_hex: verifier,
    p_binding_fingerprint: fingerprint,
    p_candidate_id: binding.candidate_id,
    p_client_id: binding.client_id,
    p_role_id: binding.role_id,
    p_submission_id: binding.submission_id || null,
    p_interview_attempt_id: binding.interview_attempt_id || null,
    p_recovery_authorization_id: binding.recovery_authorization_id || null,
    p_destination_fingerprint: destination,
    p_expires_in_seconds: OTP_CODE_TTL_SECONDS,
    p_max_attempts: OTP_MAX_ATTEMPTS,
    p_delivery_state: deliveryState,
    ...(channel === OTP_CHANNEL_SMS ? {
      p_sms_selection_at: smsSelectionAt,
      p_consent_copy_version: String(consentCopyVersion).trim(),
    } : {}),
  };
  const { data, error } = await db.rpc(rpcName, rpcArgs);
  if (error) throw new OtpChallengeError('OTP_CHALLENGE_CREATE_FAILED', error.message);
  const created = rpcRow(data);
  if (!created?.challenge_id || String(created.challenge_id) !== challengeId) {
    throw new OtpChallengeError('OTP_CHALLENGE_CREATE_FAILED', 'challenge creation was not confirmed');
  }
  return { challengeId, code, expiresAt: created.expires_at || null, binding, channel };
}

async function claimConsumedOtpRecovery(db, { challengeId, replacementChallengeId }) {
  const normalizedChallengeId = String(challengeId || '').trim().toLowerCase();
  const normalizedReplacementId = String(replacementChallengeId || '').trim().toLowerCase();
  if (!UUID_RE.test(normalizedChallengeId)
    || !UUID_RE.test(normalizedReplacementId)
    || normalizedChallengeId === normalizedReplacementId) {
    throw new OtpChallengeError('INVALID_CHALLENGE_ID');
  }
  const { data, error } = await db.rpc('service_claim_consumed_otp_recovery', {
    p_challenge_id: normalizedChallengeId,
    p_replacement_challenge_id: normalizedReplacementId,
  });
  if (error) throw new OtpChallengeError('OTP_RECOVERY_CLAIM_FAILED', error.message);
  return rpcRow(data)?.status === 'claimed';
}

async function getOtpChallengeContext(db, challengeId) {
  const normalized = String(challengeId || '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) return null;
  const { data, error } = await db.rpc('service_get_otp_challenge_context', { p_challenge_id: normalized });
  if (error) throw new OtpChallengeError('OTP_CHALLENGE_LOOKUP_FAILED', error.message);
  return rpcRow(data);
}

async function consumeOtpChallenge(db, { challengeId, code, env = process.env }) {
  const context = await getOtpChallengeContext(db, challengeId);
  if (!context) return { status: 'not_found' };
  const binding = canonicalBinding(context);
  let supplied;
  try {
    supplied = verifierHmac({
      challengeId,
      code,
      binding,
      channel: context.channel,
      version: Number(context.pepper_version),
      env,
    });
  } catch (error) {
    if (!(error instanceof OtpChallengeError) || error.code !== 'INVALID_OTP_CODE') throw error;
    supplied = '0'.repeat(64);
  }
  const verifierMatches = timingSafeHexEqual(context.verifier_hmac_hex, supplied);
  const { data, error } = await db.rpc('service_consume_otp_challenge', {
    p_challenge_id: String(challengeId).trim().toLowerCase(),
    p_verifier_matches: verifierMatches,
  });
  if (error) throw new OtpChallengeError('OTP_CHALLENGE_CONSUME_FAILED', error.message);
  return rpcRow(data) || { status: 'not_found' };
}

async function markOtpChallengeDelivery(db, challengeId, state) {
  const normalizedState = ['sent', 'failed'].includes(state) ? state : 'failed';
  const { error } = await db.rpc('service_mark_otp_challenge_delivery', {
    p_challenge_id: challengeId,
    p_delivery_state: normalizedState,
  });
  if (error) throw new OtpChallengeError('OTP_DELIVERY_STATE_FAILED', error.message);
}

const SMS_DELIVERY_METADATA_EVENTS = Object.freeze([
  'send_requested',
  'provider_accepted',
  'send_outcome',
]);
const SMS_DELIVERY_FAILURE_CATEGORIES = Object.freeze([
  'invalid_destination',
  'blocked_destination',
  'provider_rejected',
  'transient_preacceptance',
  'ambiguous_outcome',
  'misconfigured',
]);

function assertBoundedProvider(provider) {
  const value = String(provider || '');
  if (!/^[a-z0-9_-]{1,40}$/.test(value)) {
    throw new OtpChallengeError('INVALID_SMS_PROVIDER');
  }
  return value;
}

function assertBoundedProviderMessageId(messageId) {
  const value = String(messageId || '');
  if (!value.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OtpChallengeError('INVALID_SMS_PROVIDER_MESSAGE_ID');
  }
  return value;
}

function validateSmsDeliveryMetadataInput({ event, provider, providerMessageId, deliveryStatus, failureCategory }) {
  const normalizedEvent = String(event || '');
  const normalizedProvider = assertBoundedProvider(provider);
  if (!SMS_DELIVERY_METADATA_EVENTS.includes(normalizedEvent)) {
    throw new OtpChallengeError('INVALID_SMS_DELIVERY_EVENT');
  }
  if (normalizedEvent === 'send_requested') {
    if (providerMessageId != null || deliveryStatus != null || failureCategory != null) {
      throw new OtpChallengeError('INVALID_SMS_DELIVERY_METADATA');
    }
  } else if (normalizedEvent === 'provider_accepted') {
    assertBoundedProviderMessageId(providerMessageId);
    if (!['queued', 'sent'].includes(String(deliveryStatus || '')) || failureCategory != null) {
      throw new OtpChallengeError('INVALID_SMS_DELIVERY_METADATA');
    }
  } else {
    if (providerMessageId != null || !SMS_DELIVERY_FAILURE_CATEGORIES.includes(String(failureCategory || ''))) {
      throw new OtpChallengeError('INVALID_SMS_DELIVERY_METADATA');
    }
    const expectedStatus = ['invalid_destination', 'blocked_destination', 'provider_rejected'].includes(failureCategory)
      ? 'rejected'
      : failureCategory === 'ambiguous_outcome' ? null : 'failed';
    if (deliveryStatus !== expectedStatus) throw new OtpChallengeError('INVALID_SMS_DELIVERY_METADATA');
  }
  return { event: normalizedEvent, provider: normalizedProvider };
}

async function recordOtpSmsDeliveryMetadata(db, {
  challengeId,
  event,
  provider,
  providerMessageId = null,
  deliveryStatus = null,
  failureCategory = null,
}) {
  const normalizedChallengeId = String(challengeId || '').trim().toLowerCase();
  if (!UUID_RE.test(normalizedChallengeId)) throw new OtpChallengeError('INVALID_CHALLENGE_ID');
  const normalized = validateSmsDeliveryMetadataInput({
    event, provider, providerMessageId, deliveryStatus, failureCategory,
  });
  if (!db || typeof db.rpc !== 'function') throw new OtpChallengeError('OTP_SMS_DELIVERY_METADATA_FAILED');
  const { data, error } = await db.rpc('service_record_otp_sms_delivery_metadata', {
    p_challenge_id: normalizedChallengeId,
    p_event: normalized.event,
    p_provider: normalized.provider,
    p_provider_message_id: providerMessageId,
    p_delivery_status: deliveryStatus,
    p_failure_category: failureCategory,
  });
  if (error) {
    const code = String(error.code || '');
    if (['23505', '23514'].includes(code)) throw new OtpChallengeError('OTP_SMS_DELIVERY_METADATA_CONFLICT');
    throw new OtpChallengeError('OTP_SMS_DELIVERY_METADATA_FAILED');
  }
  const recorded = rpcRow(data);
  if (!recorded || String(recorded.challenge_id) !== normalizedChallengeId) {
    throw new OtpChallengeError('OTP_SMS_DELIVERY_METADATA_FAILED');
  }
  return Object.freeze({
    challengeId: recorded.challenge_id,
    provider: recorded.provider,
    providerMessageId: recorded.provider_message_id,
    deliveryStatus: recorded.provider_delivery_status,
    sendRequestedAt: recorded.send_requested_at,
    providerAcceptedAt: recorded.provider_accepted_at,
    failedAt: recorded.failed_at,
    failureCategory: recorded.failure_category,
  });
}

async function recordOtpSmsDeliveryEvent(db, {
  provider,
  providerMessageId,
  providerEventId,
  providerEventAt,
  deliveryStatus,
}) {
  const normalizedProvider = assertBoundedProvider(provider);
  assertBoundedProviderMessageId(providerMessageId);
  assertBoundedProviderMessageId(providerEventId);
  const normalizedEventAt = new Date(providerEventAt);
  if (!Number.isFinite(normalizedEventAt.getTime())) throw new OtpChallengeError('INVALID_SMS_DELIVERY_METADATA');
  if (!['queued', 'sent', 'delivered', 'failed', 'undelivered', 'rejected'].includes(String(deliveryStatus || ''))) {
    throw new OtpChallengeError('INVALID_SMS_DELIVERY_METADATA');
  }
  if (!db || typeof db.rpc !== 'function') throw new OtpChallengeError('OTP_SMS_DELIVERY_EVENT_FAILED');
  const { data, error } = await db.rpc('service_record_otp_sms_delivery_event', {
    p_provider: normalizedProvider,
    p_provider_message_id: providerMessageId,
    p_provider_event_id: providerEventId,
    p_provider_event_at: normalizedEventAt.toISOString(),
    p_delivery_status: deliveryStatus,
  });
  if (error) {
    if (String(error.code || '') === '23505') throw new OtpChallengeError('OTP_SMS_DELIVERY_EVENT_CONFLICT');
    throw new OtpChallengeError('OTP_SMS_DELIVERY_EVENT_FAILED');
  }
  const recorded = rpcRow(data);
  if (!recorded) return Object.freeze({ found: false, applied: false, replayed: false });
  return Object.freeze({
    found: true,
    challengeId: recorded.challenge_id,
    deliveryStatus: recorded.provider_delivery_status,
    providerEventId: recorded.last_provider_event_id,
    providerEventAt: recorded.last_provider_event_at,
    applied: recorded.applied === true,
    replayed: recorded.replayed === true,
  });
}

async function supersedeOtpChallenges(db, { candidateId, roleId, reason }) {
  const { data, error } = await db.rpc('service_supersede_otp_challenges', {
    p_candidate_id: candidateId,
    p_role_id: roleId,
    p_reason: String(reason || 'superseded').slice(0, 80),
  });
  if (error) throw new OtpChallengeError('OTP_CHALLENGE_SUPERSEDE_FAILED', error.message);
  return Number(data || 0);
}

module.exports = {
  OTP_CHANNEL_EMAIL,
  OTP_CHANNEL_SMS,
  OTP_CODE_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_PEPPER_VERSION,
  OTP_PURPOSE,
  OtpChallengeError,
  OtpConfigurationError,
  bindingFingerprint,
  canonicalChannel,
  canonicalBinding,
  claimConsumedOtpRecovery,
  consumeOtpChallenge,
  destinationFingerprint,
  generateOtpCode,
  getOtpChallengeContext,
  getOtpSecret,
  issueOtpChallenge,
  markOtpChallengeDelivery,
  recordOtpSmsDeliveryEvent,
  recordOtpSmsDeliveryMetadata,
  normalizeEmail,
  supersedeOtpChallenges,
  timingSafeHexEqual,
  validateSmsDeliveryMetadataInput,
  verifierHmac,
};
