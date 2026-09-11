// routes/createTavusInterview.js
'use strict';

const express = require('express');
const Sentry = require('@sentry/node');
const { supabase, supabaseAdmin } = require('../../clients/supabase');
const { createTavusInterviewHandler } = require('../../services/tavusInterview');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../../services/roleInterviewAvailability');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../../services/rateLimit');
const { isRoleInactive, buildRoleInactivePayload, logInactiveRoleBlocked } = require('../../services/roleLifecycle');
const { sendCandidateError } = require('../../services/candidateErrors');
const {
  claimInterviewAttempt,
  completeRecoveryStart,
  recordVendorBindingFailure,
} = require('../../services/interviewAttemptService');
const { resolvePublicBackendBase } = require('../../config/urlConfig');
const { normalizePrimitiveString, normalizeUuid } = require('../../services/strictRequestValidation');
const { validateConfiguredInterviewDuration } = require('../../services/interviewDuration');
const { resolvePlanCapacityForClient } = require('../../services/planCapacity');
const { buildAuthenticatedTavusWebhookUrl } = require('../../services/tavusWebhookAuth');
const {
  clearOtpLaunchCapability,
  requireOtpLaunchCapability,
} = require('../../middleware/otpLaunchCapability');

const router = express.Router();
const BILLING_MODE = String(process.env.BILLING_MODE || 'off').toLowerCase();
const BILLING_ENFORCED = BILLING_MODE === 'enforce';
const CREATE_TAVUS_RATE_WINDOW_MS = 15 * 60 * 1000;
const CREATE_TAVUS_RATE_MAX = 10;

async function createTavusRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'create_tavus_interview',
      subjectKey: getRequestSubjectKey(req),
      windowMs: CREATE_TAVUS_RATE_WINDOW_MS,
      maxCount: CREATE_TAVUS_RATE_MAX
    });
    if (!result.allowed) {
      return sendCandidateError(res, 'RATE_LIMITED', { request_id: req.request_id || null });
    }
  } catch (error) {
    console.error('[rate-limit] create tavus interview check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id: req.request_id || null });
  }
  return next();
}

