'use strict';

const crypto = require('node:crypto');
const { normalizeCandidatePhoneIdentity } = require('./candidatePhone');
const {
  OTP_CODE_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_PEPPER_VERSION,
  destinationFingerprint,
  generateOtpCode,
  getOtpSecret,
  recordOtpSmsDeliveryEvent,
  timingSafeHexEqual,
  validateSmsDeliveryMetadataInput,
} = require('./otpChallenge');
const { createFakeSmsProvider } = require('./smsFakeProvider');
const { orchestrateOtpSmsDelivery } = require('./smsDeliveryOrchestrator');
const { isSmsDestinationSuppressed } = require('./smsOtpFoundation');
const {
  createProductionRateLimitGates,
  keyedSubject,
  readSmsProductionControlConfig,
} = require('./smsProductionControls');
const { lookupSmsLineType, readTelnyxLookupConfig } = require('./telnyxNumberLookup');
const { createTelnyxSmsProvider } = require('../clients/telnyx');

const RETAIL_SMS_CONSENT_COPY_VERSION = 'sms-consent-v2';
const RETAIL_SMS_VERIFICATION_METHOD = 'retail_signup_sms_otp_v1';
const SAFE_SMS_OUTCOMES = new Set([
  'accepted',
  'rejected',
  'transient_preacceptance',
  'ambiguous_outcome',
  'invalid_destination',
  'blocked_destination',
  'misconfigured',
]);

