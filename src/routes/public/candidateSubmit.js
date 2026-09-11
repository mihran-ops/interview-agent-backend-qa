// routes/candidateSubmit.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Sentry = require('@sentry/node');
const multer = require('multer');
const { supabase, supabaseAdmin } = require('../../clients/supabase');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../../services/roleInterviewAvailability');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../../services/rateLimit');
const { isRoleInactive, buildRoleInactivePayload, logInactiveRoleBlocked } = require('../../services/roleLifecycle');
const {
  normalizeCandidatePhoneCountry,
  normalizeCandidatePhoneIdentity,
  getCandidatePhoneValidationMessage
} = require('../../services/candidatePhone');
const { buildCandidateError, sendCandidateError, getInterviewConflictCode } = require('../../services/candidateErrors');
const { ResumeUploadError, inspectResumeFile, uploadResumeObject } = require('../../services/resumeUpload');
const {
  CandidateSubmissionKeyError,
  reserveCandidateSubmission,
  completeCandidateSubmission,
  failCandidateSubmission
} = require('../../services/candidateSubmissionIdempotency');
const {
  getAuthorizedRecoveryReentry,
  isInterviewRecoveryCoreEnabled
} = require('../../services/interviewAttemptService');
const { issueOtpChallenge } = require('../../services/otpChallenge');
const { createEmailOtpDelivery } = require('../../services/otpDelivery');
const {
  deliverCandidateSmsOtp,
  normalizeConsentCopyVersion,
  readCandidateSmsConfiguration,
} = require('../../services/candidateSmsDelivery');
const analyzeResume = require('../../services/analyzeResume'); // resume analyzer
const {
  createCandidateSubmitLifecycle,
  createCandidateUploadMiddleware,
  markCandidateSubmitStage,
} = require('../../services/candidateSubmitLifecycle');

// uploads: keep in memory; 10MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const candidateSubmitLifecycle = createCandidateSubmitLifecycle();
const candidateUpload = createCandidateUploadMiddleware(upload.any());

const BILLING_MODE = String(process.env.BILLING_MODE || 'off').toLowerCase();
const BILLING_ENFORCED = BILLING_MODE === 'enforce';
const SUBMIT_RATE_WINDOW_MS = 60 * 60 * 1000;
const SUBMIT_RATE_MAX = 10;
const deliverEmailOtp = createEmailOtpDelivery();

async function candidateSubmitRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'candidate_submit',
      subjectKey: getRequestSubjectKey(req),
      windowMs: SUBMIT_RATE_WINDOW_MS,
      maxCount: SUBMIT_RATE_MAX
    });
    if (!result.allowed) {
      markCandidateSubmitStage(req, 'rate_limit_denied');
      return sendCandidateError(res, 'RATE_LIMITED', { request_id: req.request_id || null });
    }
    markCandidateSubmitStage(req, 'rate_limit_allowed');
  } catch (error) {
    console.error('[rate-limit] candidate submit check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id: req.request_id || null });
  }
  return next();
}

// normalize helpers
function normEmail(v = '') {
  return String(v || '').trim().toLowerCase();
}
function resumeMetadata(inspection) {
  if (!inspection) return {};
  return {
    resume_original_filename: inspection.original_filename,
    resume_size_bytes: inspection.size_bytes,
    resume_mime_type: inspection.mime_type,
    resume_sha256: inspection.sha256,
    resume_parse_status: inspection.parse_status,
    resume_parse_note: inspection.parse_note
  };
}

