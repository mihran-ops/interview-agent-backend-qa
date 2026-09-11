'use strict';

const {
  destinationFingerprint,
  issueOtpChallenge,
} = require('./otpChallenge');
const { orchestrateOtpSmsDelivery } = require('./smsDeliveryOrchestrator');
const { isSmsDestinationSuppressed } = require('./smsOtpFoundation');
const { createFakeSmsProvider } = require('./smsFakeProvider');
const { createSmsProductionControls, readSmsProductionControlConfig } = require('./smsProductionControls');
const { readTelnyxLookupConfig } = require('./telnyxNumberLookup');
const { createTelnyxSmsProvider } = require('../clients/telnyx');

const SMS_CONSENT_COPY_VERSION = 'sms-consent-v2';
const SAFE_SMS_OUTCOMES = Object.freeze([
  'accepted',
  'rejected',
  'transient_preacceptance',
  'ambiguous_outcome',
  'invalid_destination',
  'blocked_destination',
  'misconfigured',
]);

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function readCandidateSmsConfiguration(env = process.env) {
  const environment = String(env.SMS_ENVIRONMENT || '').trim().toLowerCase();
  const provider = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  const consentCopyVersion = String(env.SMS_CONSENT_COPY_VERSION || '').trim();
  const uiEnabled = enabled(env.SMS_CANDIDATE_UI_ENABLED);
  const deliveryEnabled = enabled(env.SMS_ENABLED);
  const providerAllowed = provider === 'telnyx' && ['qa', 'production'].includes(environment)
    || provider === 'fake' && environment === 'local'
      && ['test', 'development'].includes(String(env.NODE_ENV || '').trim().toLowerCase());
  const safetyControlsRequired = provider === 'telnyx' && ['qa', 'production'].includes(environment);
  const safetyControlsValid = !safetyControlsRequired
    || (readSmsProductionControlConfig(env).valid && readTelnyxLookupConfig(env).valid);
  return Object.freeze({
    valid: uiEnabled && deliveryEnabled && providerAllowed
      && consentCopyVersion === SMS_CONSENT_COPY_VERSION && safetyControlsValid,
    environment,
    provider,
    consentCopyVersion,
    uiEnabled,
    deliveryEnabled,
  });
}

function createConfiguredSmsProvider(config, env = process.env) {
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

function normalizeConsentCopyVersion(value) {
  return String(value || '').trim() === SMS_CONSENT_COPY_VERSION
    ? SMS_CONSENT_COPY_VERSION
    : null;
}

async function deliverCandidateSmsOtp({
  db,
  challengeId = null,
  candidate,
  clientId,
  roleId,
  submissionId = null,
  interviewAttemptId = null,
  recoveryAuthorizationId = null,
  requestIp = null,
  consentCopyVersion,
  env = process.env,
  now = () => new Date(),
  adapter = null,
  issueChallenge = issueOtpChallenge,
  checkSuppressed = isSmsDestinationSuppressed,
  recordMetadata,
} = {}) {
  const config = readCandidateSmsConfiguration(env);
  const acceptedConsentVersion = normalizeConsentCopyVersion(consentCopyVersion);
  if (!config.valid || !acceptedConsentVersion) {
    return Object.freeze({
      outcome: 'misconfigured',
      challengeCreated: false,
      challengeId: null,
      emailFallbackAvailable: true,
    });
  }
  if (!candidate?.id
    || !/^\+1\d{10}$/.test(String(candidate.phone_e164 || ''))
    || String(candidate.phone_country_code || '').trim().toUpperCase() !== 'US') {
    return Object.freeze({
      outcome: 'invalid_destination',
      challengeCreated: false,
      challengeId: null,
      emailFallbackAvailable: true,
    });
  }

  const configuredAdapter = adapter || createConfiguredSmsProvider(config, env);
  if (!configuredAdapter) {
    return Object.freeze({
      outcome: 'misconfigured',
      challengeCreated: false,
      challengeId: null,
      emailFallbackAvailable: true,
    });
  }

  const fingerprint = destinationFingerprint(candidate?.phone_e164, undefined, env, 'sms');
  const productionControls = config.provider === 'telnyx'
    ? createSmsProductionControls({
      db,
      env,
      candidate,
      clientId,
      roleId,
      destinationFingerprint: fingerprint,
      requestIp,
    })
    : null;
  if (config.provider === 'telnyx' && !productionControls) {
    return Object.freeze({
      outcome: 'misconfigured',
      challengeCreated: false,
      challengeId: null,
      emailFallbackAvailable: true,
    });
  }
  const smsSelectionAt = now().toISOString();
  let issued = null;
  const result = await orchestrateOtpSmsDelivery({
    db,
    environment: config.environment,
    candidate,
    destinationFingerprint: fingerprint,
    authorizeAndBind: async () => ({
      valid: Boolean(candidate?.id && clientId && roleId),
    }),
    checkSuppressed: (value) => checkSuppressed(db, value, 'authentication'),
    ...(productionControls || {}),
    issueChallenge: async () => {
      issued = await issueChallenge(db, {
        challengeId,
        phoneE164: candidate.phone_e164,
        channel: 'sms',
        candidateId: candidate.id,
        clientId,
        roleId,
        submissionId,
        interviewAttemptId,
        recoveryAuthorizationId,
        deliveryState: 'pending',
        smsSelectionAt,
        consentCopyVersion: acceptedConsentVersion,
        env,
      });
      return Object.freeze({ ...issued, committed: true });
    },
    adapter: configuredAdapter,
    allowNetwork: configuredAdapter.network === 'https' && ['qa', 'production'].includes(config.environment),
    ...(recordMetadata ? { recordMetadata } : {}),
    logger: {
      info(event, safe) {
        console.log(`[candidate-sms] ${event}`, safe);
      },
    },
  });
  const outcome = SAFE_SMS_OUTCOMES.includes(result.outcome) ? result.outcome : 'misconfigured';
  return Object.freeze({
    outcome,
    challengeCreated: result.challengeCreated === true,
    challengeId: issued?.challengeId || null,
    emailFallbackAvailable: outcome !== 'accepted',
  });
}

module.exports = {
  SAFE_SMS_OUTCOMES,
  SMS_CONSENT_COPY_VERSION,
  createConfiguredSmsProvider,
  deliverCandidateSmsOtp,
  normalizeConsentCopyVersion,
  readCandidateSmsConfiguration,
};