class RetailSmsVerificationError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'RetailSmsVerificationError';
    this.code = code;
    this.retryAfterSeconds = Math.max(0, Math.ceil(Number(options.retryAfterSeconds || 0)));
  }
}

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function rpcRow(data) {
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

function framed(fields) {
  return fields.map((value) => {
    const normalized = value == null ? '' : String(value);
    return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`;
  }).join('|');
}

function readRetailSmsConfiguration(env = process.env) {
  const environment = String(env.SMS_ENVIRONMENT || '').trim().toLowerCase();
  const provider = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  const consentCopyVersion = String(env.SMS_CONSENT_COPY_VERSION || '').trim();
  const uiEnabled = enabled(env.SMS_RETAIL_UI_ENABLED);
  const deliveryEnabled = enabled(env.SMS_ENABLED);
  const providerAllowed = provider === 'telnyx' && ['qa', 'production'].includes(environment)
    || provider === 'fake' && environment === 'local'
      && ['test', 'development'].includes(String(env.NODE_ENV || '').trim().toLowerCase());
  const safetyControlsRequired = provider === 'telnyx' && ['qa', 'production'].includes(environment);
  const safetyControlsValid = !safetyControlsRequired
    || (readSmsProductionControlConfig(env).valid && readTelnyxLookupConfig(env).valid);
  return Object.freeze({
    valid: uiEnabled && deliveryEnabled && providerAllowed
      && consentCopyVersion === RETAIL_SMS_CONSENT_COPY_VERSION && safetyControlsValid,
    environment,
    provider,
    consentCopyVersion,
    uiEnabled,
    deliveryEnabled,
  });
}

function createConfiguredRetailSmsProvider(config, env = process.env) {
  if (!config.valid) return null;
  if (config.provider === 'telnyx') return createTelnyxSmsProvider({ env });
  if (config.provider === 'fake') {
    return createFakeSmsProvider({
      environment: 'local',
      mode: String(env.SMS_FAKE_MODE || 'accepted').trim().toLowerCase(),
    });
  }
  return null;
}

function normalizeRetailPhone(value) {
  return normalizeCandidatePhoneIdentity(value, 'US');
}

function retailSmsVerifierHmac({ verificationId, purchaseIntentId, destinationFingerprint: fingerprint, code, version = OTP_PEPPER_VERSION, env = process.env }) {
  const normalizedCode = String(code || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(String(verificationId || ''))
    || !/^[0-9a-f-]{36}$/i.test(String(purchaseIntentId || ''))
    || !/^[0-9a-f]{64}$/.test(String(fingerprint || ''))
    || !/^\d{6}$/.test(normalizedCode)) {
    throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_INVALID_CODE');
  }
  return crypto.createHmac('sha256', getOtpSecret(version, env))
    .update(framed([
      'retail-sms-verifier',
      String(version),
      verificationId,
      purchaseIntentId,
      fingerprint,
      normalizedCode,
    ]))
    .digest('hex');
}

function createRetailSmsProductionControls({ db, env, intent, fingerprint, requestIp, lineLookup = lookupSmsLineType, rateLimiter = null }) {
  const config = readSmsProductionControlConfig(env);
  if (!config.valid) return null;
  const resourceFingerprint = keyedSubject(config.abuseSecret, 'retail-resource', intent.id, intent.selected_plan_key, intent.selected_billing_cadence);
  const reservationId = crypto.randomUUID();
  const rateLimitGates = createProductionRateLimitGates({
    config,
    candidateId: intent.id,
    clientId: 'retail-purchase',
    roleId: `${intent.selected_plan_key}:${intent.selected_billing_cadence}`,
    destinationFingerprint: fingerprint,
    requestIp,
    provider: config.provider,
    country: 'US',
    rateLimiter,
  });
  return Object.freeze({
    rateLimitGates,
    lookupLineType: () => lineLookup({ db, toE164: intent.phone_e164, destinationFingerprint: fingerprint, env }),
    spendGate: async () => {
      const { data, error } = await db.rpc('service_reserve_retail_sms_spend', {
        p_reservation_id: reservationId,
        p_reserved_cents: config.reservationCents,
        p_daily_cap_cents: config.dailyCapCents,
        p_provider: config.provider,
        p_country: 'US',
        p_destination_fingerprint: fingerprint,
        p_purchase_intent_id: intent.id,
        p_resource_fingerprint: resourceFingerprint,
      });
      const row = rpcRow(data);
      return Object.freeze({ allowed: !error && row?.allowed === true, reservationId });
    },
    releaseSpend: async (outcome) => {
      const { data, error } = await db.rpc('service_release_retail_sms_spend', {
        p_reservation_id: reservationId,
        p_outcome: outcome,
      });
      return !error && data === true;
    },
    finalizeSpend: async (outcome) => {
      const { data, error } = await db.rpc('service_finalize_retail_sms_spend', {
        p_reservation_id: reservationId,
        p_outcome: outcome,
      });
      return !error && data === true;
    },
  });
}

async function recordRetailSmsDeliveryMetadata(db, {
  challengeId,
  event,
  provider,
  providerMessageId = null,
  deliveryStatus = null,
  failureCategory = null,
}) {
  const normalized = validateSmsDeliveryMetadataInput({
    event,
    provider,
    providerMessageId,
    deliveryStatus,
    failureCategory,
  });
  const { data, error } = await db.rpc('service_record_retail_signup_sms_delivery_metadata', {
    p_verification_id: challengeId,
    p_event: normalized.event,
    p_provider: normalized.provider,
    p_provider_message_id: providerMessageId,
    p_delivery_status: deliveryStatus,
    p_failure_category: failureCategory,
  });
  if (error || data !== true) throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_UNAVAILABLE');
  return true;
}

async function invalidateRetailSmsVerification(db, purchaseIntentId, reason) {
  const { error } = await db.rpc('service_invalidate_retail_signup_sms_verifications', {
    p_purchase_intent_id: purchaseIntentId,
    p_reason: String(reason || 'superseded').slice(0, 80),
  });
  if (error) throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_UNAVAILABLE');
}

async function deliverRetailSignupSmsOtp({
  db,
  intent,
  requestIp = null,
  consentCopyVersion,
  env = process.env,
  now = () => new Date(),
  adapter = null,
  checkSuppressed = isSmsDestinationSuppressed,
  lineLookup = lookupSmsLineType,
  rateLimiter = null,
} = {}) {
  const config = readRetailSmsConfiguration(env);
  if (!config.valid || String(consentCopyVersion || '').trim() !== RETAIL_SMS_CONSENT_COPY_VERSION) {
    return Object.freeze({ outcome: 'misconfigured', challengeCreated: false, emailFallbackAvailable: true });
  }
  const phoneIdentity = normalizeRetailPhone(intent?.buyer_phone);
  if (!intent?.id || !phoneIdentity || phoneIdentity.phone_country_code !== 'US') {
    return Object.freeze({ outcome: 'invalid_destination', challengeCreated: false, emailFallbackAvailable: true });
  }

  const version = Number(env.OTP_HMAC_SECRET_VERSION || OTP_PEPPER_VERSION);
  const fingerprint = destinationFingerprint(phoneIdentity.phone_e164, version, env, 'sms');
  const configuredAdapter = adapter || createConfiguredRetailSmsProvider(config, env);
  if (!configuredAdapter) return Object.freeze({ outcome: 'misconfigured', challengeCreated: false, emailFallbackAvailable: true });

  const normalizedIntent = { ...intent, phone_e164: phoneIdentity.phone_e164, phone_country_code: 'US' };
  const productionControls = config.provider === 'telnyx'
    ? createRetailSmsProductionControls({ db, env, intent: normalizedIntent, fingerprint, requestIp, lineLookup, rateLimiter })
    : null;
  if (config.provider === 'telnyx' && !productionControls) {
    return Object.freeze({ outcome: 'misconfigured', challengeCreated: false, emailFallbackAvailable: true });
  }

  const verificationId = crypto.randomUUID();
  const code = generateOtpCode();
  const smsSelectionAt = now().toISOString();
  const expiresAt = new Date(now().getTime() + OTP_CODE_TTL_SECONDS * 1000).toISOString();
  const verifier = retailSmsVerifierHmac({
    verificationId,
    purchaseIntentId: intent.id,
    destinationFingerprint: fingerprint,
    code,
    version,
    env,
  });
  let issued = null;

  const result = await orchestrateOtpSmsDelivery({
    db,
    environment: config.environment,
    candidate: { id: intent.id, phone_e164: phoneIdentity.phone_e164, phone_country_code: 'US' },
    destinationFingerprint: fingerprint,
    authorizeAndBind: async () => ({
      valid: Boolean(intent.id && intent.selected_plan_key && intent.selected_billing_cadence),
    }),
    checkSuppressed: (value) => checkSuppressed(db, value, 'authentication'),
    ...(productionControls || {}),
    issueChallenge: async () => {
      const { data, error } = await db.rpc('service_issue_retail_signup_sms_verification', {
        p_verification_id: verificationId,
        p_purchase_intent_id: intent.id,
        p_destination_fingerprint: fingerprint,
        p_plan_key: intent.selected_plan_key,
        p_billing_cadence: intent.selected_billing_cadence,
        p_pepper_version: version,
        p_verifier_hmac_hex: verifier,
        p_sms_selection_at: smsSelectionAt,
        p_consent_copy_version: RETAIL_SMS_CONSENT_COPY_VERSION,
      });
      issued = rpcRow(data);
      if (error || !issued?.status) throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_UNAVAILABLE');
      if (issued.status === 'resend_cooldown') {
        throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_COOLDOWN', { retryAfterSeconds: issued.resend_after_seconds });
      }
      if (issued.status === 'hourly_limit') {
        throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_SEND_LIMIT', { retryAfterSeconds: issued.resend_after_seconds });
      }
      if (issued.status !== 'issued' || issued.verification_id !== verificationId) {
        throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_NOT_ELIGIBLE');
      }
      return Object.freeze({
        challengeId: verificationId,
        channel: 'sms',
        code,
        expiresAt: issued.expires_at || expiresAt,
        committed: true,
      });
    },
    adapter: configuredAdapter,
    allowNetwork: configuredAdapter.network === 'https' && ['qa', 'production'].includes(config.environment),
    recordMetadata: recordRetailSmsDeliveryMetadata,
    logger: {
      info(event, safe) {
        console.log(`[retail-sms] ${event}`, safe);
      },
    },
  });

  const outcome = SAFE_SMS_OUTCOMES.has(result.outcome) ? result.outcome : 'misconfigured';
  if (result.challengeCreated === true && !['accepted', 'ambiguous_outcome'].includes(outcome)) {
    await invalidateRetailSmsVerification(db, intent.id, `delivery_${result.failureCategory || outcome}`);
  }
  return Object.freeze({
    outcome,
    provider: result.provider || configuredAdapter.name,
    status: result.status || null,
    challengeCreated: result.challengeCreated === true,
    expiresAt: issued?.expires_at || expiresAt,
    retryAfterSeconds: Number(issued?.resend_after_seconds || 120),
    emailFallbackAvailable: outcome !== 'accepted',
  });
}

async function loadRetailSmsVerificationState(db, intent, env = process.env) {
  const phoneIdentity = normalizeRetailPhone(intent?.buyer_phone);
  if (!intent?.id || !phoneIdentity) {
    return Object.freeze({ available: false, verified: false, status: 'unverified', codeActive: false, expiresInSeconds: 0, resendCooldownSeconds: 0 });
  }
  const version = Number(env.OTP_HMAC_SECRET_VERSION || OTP_PEPPER_VERSION);
  const fingerprint = destinationFingerprint(phoneIdentity.phone_e164, version, env, 'sms');
  const { data, error } = await db.rpc('service_get_retail_signup_sms_verification', {
    p_purchase_intent_id: intent.id,
    p_destination_fingerprint: fingerprint,
  });
  if (error) throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_UNAVAILABLE');
  const row = rpcRow(data);
  const status = String(row?.status || 'unverified');
  const expiresAt = Date.parse(String(row?.expires_at || ''));
  return Object.freeze({
    available: true,
    verificationId: row?.verification_id || null,
    destinationFingerprint: fingerprint,
    verifierHmacHex: row?.verifier_hmac_hex || null,
    verified: row?.verified === true,
    status,
    codeActive: status === 'code_sent' && Number.isFinite(expiresAt) && expiresAt > Date.now(),
    expiresInSeconds: Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0,
    resendCooldownSeconds: Math.max(0, Math.ceil(Number(row?.resend_after_seconds || 0))),
  });
}

async function consumeRetailSignupSmsOtp({ db, intent, code, env = process.env }) {
  const state = await loadRetailSmsVerificationState(db, intent, env);
  if (!state.verificationId || !state.destinationFingerprint || !/^[0-9a-f]{64}$/.test(String(state.verifierHmacHex || ''))) {
    return Object.freeze({ status: 'invalid' });
  }
  const version = Number(env.OTP_HMAC_SECRET_VERSION || OTP_PEPPER_VERSION);
  const suppliedVerifier = retailSmsVerifierHmac({
    verificationId: state.verificationId,
    purchaseIntentId: intent.id,
    destinationFingerprint: state.destinationFingerprint,
    code,
    version,
    env,
  });
  const { data, error } = await db.rpc('service_consume_retail_signup_sms_verification', {
    p_verification_id: state.verificationId,
    p_verifier_matches: timingSafeHexEqual(state.verifierHmacHex, suppliedVerifier),
  });
  if (error) throw new RetailSmsVerificationError('RETAIL_SMS_VERIFICATION_UNAVAILABLE');
  return Object.freeze({ status: String(rpcRow(data)?.status || 'invalid') });
}

async function recordRetailSmsDeliveryEvent(db, {
  provider,
  providerMessageId,
  providerEventId,
  providerEventAt,
  deliveryStatus,
}) {
  const { data, error } = await db.rpc('service_record_retail_signup_sms_delivery_event', {
    p_provider: provider,
    p_provider_message_id: providerMessageId,
    p_provider_event_id: providerEventId,
    p_provider_event_at: providerEventAt,
    p_delivery_status: deliveryStatus,
  });
  if (error) throw new RetailSmsVerificationError('RETAIL_SMS_DELIVERY_EVENT_FAILED');
  const row = rpcRow(data);
  return Object.freeze({
    found: row?.found === true,
    challengeId: row?.verification_id || null,
    deliveryStatus: row?.provider_delivery_status || null,
    providerEventId: row?.last_provider_event_id || null,
    providerEventAt: row?.last_provider_event_at || null,
    applied: row?.applied === true,
    replayed: row?.replayed === true,
  });
}

async function recordAnyOtpSmsDeliveryEvent(db, event) {
  const candidate = await recordOtpSmsDeliveryEvent(db, event);
  if (candidate.found === true) return candidate;
  return recordRetailSmsDeliveryEvent(db, event);
}

module.exports = {
  OTP_MAX_ATTEMPTS,
  RETAIL_SMS_CONSENT_COPY_VERSION,
  RETAIL_SMS_VERIFICATION_METHOD,
  RetailSmsVerificationError,
  consumeRetailSignupSmsOtp,
  createConfiguredRetailSmsProvider,
  createRetailSmsProductionControls,
  deliverRetailSignupSmsOtp,
  invalidateRetailSmsVerification,
  loadRetailSmsVerificationState,
  normalizeRetailPhone,
  readRetailSmsConfiguration,
  recordAnyOtpSmsDeliveryEvent,
  recordRetailSmsDeliveryEvent,
  recordRetailSmsDeliveryMetadata,
  retailSmsVerifierHmac,
};