router.post('/', requireOtpLaunchCapability, createTavusRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  Sentry.setTag('route_name', 'create_tavus_interview');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const launchFailed = (reason, details = {}) => {
      console.warn('[create-tavus-interview] launch_failed', {
        request_id,
        reason,
        ...details
      });
      const payload = {
        error: 'launch_failed',
        code: 'LAUNCH_FAILED',
        detail: 'We could not start this interview. Please restart from the interview link and try again.'
      };
      if (request_id) payload.request_id = request_id;
      return res.status(400).json(payload);
    };
    const computedBase = `${req.protocol}://${req.get('host')}`;
    const base = resolvePublicBackendBase(computedBase);

    const {
      candidate_id: candidateIdRaw,
      role_id: roleIdFromBodyRaw,
      roleToken,
      role_token
    } = req.body || {};
    const candidate_id = normalizeUuid(candidateIdRaw);
    const roleIdFromBody = normalizeUuid(roleIdFromBodyRaw, { required: false });
    const roleTokenValue = roleToken !== undefined ? roleToken : role_token;
    const roleTokenFromBody = normalizePrimitiveString(roleTokenValue, {
      required: false,
      maxCodePoints: 200,
      maxBytes: 200,
    });
    if (candidate_id === null) {
      return res.status(400).json({ error: 'bad_request', code: 'INVALID_CANDIDATE_ID', detail: 'candidate_id must be a UUID.', request_id });
    }
    if (roleIdFromBody === null) {
      return res.status(400).json({ error: 'bad_request', code: 'INVALID_ROLE_ID', detail: 'role_id must be a UUID.', request_id });
    }
    if (roleTokenFromBody === null || (roleTokenFromBody && !/^[A-Za-z0-9_-]+$/.test(roleTokenFromBody))) {
      return res.status(400).json({ error: 'bad_request', code: 'INVALID_ROLE_TOKEN', detail: 'role token is invalid.', request_id });
    }
    if (roleToken !== undefined && role_token !== undefined
      && (typeof roleToken !== 'string' || typeof role_token !== 'string' || roleToken.trim() !== role_token.trim())) {
      return res.status(400).json({ error: 'bad_request', code: 'INVALID_ROLE_TOKEN', detail: 'role token is invalid.', request_id });
    }
    sentryCandidateId = candidate_id;
    Sentry.setTag('candidate_id', candidate_id);

    // candidate
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', candidate_id)
      .single();
    if (cErr || !candidate) {
      return launchFailed('candidate_not_found', {
        candidate_id,
        error: cErr?.message || null,
        code: cErr?.code || null
      });
    }
    Sentry.addBreadcrumb({
      category: 'create_tavus_interview',
      message: 'candidate loaded',
      level: 'info',
      data: { candidate_id }
    });

    const candidateRoleId = String(candidate?.role_id || '').trim();
    const candidateClientId = String(candidate?.client_id || '').trim();
    if (String(req.otp_launch_capability?.client_id || '') !== candidateClientId) {
      clearOtpLaunchCapability(res);
      return launchFailed('otp_launch_client_mismatch', { candidate_id });
    }
    let role = null;
    let roleId = String(roleIdFromBody || '').trim();

    if (roleTokenFromBody) {
      const { data: roleByToken, error: rtErr } = await supabase
        .from('roles')
        .select('*')
        .eq('slug_or_token', roleTokenFromBody)
        .limit(1)
        .maybeSingle();
      if (rtErr) {
        return res.status(500).json({ error: rtErr.message });
      }
      if (!roleByToken) {
        return launchFailed('role_token_not_found', {
          role_token: roleTokenFromBody
        });
      }
      if (String(roleByToken.id || '') !== candidateRoleId) {
        return launchFailed('candidate_role_mismatch', {
          candidate_id,
          role_id: roleByToken.id || null
        });
      }
      role = roleByToken;
      roleId = String(roleByToken.id || '').trim();
    }
    sentryRoleId = roleId || candidateRoleId || null;
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));

    if (roleId && roleId !== candidateRoleId) {
      return launchFailed('candidate_role_mismatch', {
        candidate_id,
        role_id: roleId
      });
    }

    if (!roleId && !roleTokenFromBody && candidateRoleId) {
      roleId = candidateRoleId;
    }

    if (!role) {
      if (!roleId) {
        return launchFailed('missing_role_binding_context', {
          candidate_id,
          candidate_role_id: candidateRoleId || null
        });
      }
      const { data: roleById, error: rErr } = await supabase
        .from('roles')
        .select('*')
        .eq('id', roleId)
        .single();
      if (rErr || !roleById) {
        return launchFailed('role_id_not_found', {
          candidate_id,
          role_id: roleId,
          error: rErr?.message || null,
          code: rErr?.code || null
        });
      }
      role = roleById;
    }
    sentryRoleId = String(role?.id || roleId || '').trim() || null;
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));
    Sentry.addBreadcrumb({
      category: 'create_tavus_interview',
      message: 'role loaded',
      level: 'info',
      data: { role_id: sentryRoleId }
    });

    if (String(role?.id || '') !== candidateRoleId) {
      return launchFailed('candidate_role_mismatch', {
        candidate_id,
        role_id: role?.id || null
      });
    }

    if (candidateClientId && String(role?.client_id || '').trim() && String(role.client_id || '').trim() !== candidateClientId) {
      return launchFailed('candidate_client_mismatch', {
        candidate_id,
        candidate_client_id: candidateClientId || null,
        role_client_id: role?.client_id || null
      });
    }

    if (isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'create_tavus_interview',
        request_id,
        role_id: role?.id || roleId || null
      });
      return res.status(403).json(buildRoleInactivePayload(request_id));
    }

    const clientId = role.client_id || candidate.client_id || null;
    sentryClientId = clientId || null;
    if (sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    if (!clientId) {
      return launchFailed('missing_role_binding_context', {
        candidate_id,
        role_id: role?.id || roleId || null
      });
    }
    let candidateAssistanceContact = '';
    let maxInterviewMinutes = null;
    try {
      let planCapacity;
      try {
        planCapacity = await resolvePlanCapacityForClient({
          db: supabaseAdmin,
          clientId,
        });
      } catch (capacityError) {
        console.warn('[create-tavus-interview] duration_preflight_blocked', {
          request_id,
          reason: capacityError?.code || 'invalid_membership_level',
        });
        if (capacityError?.code === 'PLAN_CAPACITY_LOOKUP_FAILED') {
          return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id });
        }
        return sendCandidateError(res, 'INTERVIEW_DURATION_NOT_CONFIGURED', {
          request_id,
          retryable: false,
        });
      }
      const duration = validateConfiguredInterviewDuration(planCapacity.max_interview_minutes);
      if (!duration.ok) {
        console.warn('[create-tavus-interview] duration_preflight_blocked', {
          request_id,
          reason: duration.reason,
        });
        return sendCandidateError(res, 'INTERVIEW_DURATION_NOT_CONFIGURED', {
          request_id,
          retryable: false,
        });
      }
      maxInterviewMinutes = duration.minutes;
    } catch (_) {
      console.warn('[create-tavus-interview] duration_preflight_blocked', {
        request_id,
        reason: 'lookup_exception',
      });
      return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id });
    }
    if (BILLING_ENFORCED) {
      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .select('id,billing_status,manual_active_override,access_override_mode,candidate_assistance_contact')
        .eq('id', clientId)
        .maybeSingle();

      if (clientErr || !client) {
        return res.status(500).json({
          error: 'server_error',
          code: 'CLIENT_LOOKUP_FAILED',
          detail: clientErr?.message || 'Failed to load client record',
          hint: clientErr?.hint || null,
          request_id
        });
      }
      Sentry.addBreadcrumb({
        category: 'create_tavus_interview',
        message: 'client loaded',
        level: 'info',
        data: { client_id: clientId }
      });
      const accessOverrideMode = String(client.access_override_mode || 'inherit').toLowerCase();
      if (accessOverrideMode === 'force_inactive' || (accessOverrideMode !== 'force_active' && client.billing_status !== 'active')) {
        return res.status(403).json({
          error: 'forbidden',
          code: 'CLIENT_INACTIVE',
          detail: 'Interviewing service is currently inactive for this employer.',
          hint: client.candidate_assistance_contact || 'Please contact the employer.',
          request_id
        });
      }
      candidateAssistanceContact = String(client.candidate_assistance_contact || '').trim();
    } else {
      try {
        const { data: client } = await supabase
          .from('clients')
          .select('candidate_assistance_contact')
          .eq('id', clientId)
          .maybeSingle();
        candidateAssistanceContact = String(client?.candidate_assistance_contact || '').trim();
      } catch {}
    }

    const availability = await getRoleInterviewAvailability({
      db: supabaseAdmin,
      roleId,
      clientId
    });
    await syncRoleInterviewLimitNotification({
      db: supabaseAdmin,
      roleId,
      clientId,
      remainingInterviews: availability.remaining_interviews,
      roleTitle: role?.title || ''
    });
    if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
      Sentry.addBreadcrumb({
        category: 'create_tavus_interview',
        message: 'interview limit reached',
        level: 'info',
        data: { role_id: roleId, client_id: clientId }
      });
      return res.status(403).json({
        error: 'forbidden',
        code: 'interview_limit_reached',
        detail: 'This role has no interviews remaining under the current plan.',
        hint: null,
        request_id
      });
    }

    const webhookUrl = buildAuthenticatedTavusWebhookUrl(`${base}/webhook/tavus`);
    let startingInterview;
    try {
      const claimed = await claimInterviewAttempt(supabaseAdmin, {
        candidateId: candidate_id,
        roleId,
        clientId,
      });
      startingInterview = {
        id: claimed.interview_id,
        attempt_number: claimed.attempt_number,
        authorized_replacement: claimed.authorized_replacement === true,
        authorization_id: claimed.recovery_authorization_id || null,
        claim_token: claimed.vendor_claim_token || null,
        external_reference: claimed.vendor_external_reference || null,
        claim_state: claimed.claim_state || null,
      };
      if (claimed.start_claimed === false) {
        const reconciliationRequired = ['replacement_reconciliation_required', 'replacement_reconciling']
          .includes(String(claimed.claim_state || ''));
        const manualReview = String(claimed.claim_state || '') === 'replacement_manual_review';
        const bindingRecoveryRequired = String(claimed.claim_state || '') === 'replacement_binding_recovery_required';
        return res.status(reconciliationRequired || manualReview || bindingRecoveryRequired ? 503 : 409).json({
          error: bindingRecoveryRequired ? 'vendor_binding_recovery_required'
            : (manualReview ? 'vendor_reconciliation_manual_review'
              : (reconciliationRequired ? 'vendor_reconciliation_required' : 'replacement_start_in_progress')),
          code: bindingRecoveryRequired ? 'VENDOR_BINDING_RECOVERY_REQUIRED'
            : (manualReview ? 'VENDOR_RECONCILIATION_MANUAL_REVIEW'
              : (reconciliationRequired ? 'VENDOR_RECONCILIATION_REQUIRED' : 'REPLACEMENT_START_IN_PROGRESS')),
          detail: bindingRecoveryRequired
            ? 'The interview provider succeeded, but support must finish linking the interview. Please do not retry.'
            : (manualReview
            ? 'The interview start requires support review. Please do not retry.'
            : (reconciliationRequired
              ? 'The interview start is being verified. Please do not retry yet.'
              : 'The approved replacement interview is already starting.')),
          request_id,
          interview_id: claimed.interview_id,
        });
      }
    } catch (claimError) {
      return res.status(claimError.status || 503).json({
        error: claimError.code || 'temporary_service_error',
        code: claimError.code || 'TEMPORARY_SERVICE_ERROR',
        detail: claimError.message,
        request_id,
      });
    }

    // Tavus
    Sentry.addBreadcrumb({
      category: 'create_tavus_interview',
      message: 'tavus launch started',
      level: 'info',
      data: { candidate_id, role_id: roleId, client_id: clientId }
    });
    let result;
    try {
      result = await createTavusInterviewHandler(candidate, role, webhookUrl, {
        maxInterviewMinutes,
        interviewId: startingInterview.id,
      });
    } catch (error) {
      const failureCategory = error?.failureCategory === 'definite_pre_acceptance'
        ? 'definite_pre_acceptance'
        : 'ambiguous_acceptance';
      if (startingInterview.authorized_replacement && startingInterview.authorization_id) {
        try {
          await completeRecoveryStart(supabaseAdmin, {
            interviewId: startingInterview.id,
            authorizationId: startingInterview.authorization_id,
            success: false,
            failureCode: String(error?.code || 'INTERVIEW_VENDOR_START_FAILED').slice(0, 100),
            failureCategory,
            externalReference: result?.vendor_external_reference || startingInterview.external_reference
              || `alphascreen-interview-${startingInterview.id}`,
            claimToken: startingInterview.claim_token,
            requestId: request_id,
          });
        } catch (recoveryError) {
          console.error('[create-tavus-interview] recovery_start_failure_record_failed', {
            request_id,
            interview_id: startingInterview.id,
            code: recoveryError?.code || null,
          });
        }
      } else {
        await supabaseAdmin
          .from('interviews')
          .update({
            status: 'Failed',
            failure_code: 'INTERVIEW_VENDOR_START_FAILED',
            failure_stage: 'vendor_start',
            failure_summary: 'The interview vendor did not create a usable conversation.',
            failure_at: new Date().toISOString(),
            retryable: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', startingInterview.id);
      }
      Sentry.captureException(error, {
        tags: {
          route_name: 'create_tavus_interview',
          surface: 'backend',
          stage: 'vendor_start',
          request_id: request_id || undefined,
          candidate_id: candidate_id || undefined,
          role_id: roleId || undefined,
          client_id: clientId || undefined,
          interview_id: startingInterview.id
        }
      });
      if (failureCategory === 'ambiguous_acceptance') {
        return res.status(503).json({
          error: 'vendor_reconciliation_required',
          code: 'VENDOR_RECONCILIATION_REQUIRED',
          detail: 'The interview start is being verified. Please do not retry yet.',
          request_id,
          interview_id: startingInterview.id,
        });
      }
      return sendCandidateError(res, 'INTERVIEW_VENDOR_START_FAILED', { request_id });
    }
    Sentry.addBreadcrumb({
      category: 'create_tavus_interview',
      message: 'tavus launch succeeded',
      level: 'info',
      data: { conversation_id: result?.conversation_id || null }
    });

    let interviewUpdateError = null;
    if (startingInterview.authorized_replacement && startingInterview.authorization_id) {
      try {
        await completeRecoveryStart(supabaseAdmin, {
          interviewId: startingInterview.id,
          authorizationId: startingInterview.authorization_id,
          success: true,
          conversationId: result.conversation_id,
          conversationUrl: result.conversation_url,
          effectivePersonaId: result.effective_persona_id,
          effectiveReplicaId: result.effective_replica_id,
          effectiveDocumentId: result.effective_tavus_document_id,
          externalReference: result.vendor_external_reference || startingInterview.external_reference,
          resolutionSource: 'create_response',
          claimToken: startingInterview.claim_token,
          requestId: request_id,
        });
      } catch (error) {
        interviewUpdateError = error;
      }
    } else {
      const updateResult = await supabaseAdmin
        .from('interviews')
        .update({
          video_url: result.conversation_url || null,
          tavus_application_id: result.conversation_id || null,
          tavus_conversation_id: result.conversation_id || null,
          effective_persona_id: result.effective_persona_id || null,
          effective_replica_id: result.effective_replica_id || null,
          effective_tavus_document_id: result.effective_tavus_document_id || null,
          status: 'Pending',
          updated_at: new Date().toISOString()
        })
        .eq('id', startingInterview.id);
      interviewUpdateError = updateResult.error;
    }
    if (interviewUpdateError) {
      console.error('[create-tavus-interview] linkage_update_failed', {
        request_id,
        interview_id: startingInterview.id,
        candidate_id,
        role_id: roleId,
        code: interviewUpdateError.code || null
      });
      if (startingInterview.authorized_replacement && startingInterview.authorization_id) {
        try {
          const recorded = await recordVendorBindingFailure(supabaseAdmin, {
            interviewId: startingInterview.id,
            authorizationId: startingInterview.authorization_id,
            claimToken: startingInterview.claim_token,
            externalReference: result.vendor_external_reference || startingInterview.external_reference,
            conversationId: result.conversation_id,
            conversationUrl: result.conversation_url,
            effectivePersonaId: result.effective_persona_id,
            effectiveReplicaId: result.effective_replica_id,
            effectiveDocumentId: result.effective_tavus_document_id,
            failureCode: interviewUpdateError.code || 'database_binding_failed',
            requestId: request_id,
          });
          if (recorded === 'started' || recorded?.status === 'started') {
            interviewUpdateError = null;
          }
        } catch (bindingRecordError) {
          console.error('[create-tavus-interview] binding_recovery_record_failed', {
            request_id,
            interview_id: startingInterview.id,
            code: bindingRecordError?.code || null,
          });
        }
        if (interviewUpdateError) {
          return res.status(503).json({
            error: 'vendor_binding_recovery_required',
            code: 'VENDOR_BINDING_RECOVERY_REQUIRED',
            detail: 'The interview provider succeeded, but support must finish linking the interview. Please do not retry.',
            request_id,
            interview_id: startingInterview.id,
          });
        }
      } else {
        return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id });
      }
    }

    // Immediately reflect on candidate
    await supabaseAdmin
      .from('candidates')
      .update({
        interview_status: 'Started',
        interview_video_url: result.conversation_url || null,
        candidate_external_id: result.conversation_id || null
      })
      .eq('id', candidate_id);

    clearOtpLaunchCapability(res);
    return res.status(200).json({
      message: 'Interview created',
      conversation_url: result.conversation_url || null,
      conversation_id: result.conversation_id || null,
      interview_id: startingInterview.id,
      max_interview_minutes: maxInterviewMinutes,
      silence_engagement_owner: result.silence_engagement_owner,
      prompt_silence_instruction_included: result.prompt_silence_instruction_included,
      application_inactivity_control_enabled: result.application_inactivity_control_enabled,
      candidate_assistance_contact: candidateAssistanceContact || null
    });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) {
      Sentry.captureException(e, {
        tags: {
          route_name: 'create_tavus_interview',
          surface: 'backend',
          request_id: request_id || undefined,
          candidate_id: sentryCandidateId || undefined,
          role_id: sentryRoleId || undefined,
          client_id: sentryClientId || undefined
        },
        extra: {
          request_id,
          candidate_id: sentryCandidateId,
          role_id: sentryRoleId,
          client_id: sentryClientId
        }
      });
    }
    return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id });
  }
});

module.exports = router;
