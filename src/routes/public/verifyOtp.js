'use strict';

const crypto = require('crypto');
const express = require('express');
const Sentry = require('@sentry/node');
const { supabase, supabaseAdmin } = require('../../clients/supabase');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../../services/roleInterviewAvailability');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../../services/rateLimit');
const { isRoleInactive, buildRoleInactivePayload, logInactiveRoleBlocked } = require('../../services/roleLifecycle');
const { sendCandidateError } = require('../../services/candidateErrors');
const {
  claimConsumedOtpRecovery,
  consumeOtpChallenge,
  getOtpChallengeContext,
  issueOtpChallenge,
} = require('../../services/otpChallenge');
const { createEmailOtpDelivery } = require('../../services/otpDelivery');
const {
  deliverCandidateSmsOtp,
  normalizeConsentCopyVersion,
  readCandidateSmsConfiguration,
} = require('../../services/candidateSmsDelivery');
const {
  TTL_SECONDS: OTP_LAUNCH_CAPABILITY_TTL_SECONDS,
  setOtpLaunchCapability,
} = require('../../middleware/otpLaunchCapability');

const router = express.Router();
const BILLING_ENFORCED = String(process.env.BILLING_MODE || 'off').toLowerCase() === 'enforce';
const VERIFY_OTP_RATE_WINDOW_MS = 60 * 60 * 1000;
const VERIFY_OTP_RATE_MAX = 20;
const RESEND_OTP_RATE_WINDOW_MS = 60 * 60 * 1000;
const RESEND_OTP_RATE_MAX = 5;
const RESEND_OTP_MESSAGE = 'If your information is accepted, a new verification code will be sent shortly.';
const CONSUMED_CHALLENGE_RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deliverEmailOtp = createEmailOtpDelivery();

function installRateLimit(routeName, windowMs, maxCount) {
  return async function otpRateLimit(req, res, next) {
    try {
      const result = await checkAndIncrementRateLimit({
        routeName,
        subjectKey: getRequestSubjectKey(req),
        windowMs,
        maxCount,
      });
      if (!result.allowed) return sendCandidateError(res, 'RATE_LIMITED', { request_id: req.request_id || null });
    } catch (error) {
      console.error('[rate-limit] otp check failed', {
        route_name: routeName,
        request_id: req.request_id || null,
        code: error?.code || null,
      });
      return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id: req.request_id || null });
    }
    return next();
  };
}

const verifyOtpRateLimit = installRateLimit('verify_otp', VERIFY_OTP_RATE_WINDOW_MS, VERIFY_OTP_RATE_MAX);
const resendOtpRateLimit = installRateLimit('resend_otp', RESEND_OTP_RATE_WINDOW_MS, RESEND_OTP_RATE_MAX);

function verificationFailed(res, requestId, category) {
  console.warn('[verify-otp] verification_failed', { request_id: requestId, category });
  return res.status(400).json({
    error: 'verification_failed',
    code: 'VERIFICATION_FAILED',
    detail: 'Verification failed. Please check your code and try again.',
    ...(requestId ? { request_id: requestId } : {}),
  });
}

function isConsumedChallengeInRecoveryWindow(context, now = Date.now()) {
  if (!context?.consumed_at || context.superseded_at) return false;
  const consumedAt = Date.parse(String(context.consumed_at));
  return Number.isFinite(consumedAt)
    && consumedAt <= now
    && now - consumedAt <= CONSUMED_CHALLENGE_RECOVERY_WINDOW_MS;
}

async function loadBoundCandidateAndRole(context) {
  const [{ data: candidate, error: candidateError }, { data: role, error: roleError }] = await Promise.all([
    supabase.from('candidates').select('id,role_id,client_id,email,phone_e164,phone_country_code').eq('id', context.candidate_id).maybeSingle(),
    supabase.from('roles').select('id,client_id,status').eq('id', context.role_id).maybeSingle(),
  ]);
  if (candidateError || roleError) throw candidateError || roleError;
  if (!candidate || !role
    || String(candidate.role_id || '') !== String(context.role_id || '')
    || String(candidate.client_id || '') !== String(context.client_id || '')
    || String(role.client_id || '') !== String(context.client_id || '')) return null;
  return { candidate, role };
}