function queueOtpEmail({ challengeId, code, email, candidateId, roleId, requestId }) {
  setImmediate(async () => {
    console.log('[candidate-submit] otp_delivery_started', {
      request_id: requestId,
      candidate_id: candidateId,
      role_id: roleId,
      channel: 'email'
    });
    try {
      await deliverEmailOtp({ db: supabaseAdmin, challengeId, destination: email, code });
      console.log('[candidate-submit] otp_delivery_succeeded', {
        request_id: requestId,
        candidate_id: candidateId,
        role_id: roleId,
        channel: 'email'
      });
    } catch (error) {
      console.warn('[candidate-submit] otp_delivery_failed', {
        request_id: requestId,
        candidate_id: candidateId,
        role_id: roleId,
        channel: 'email',
        status: error?.response?.status || error?.code || null
      });
      Sentry.captureException(error, {
        tags: {
          route_name: 'candidate_submit',
          surface: 'backend',
          task: 'background_otp_email',
          request_id: requestId || undefined,
          candidate_id: candidateId || undefined,
          role_id: roleId || undefined,
          otp_channel: 'email'
        },
        extra: { request_id: requestId, candidate_id: candidateId, role_id: roleId }
      });
    }
  });
}

/**
 * POST /api/candidate/submit
 * Accepts multipart form (resume) or JSON (resume_url).
 * Required: email + (name OR first/last) + (role_id OR role_token)
 */