async function enforceCurrentInterviewEligibility({ role, requestId, res, routeName }) {
  if (isRoleInactive(role)) {
    logInactiveRoleBlocked(console, { route_name: routeName, request_id: requestId, role_id: role.id });
    res.status(403).json(buildRoleInactivePayload(requestId));
    return false;
  }

  if (BILLING_ENFORCED && role.client_id) {
    const { data: client, error } = await supabase
      .from('clients')
      .select('id,billing_status,access_override_mode,candidate_assistance_contact')
      .eq('id', role.client_id)
      .maybeSingle();
    if (error || !client) throw error || new Error('client lookup failed');
    const override = String(client.access_override_mode || 'inherit').toLowerCase();
    if (override === 'force_inactive' || (override !== 'force_active' && client.billing_status !== 'active')) {
      res.status(403).json({
        error: 'forbidden',
        code: 'CLIENT_INACTIVE',
        detail: 'Interviewing service is currently inactive for this employer.',
        hint: client.candidate_assistance_contact || 'Please contact the employer.',
        request_id: requestId,
      });
      return false;
    }
  }

  const availability = await getRoleInterviewAvailability({ db: supabaseAdmin, roleId: role.id, clientId: role.client_id || null });
  await syncRoleInterviewLimitNotification({
    db: supabaseAdmin,
    roleId: role.id,
    clientId: role.client_id || null,
    remainingInterviews: availability.remaining_interviews,
    roleTitle: '',
  });
  if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
    res.status(403).json({
      error: 'forbidden',
      code: 'interview_limit_reached',
      detail: 'This role has no interviews remaining under the current plan.',
      hint: null,
      request_id: requestId,
    });
    return false;
  }
  return true;
}

function queueResendDelivery({ challengeId, code, destination, candidateId, roleId, requestId }) {
  setImmediate(async () => {
    try {
      await deliverEmailOtp({ db: supabaseAdmin, challengeId, destination, code });
      console.log('[resend-otp] delivery_succeeded', {
        request_id: requestId,
        candidate_id: candidateId,
        role_id: roleId,
        channel: 'email',
      });
    } catch (error) {
      console.warn('[resend-otp] delivery_failed', {
        request_id: requestId,
        candidate_id: candidateId,
        role_id: roleId,
        channel: 'email',
        status: error?.response?.status || error?.code || null,
      });
      Sentry.captureException(error, {
        tags: {
          route_name: 'resend_otp',
          surface: 'backend',
          request_id: requestId || undefined,
          candidate_id: candidateId || undefined,
          role_id: roleId || undefined,
          otp_channel: 'email',
        },
        extra: { request_id: requestId, candidate_id: candidateId, role_id: roleId },
      });
    }
  });
}

router.post('/resend', resendOtpRateLimit, async (req, res) => {
  const requestId = req.request_id || null;
  Sentry.setTag('route_name', 'resend_otp');
  Sentry.setTag('surface', 'backend');
  if (requestId) Sentry.setTag('request_id', String(requestId));
  const generic = (challengeId = null, extra = {}) => res.status(200).json({
    message: RESEND_OTP_MESSAGE,
    ...(challengeId ? { challenge_id: challengeId } : {}),
    ...extra,
  });

  try {
    const challengeId = String(req.body?.challenge_id || '').trim().toLowerCase();
    if (!UUID_RE.test(challengeId)) return generic();
    const context = await getOtpChallengeContext(supabaseAdmin, challengeId);
    if (!context || context.superseded_at) return generic();
    const replacingConsumedChallenge = Boolean(context.consumed_at);
    if (replacingConsumedChallenge && !isConsumedChallengeInRecoveryWindow(context)) return generic();
    const bound = await loadBoundCandidateAndRole(context);
    if (!bound) return generic();
    if (!(await enforceCurrentInterviewEligibility({ role: bound.role, requestId, res, routeName: 'resend_otp' }))) return;

    const requestedChannel = String(req.body?.channel || 'email').trim().toLowerCase();
    if (!['email', 'sms'].includes(requestedChannel)) return generic();

    let consentCopyVersion = null;
    if (requestedChannel === 'sms') {
      consentCopyVersion = normalizeConsentCopyVersion(req.body?.consent_copy_version);
      if (!readCandidateSmsConfiguration(process.env).valid || !consentCopyVersion) {
        return generic(null, {
          delivery_channel: 'sms',
          delivery_outcome: 'misconfigured',
          email_fallback_available: true,
        });
      }
    }

    const replacementChallengeId = replacingConsumedChallenge ? crypto.randomUUID() : null;
    if (replacingConsumedChallenge) {
      const claimed = await claimConsumedOtpRecovery(supabaseAdmin, {
        challengeId,
        replacementChallengeId,
      });
      if (!claimed) return generic();
    }

    if (requestedChannel === 'sms') {
      const smsDelivery = await deliverCandidateSmsOtp({
        db: supabaseAdmin,
        challengeId: replacementChallengeId,
        candidate: bound.candidate,
        clientId: context.client_id,
        roleId: context.role_id,
        submissionId: context.submission_id,
        interviewAttemptId: context.interview_attempt_id,
        recoveryAuthorizationId: context.recovery_authorization_id,
        consentCopyVersion,
        requestIp: getRequestSubjectKey(req),
      });
      return generic(smsDelivery.challengeId, {
        delivery_channel: 'sms',
        delivery_outcome: smsDelivery.outcome,
        email_fallback_available: smsDelivery.emailFallbackAvailable,
      });
    }

    const challenge = await issueOtpChallenge(supabaseAdmin, {
      challengeId: replacementChallengeId,
      email: bound.candidate.email,
      candidateId: context.candidate_id,
      clientId: context.client_id,
      roleId: context.role_id,
      submissionId: context.submission_id,
      interviewAttemptId: context.interview_attempt_id,
      recoveryAuthorizationId: context.recovery_authorization_id,
    });
    generic(challenge.challengeId, {
      delivery_channel: 'email',
      delivery_outcome: 'accepted',
      email_fallback_available: false,
    });
    queueResendDelivery({
      challengeId: challenge.challengeId,
      code: challenge.code,
      destination: bound.candidate.email,
      candidateId: context.candidate_id,
      roleId: context.role_id,
      requestId,
    });
  } catch (error) {
    console.error('[resend-otp] request_failed', { request_id: requestId, code: error?.code || null });
    Sentry.captureException(error, {
      tags: { route_name: 'resend_otp', surface: 'backend', request_id: requestId || undefined },
      extra: { request_id: requestId },
    });
    return res.status(500).json({
      error: 'server_error',
      code: 'RESEND_OTP_FAILED',
      detail: 'Unable to resend verification code at this time.',
      request_id: requestId,
    });
  }
});

router.post('/', verifyOtpRateLimit, async (req, res) => {
  const requestId = req.request_id || null;
  let context = null;
  Sentry.setTag('route_name', 'verify_otp');
  Sentry.setTag('surface', 'backend');
  if (requestId) Sentry.setTag('request_id', String(requestId));

  try {
    const challengeId = String(req.body?.challenge_id || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!UUID_RE.test(challengeId) || !/^\d{6}$/.test(code)) return verificationFailed(res, requestId, 'invalid_request');

    context = await getOtpChallengeContext(supabaseAdmin, challengeId);
    if (!context) return verificationFailed(res, requestId, 'challenge_not_found');
    const bound = await loadBoundCandidateAndRole(context);
    if (!bound) return verificationFailed(res, requestId, 'binding_invalid');
    if (!(await enforceCurrentInterviewEligibility({ role: bound.role, requestId, res, routeName: 'verify_otp' }))) return;

    const result = await consumeOtpChallenge(supabaseAdmin, { challengeId, code });
    if (result.status === 'expired') return sendCandidateError(res, 'OTP_EXPIRED', { request_id: requestId });
    if (result.status === 'consumed') return sendCandidateError(res, 'OTP_USED', { request_id: requestId });
    if (result.status === 'superseded') return sendCandidateError(res, 'STALE_ACCESS_INVALIDATED', { request_id: requestId });
    if (result.status !== 'verified') return verificationFailed(res, requestId, result.status || 'invalid');

    const launchCapability = setOtpLaunchCapability(res, {
      challenge_id: result.challenge_id,
      candidate_id: result.candidate_id,
      client_id: result.client_id,
      role_id: result.role_id,
      submission_id: result.submission_id,
      interview_attempt_id: result.interview_attempt_id,
      request_origin: req.headers.origin,
    });
    console.log('[verify-otp] verification_succeeded', {
      request_id: requestId,
      candidate_id: result.candidate_id,
      role_id: result.role_id,
      channel: context.channel || 'email',
    });
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      message: 'Verified',
      verified: true,
      launch_capability: launchCapability,
      launch_capability_expires_in_seconds: OTP_LAUNCH_CAPABILITY_TTL_SECONDS,
      candidate_id: result.candidate_id,
      role_id: result.role_id,
      email: bound.candidate.email,
      channel: context.channel || 'email',
    });
  } catch (error) {
    console.error('[verify-otp] request_failed', { request_id: requestId, code: error?.code || null });
    Sentry.captureException(error, {
      tags: {
        route_name: 'verify_otp',
        surface: 'backend',
        request_id: requestId || undefined,
        candidate_id: context?.candidate_id || undefined,
        role_id: context?.role_id || undefined,
        client_id: context?.client_id || undefined,
      },
      extra: {
        request_id: requestId,
        candidate_id: context?.candidate_id || null,
        role_id: context?.role_id || null,
        client_id: context?.client_id || null,
      },
    });
    return res.status(500).json({ error: 'Server error', code: 'OTP_VERIFICATION_FAILED', request_id: requestId });
  }
});

module.exports = router;