router.post('/', candidateSubmitLifecycle, candidateSubmitRateLimit, candidateUpload, async (req, res) => {
  const request_id = req.request_id || null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  let submissionReservation = null;
  Sentry.setTag('route_name', 'candidate_submit');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const respondFinal = async (status, payload, candidateId = null) => {
      await completeCandidateSubmission(supabaseAdmin, submissionReservation, {
        status,
        body: payload,
        candidateId
      });
      markCandidateSubmitStage(req, 'response_committed');
      return res.status(status).json(payload);
    };
    const respondCandidateError = async (code, overrides = {}, candidateId = null) => {
      const { status, payload } = buildCandidateError(code, { ...overrides, request_id });
      return respondFinal(status, payload, candidateId);
    };
    const respondRetryableError = async (code, overrides = {}, candidateId = null) => {
      await failCandidateSubmission(supabaseAdmin, submissionReservation, { code, candidateId });
      return sendCandidateError(res, code, { ...overrides, request_id });
    };
    const respondSmsPreChallengeFailure = async (payload, candidateId = null) => {
      await failCandidateSubmission(supabaseAdmin, submissionReservation, {
        code: 'SMS_PRECHALLENGE_DELIVERY_UNAVAILABLE',
        candidateId,
      });
      markCandidateSubmitStage(req, 'response_committed');
      return res.status(200).json(payload);
    };
    // --- normalize inputs ---
    const role_token   = (req.body.role_token || '').trim();
    const role_id_in   = (req.body.role_id || '').trim();
    const first_name   = (req.body.first_name || '').trim();
    const last_name    = (req.body.last_name  || '').trim();
    const rawName      = (req.body.name || '').trim();
    const emailRaw     = (req.body.email || '').trim();
    const phoneRaw     = (req.body.phone || '').trim();
    const phoneCountry = normalizeCandidatePhoneCountry(req.body.phone_country || req.body.phoneCountry || '');
    const requestedOtpChannel = String(req.body.otp_channel || req.body.otpChannel || 'email').trim().toLowerCase();
    const consentCopyVersion = normalizeConsentCopyVersion(
      req.body.consent_copy_version || req.body.consentCopyVersion || ''
    );
    const submissionKey = req.body.submission_key || req.body.submissionKey || '';
    const resume_url_in = req.body.resume_url || null;
    const resumeFile = (req.files || []).find(file =>
      ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(file.fieldname)
    ) || null;

    const fullName = rawName || [first_name, last_name].filter(Boolean).join(' ').trim();

    const email = normEmail(emailRaw);
    const phoneIdentity = normalizeCandidatePhoneIdentity(phoneRaw, phoneCountry);
    const phone = phoneIdentity?.phone || null;

    if (!email || !fullName || (!role_token && !role_id_in)) {
      return res.status(400).json({
        error: 'Required: email, (name OR first_name+last_name), and (role_id OR role_token).',
      });
    }
    if (!phone) {
      return sendCandidateError(res, 'INVALID_PHONE_FOR_COUNTRY', {
        detail: getCandidatePhoneValidationMessage(phoneCountry),
        request_id
      });
    }
    if (!['email', 'sms'].includes(requestedOtpChannel)) {
      return sendCandidateError(res, 'SMS_CHANNEL_UNAVAILABLE', { request_id });
    }
    if (requestedOtpChannel === 'sms' && (
      !readCandidateSmsConfiguration(process.env).valid
      || !consentCopyVersion
      || phoneIdentity.phone_country_code !== 'US'
    )) {
      return sendCandidateError(res, 'SMS_CHANNEL_UNAVAILABLE', { request_id });
    }
    markCandidateSubmitStage(req, 'input_validated', { channel: requestedOtpChannel });

    let resumeInspection = null;
    if (resumeFile) {
      try {
        resumeInspection = await inspectResumeFile(resumeFile);
      } catch (error) {
        if (error instanceof ResumeUploadError) {
          return sendCandidateError(res, error.code, { request_id });
        }
        throw error;
      }
    }
    markCandidateSubmitStage(req, 'resume_inspected', {
      resume_present: Boolean(resumeFile),
      resume_parse_status: resumeInspection?.parse_status || null,
    });

    // --- role lookup (need client_id + description) ---
    let role = null, rErr = null;
    if (role_id_in) {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, description, job_description_text, kb_document_id, client_id, status')
        .eq('id', role_id_in)
        .single());
    } else {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, description, job_description_text, kb_document_id, client_id, status')
        .eq('slug_or_token', role_token)
        .single());
    }
    if (rErr || !role) {
      console.warn('[candidate-submit] role_not_found', {
        request_id,
        role_id: role_id_in || null
      });
      return sendCandidateError(res, 'INTERVIEW_LINK_EXPIRED', { request_id });
    }
    const roleId = role.id;
    markCandidateSubmitStage(req, 'role_loaded');
    sentryRoleId = roleId || null;
    sentryClientId = role.client_id || null;
    if (isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'candidate_submit',
        request_id,
        role_id: roleId || null
      });
      return res.status(403).json(buildRoleInactivePayload(request_id));
    }
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));
    if (sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    Sentry.addBreadcrumb({
      category: 'candidate_submit',
      message: 'role loaded',
      level: 'info',
      data: { role_id: roleId, client_id: role.client_id || null }
    });

    if (BILLING_ENFORCED && role.client_id) {
      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .select('id,billing_status,manual_active_override,access_override_mode,candidate_assistance_contact')
        .eq('id', role.client_id)
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
        category: 'candidate_submit',
        message: 'client loaded',
        level: 'info',
        data: { client_id: role.client_id || null }
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
    }

    const availability = await getRoleInterviewAvailability({
      db: supabaseAdmin,
      roleId,
      clientId: role.client_id || null
    });
    markCandidateSubmitStage(req, 'availability_checked');
    await syncRoleInterviewLimitNotification({
      db: supabaseAdmin,
      roleId,
      clientId: role.client_id || null,
      remainingInterviews: availability.remaining_interviews,
      roleTitle: role?.title || ''
    });
    if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
      Sentry.addBreadcrumb({
        category: 'candidate_submit',
        message: 'interview limit reached',
        level: 'info',
        data: { role_id: roleId, client_id: role.client_id || null }
      });
      return res.status(403).json({
        error: 'forbidden',
        code: 'interview_limit_reached',
        detail: 'This role has no interviews remaining under the current plan.',
        hint: null,
        request_id
      });
    }

    try {
      submissionReservation = await reserveCandidateSubmission(supabaseAdmin, {
        roleId,
        submissionKey
      });
    } catch (error) {
      if (error instanceof CandidateSubmissionKeyError) {
        return sendCandidateError(res, 'INVALID_SUBMISSION_KEY', { request_id });
      }
      console.error('[candidate-submit] idempotency_reservation_failed', {
        request_id,
        role_id: roleId,
        code: error?.code || null,
        error: error?.message || error
      });
      return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id });
    }
    if (submissionReservation.state === 'replay') {
      markCandidateSubmitStage(req, 'reservation_replay');
      return res
        .status(Number(submissionReservation.row.response_status) || 200)
        .json(submissionReservation.row.response_body);
    }
    if (submissionReservation.state === 'processing') {
      markCandidateSubmitStage(req, 'reservation_processing');
      return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', {
        status: 409,
        detail: 'This submission is still processing. Please wait a moment and try again.',
        request_id
      });
    }
    markCandidateSubmitStage(req, 'reservation_acquired');

    // --- duplicate & enrichment policy ---
    // RULES:
    // 1) Email match resolves to the existing identity. Recover OTP when no interview exists.
    // 2) If email does not match but phone does, require support review.
    // 3) Otherwise, ALLOW (create candidate, upload, send OTP).

    // 1) Email match
    let existingByEmail = null;
    {
      const { data, error } = await supabase
        .from('candidates')
        .select('id, name, email, phone, phone_e164, phone_country_code, verified, status, resume_url')
        .eq('role_id', roleId)
        .eq('email', email)
        .limit(1)
        .maybeSingle();
      if (!error && data) existingByEmail = data;
    }
    if (existingByEmail) {
      // Enrich phone if missing
      if (phone && !existingByEmail.phone) {
        const { error: phoneUpdateError } = await supabase.from('candidates').update({
          phone,
          phone_e164: phoneIdentity.phone_e164,
          phone_country_code: phoneIdentity.phone_country_code,
        }).eq('id', existingByEmail.id);
        if (phoneUpdateError) {
          return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, existingByEmail.id);
        }
        existingByEmail.phone = phone;
        existingByEmail.phone_e164 = phoneIdentity.phone_e164;
        existingByEmail.phone_country_code = phoneIdentity.phone_country_code;
      } else if (
        phone
        && existingByEmail.phone === phone
        && (
          existingByEmail.phone_e164 !== phoneIdentity.phone_e164
          || existingByEmail.phone_country_code !== phoneIdentity.phone_country_code
        )
      ) {
        const { error: phoneUpdateError } = await supabase.from('candidates').update({
          phone_e164: phoneIdentity.phone_e164,
          phone_country_code: phoneIdentity.phone_country_code,
        }).eq('id', existingByEmail.id);
        if (phoneUpdateError) {
          return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, existingByEmail.id);
        }
        existingByEmail.phone_e164 = phoneIdentity.phone_e164;
        existingByEmail.phone_country_code = phoneIdentity.phone_country_code;
      }
      if (requestedOtpChannel === 'sms' && existingByEmail.phone !== phone) {
        return respondCandidateError('CANDIDATE_ALREADY_EXISTS', {}, existingByEmail.id);
      }
      const { data: existingInterview, error: existingInterviewError } = await supabase
        .from('interviews')
        .select('id,status')
        .eq('candidate_id', existingByEmail.id)
        .eq('role_id', roleId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingInterviewError) {
        return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, existingByEmail.id);
      }
      let authorizedRecoveryReentry = null;
      if (existingInterview) {
        if (isInterviewRecoveryCoreEnabled()) {
          try {
            authorizedRecoveryReentry = await getAuthorizedRecoveryReentry(supabaseAdmin, {
              candidateId: existingByEmail.id,
              clientId: role.client_id,
              roleId,
              priorInterviewId: existingInterview.id,
            });
          } catch (_) {
            console.error('[candidate-submit] recovery_reentry_lookup_failed', {
              request_id,
              candidate_id: existingByEmail.id,
              role_id: roleId,
            });
            return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, existingByEmail.id);
          }
        }
        if (!authorizedRecoveryReentry) {
          return respondCandidateError(
            getInterviewConflictCode(existingInterview.status),
            {},
            existingByEmail.id
          );
        }
      }
      {
        const candidate_id = existingByEmail.id;
        sentryCandidateId = candidate_id || null;
        if (sentryCandidateId) Sentry.setTag('candidate_id', String(sentryCandidateId));
        console.log('[candidate-submit] duplicate_unverified_recovery_start', {
          request_id,
          candidate_id,
          role_id: roleId,
          recovery: true
        });

        if (!existingByEmail.resume_url && resumeFile && resumeInspection) {
          const bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
          const objectPath = `${candidate_id}.${resumeInspection.extension}`;
          try {
            const resumeUrl = await uploadResumeObject({
              storage: supabase.storage,
              bucket,
              objectPath,
              file: resumeFile,
              inspection: resumeInspection
            });
            const { error: resumeUpdateError } = await supabase
              .from('candidates')
              .update({ resume_url: resumeUrl, ...resumeMetadata(resumeInspection) })
              .eq('id', candidate_id);
            if (resumeUpdateError) throw resumeUpdateError;
            existingByEmail.resume_url = resumeUrl;
            markCandidateSubmitStage(req, 'storage_uploaded');
          } catch (error) {
            await supabase.storage.from(bucket).remove([objectPath]).catch(() => {});
            console.error('[candidate-submit] recovery_resume_upload_failed', {
              request_id,
              candidate_id,
              role_id: roleId,
              code: error?.code || null
            });
            return respondRetryableError('RESUME_UPLOAD_FAILED', {}, candidate_id);
          }
        }

        let otpChallenge;
        let smsDelivery = null;
        try {
          if (requestedOtpChannel === 'sms') {
            smsDelivery = await deliverCandidateSmsOtp({
              db: supabaseAdmin,
              candidate: {
                id: candidate_id,
                phone_e164: phoneIdentity.phone_e164,
                phone_country_code: phoneIdentity.phone_country_code,
              },
              clientId: role.client_id,
              roleId,
              submissionId: submissionReservation?.row?.id || null,
              interviewAttemptId: existingInterview?.id || null,
              recoveryAuthorizationId: authorizedRecoveryReentry?.id || null,
              consentCopyVersion,
              requestIp: getRequestSubjectKey(req),
            });
          } else {
            otpChallenge = await issueOtpChallenge(supabaseAdmin, {
              email,
              candidateId: candidate_id,
              clientId: role.client_id,
              roleId,
              submissionId: submissionReservation?.row?.id || null,
              interviewAttemptId: existingInterview?.id || null,
              recoveryAuthorizationId: authorizedRecoveryReentry?.id || null,
            });
          }
        } catch (error) {
          console.error('[candidate-submit] durable_challenge_create_failed', {
            request_id,
            candidate_id,
            role_id: roleId,
            code: error?.code || null,
            error_name: error?.name || null
          });
          return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, candidate_id);
        }

        console.log('[candidate-submit] duplicate_unverified_recovery_success', {
          request_id,
          candidate_id,
          role_id: roleId,
          recovery: true
        });
        markCandidateSubmitStage(req, 'challenge_created', { channel: requestedOtpChannel });
        const responseBody = {
          message: 'If your information is accepted, a verification code will be sent shortly.',
          candidate_id,
          role_id: roleId,
          challenge_id: requestedOtpChannel === 'sms' ? smsDelivery?.challengeId : otpChallenge.challengeId,
          delivery_channel: requestedOtpChannel,
          delivery_outcome: requestedOtpChannel === 'sms' ? smsDelivery?.outcome : 'accepted',
          email_fallback_available: requestedOtpChannel === 'sms' && smsDelivery?.emailFallbackAvailable === true,
          resume_url: existingByEmail.resume_url || null,
          resume_parse_status: resumeInspection?.parse_status || null
        };
        if (requestedOtpChannel === 'sms' && (
          smsDelivery?.challengeCreated !== true
          || !smsDelivery?.challengeId
        )) {
          return respondSmsPreChallengeFailure(responseBody, candidate_id);
        }
        await respondFinal(200, responseBody, candidate_id);
        if (requestedOtpChannel === 'email') {
          queueOtpEmail({
            challengeId: otpChallenge.challengeId,
            code: otpChallenge.code,
            email,
            candidateId: candidate_id,
            roleId,
            requestId: request_id,
          });
        }
        return;
      }
    }

    // 2) Phone match with a different email requires recovery review.
    if (phone) {
      let existingByPhone = null;
      const { data, error } = await supabase
        .from('candidates')
        .select('id, phone')
        .eq('role_id', roleId)
        .eq('phone', phone)
        .limit(1)
        .maybeSingle();
      if (!error && data) existingByPhone = data;

      if (existingByPhone) {
        return respondCandidateError('CANDIDATE_ALREADY_EXISTS', {}, existingByPhone.id);
      }
    }

    if (resumeInspection?.sha256) {
      const { data: matchingResume } = await supabase
        .from('candidates')
        .select('id')
        .eq('role_id', roleId)
        .eq('resume_sha256', resumeInspection.sha256)
        .limit(1)
        .maybeSingle();
      if (matchingResume) {
        console.warn('[candidate-submit] matching_resume_signal', {
          request_id,
          role_id: roleId,
          existing_candidate_id: matchingResume.id
        });
      }
    }

    // Upload first so a successful candidate row never points at a failed storage write.
    const candidate_id = crypto.randomUUID();
    let resume_url = resume_url_in;
    let uploadedObject = null;
    const fileBuf = resumeFile?.buffer || null;
    const fileType = resumeInspection?.mime_type || '';
    if (resumeFile && resumeInspection) {
      try {
        const bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
        const objectPath = `${candidate_id}.${resumeInspection.extension}`;
        resume_url = await uploadResumeObject({
          storage: supabase.storage,
          bucket,
          objectPath,
          file: resumeFile,
          inspection: resumeInspection
        });
        uploadedObject = { bucket, objectPath };
        markCandidateSubmitStage(req, 'storage_uploaded');
      } catch (error) {
        console.error('[candidate-submit] resume_upload_failed', {
          request_id,
          role_id: roleId,
          code: error?.code || null
        });
        return respondRetryableError('RESUME_UPLOAD_FAILED');
      }
    }

    const { error: cErr } = await supabase
      .from('candidates')
      .insert({
        id: candidate_id,
        candidate_id,
        role_id: roleId,
        client_id: role.client_id || null,
        name: fullName,
        first_name,
        last_name,
        email,
        phone, // US: 10 digits; Philippines: 63 + mobile number.
        phone_e164: phoneIdentity.phone_e164,
        phone_country_code: phoneIdentity.phone_country_code,
        status: 'Resume Uploaded',
        resume_url: resume_url || null,
        ...resumeMetadata(resumeInspection)
      });
    if (cErr) {
      if (uploadedObject) {
        await supabase.storage.from(uploadedObject.bucket).remove([uploadedObject.objectPath]).catch(() => {});
      }
      console.error('[candidate-submit] candidate_insert_failed', {
        request_id,
        role_id: roleId,
        code: cErr.code || null,
        error: cErr.message
      });
      if (cErr.code === '23505') {
        return respondCandidateError('CANDIDATE_ALREADY_EXISTS');
      }
      return respondRetryableError('TEMPORARY_SERVICE_ERROR');
    }
    sentryCandidateId = candidate_id;
    markCandidateSubmitStage(req, 'candidate_persisted');
    Sentry.setTag('candidate_id', String(candidate_id));
    Sentry.addBreadcrumb({
      category: 'candidate_submit',
      message: 'candidate created',
      level: 'info',
      data: { candidate_id, role_id: roleId }
    });

    let otpChallenge;
    let smsDelivery = null;
    try {
      if (requestedOtpChannel === 'sms') {
        smsDelivery = await deliverCandidateSmsOtp({
          db: supabaseAdmin,
          candidate: {
            id: candidate_id,
            phone_e164: phoneIdentity.phone_e164,
            phone_country_code: phoneIdentity.phone_country_code,
          },
          clientId: role.client_id,
          roleId,
          submissionId: submissionReservation?.row?.id || null,
          consentCopyVersion,
          requestIp: getRequestSubjectKey(req),
        });
      } else {
        otpChallenge = await issueOtpChallenge(supabaseAdmin, {
          email,
          candidateId: candidate_id,
          clientId: role.client_id,
          roleId,
          submissionId: submissionReservation?.row?.id || null,
        });
      }
    } catch (error) {
      console.error('[candidate-submit] durable_challenge_create_failed', {
        request_id,
        candidate_id,
        role_id: roleId,
        code: error?.code || null
      });
      return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, candidate_id);
    }
    markCandidateSubmitStage(req, 'challenge_created', { channel: requestedOtpChannel });

    // success
    const responseBody = {
      message: 'If your information is accepted, a verification code will be sent shortly.',
      candidate_id,
      role_id: roleId,
      challenge_id: requestedOtpChannel === 'sms' ? smsDelivery?.challengeId : otpChallenge.challengeId,
      delivery_channel: requestedOtpChannel,
      delivery_outcome: requestedOtpChannel === 'sms' ? smsDelivery?.outcome : 'accepted',
      email_fallback_available: requestedOtpChannel === 'sms' && smsDelivery?.emailFallbackAvailable === true,
      resume_url: resume_url || null,
      resume_parse_status: resumeInspection?.parse_status || null
    };
    const smsFailedBeforeChallenge = requestedOtpChannel === 'sms' && (
      smsDelivery?.challengeCreated !== true
      || !smsDelivery?.challengeId
    );
    if (smsFailedBeforeChallenge) {
      await respondSmsPreChallengeFailure(responseBody, candidate_id);
    } else {
      await respondFinal(200, responseBody, candidate_id);
    }
    if (!smsFailedBeforeChallenge && requestedOtpChannel === 'email') {
      queueOtpEmail({
        challengeId: otpChallenge.challengeId,
        code: otpChallenge.code,
        email,
        candidateId: candidate_id,
        roleId,
        requestId: request_id,
      });
    }

    if (fileBuf && resumeInspection?.parse_status === 'parsed') {
      setImmediate(async () => {
        console.log('[candidate-submit] background_resume_analysis_start', {
          request_id,
          candidate_id,
          role_id: roleId
        });
        try {
          const summary = await analyzeResume(fileBuf, fileType, {
            ...role,
            description: role.description || role.job_description_text || ''
          }, candidate_id);
          await supabase.from('candidates').update({ analysis_summary: summary }).eq('id', candidate_id);
          console.log('[candidate-submit] background_resume_analysis_success', {
            request_id,
            candidate_id,
            role_id: roleId
          });
        } catch (e) {
          console.warn('[candidate-submit] background_resume_analysis_failed', {
            request_id,
            candidate_id,
            role_id: roleId,
            error: e?.message || e
          });
          Sentry.captureException(e, {
            tags: {
              route_name: 'candidate_submit',
              surface: 'backend',
              task: 'background_resume_analysis',
              request_id: request_id || undefined,
              candidate_id: candidate_id || undefined,
              role_id: roleId || undefined,
              client_id: role?.client_id || undefined
            },
            extra: {
              request_id,
              candidate_id,
              role_id: roleId,
              client_id: role?.client_id || null
            }
          });
        }
      });
    }
    return;
  } catch (err) {
    console.error('Error in /candidate/submit:', err);
    Sentry.captureException(err, {
      tags: {
        route_name: 'candidate_submit',
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
    try {
      await failCandidateSubmission(supabaseAdmin, submissionReservation, {
        code: 'TEMPORARY_SERVICE_ERROR',
        candidateId: sentryCandidateId
      });
    } catch (_) {}
    return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id });
  }
});

module.exports = router;
