'use strict';

const crypto = require('crypto');
const express = require('express');
const sg = require('@sendgrid/mail');
const { supabaseAdmin } = require('../../clients/supabase');
const {
  authorizeReplacement,
  getRecoveryEligibility,
  isInterviewRecoveryCoreEnabled,
  isInterviewRecoveryCoreEmailEnabled,
  publicErrorDetail,
  recoverVendorBinding,
} = require('../../services/interviewAttemptService');
const { interviewAppBase: INTERVIEW_APP_BASE } = require('../../config/urlConfig');
const { buildBrandedEmailShell, escapeHtml } = require('../../clients/sendgrid');
const {
  createTavusReadOnlyProvider,
  reconcileAmbiguousTavusStart,
} = require('../../services/tavusVendorReconciliation');
const {
  isUuid,
  normalizeEnum,
  normalizePrimitiveString,
  normalizeUuid,
} = require('../../services/strictRequestValidation');
const {
  issueOtpChallenge,
  markOtpChallengeDelivery,
  supersedeOtpChallenges,
} = require('../../services/otpChallenge');

const AUTHORIZATION_SUCCESS = 'One replacement video interview has been authorized.';
const COMPLETED_BLOCKED = 'This candidate has completed the interview and cannot be authorized for another attempt.';
const VALID_REASONS = new Set([
  'candidate_network_disconnect',
  'unknown_early_termination',
  'no_substantive_response',
  'partial_interview',
  'vendor_start_failure',
  'client_approved_exception',
  'other',
]);
const VALID_MODES = new Set(['reset_only', 'reset_and_send']);
const VALID_DECISIONS = new Set(['authorize_one_video_replacement']);
function badRequest(res, code = 'reset_request_conflict') {
  return res.status(400).json({ error: 'bad_request', code, detail: publicErrorDetail(code) });
}

function disabledResponse(res) {
  return res.status(404).json({
    error: 'not_found',
    code: 'interview_recovery_core_disabled',
    detail: 'Interview recovery is not available.',
  });
}

function blockerDetail(code) {
  if (code === 'completed_interview_retake_blocked' || code === 'complete_report_bound') {
    return COMPLETED_BLOCKED;
  }
  return publicErrorDetail(code);
}

function resetLink(role, candidate, challengeId = null) {
  const token = String(role?.slug_or_token || '').trim();
  const base = String(INTERVIEW_APP_BASE || '').replace(/\/+$/, '');
  if (!base || !token) return null;
  const query = new URLSearchParams({ candidate_id: String(candidate.id), email: String(candidate.email || '') });
  if (challengeId) query.set('challenge_id', String(challengeId));
  return `${base}/interview/${encodeURIComponent(token)}?${query.toString()}`;
}

function resetEmailHtml(candidateName, roleTitle, code, link) {
  const safeName = escapeHtml(candidateName || 'there');
  const safeRole = escapeHtml(roleTitle || 'your role');
  const safeCode = escapeHtml(code);
  const safeLink = escapeHtml(link || '');
  return buildBrandedEmailShell({
    title: 'Your interview access has been reset',
    preheader: 'One replacement interview has been approved.',
    contentHtml: `
      <p style="margin:0 0 14px;color:#C9D3FF;font-size:15px;line-height:1.6;">Hi ${safeName}, one replacement interview for ${safeRole} has been approved.</p>
      <p style="margin:0 0 12px;color:#C9D3FF;font-size:14px;line-height:1.55;">Use this verification code within 10 minutes:</p>
      <p style="margin:0 0 18px;"><span style="display:inline-block;background:#A78BFA;color:#0A1547;border-radius:10px;padding:10px 16px;font-size:22px;font-weight:800;letter-spacing:0.22em;">${safeCode}</span></p>
      ${safeLink ? `<p style="margin:0;"><a href="${safeLink}" style="color:#CFCBFF;font-weight:700;">Open your interview</a></p>` : ''}
    `,
  });
}

function createInterviewRecoveryRouter({
  db = supabaseAdmin,
  emailSender,
  featureEnabled = isInterviewRecoveryCoreEnabled,
  emailFeatureEnabled = isInterviewRecoveryCoreEmailEnabled,
  tavusReadOnlyProviderFactory = createTavusReadOnlyProvider,
} = {}) {
  const router = express.Router();
  const sendEmail = emailSender || (async ({ to, subject, text, html }) => {
    const apiKey = String(process.env.SENDGRID_API_KEY || '').trim();
    const from = String(process.env.SENDGRID_FROM || '').trim();
    if (!apiKey || !from) throw new Error('candidate_reset_email_not_configured');
    sg.setApiKey(apiKey);
    await sg.send({ to, from: { email: from, name: process.env.APP_NAME || 'Interview Agent' }, subject, text, html });
  });

  router.use((req, res, next) => {
    if (!featureEnabled()) return disabledResponse(res);
    if (!isUuid(req.user?.id)) {
      return res.status(401).json({
        error: 'unauthorized',
        code: 'authentication_required',
        detail: 'Authentication is required.',
      });
    }
    return next();
  });

  router.get('/:candidateId/eligibility', async (req, res) => {
    const candidateId = normalizeUuid(req.params.candidateId);
    const clientId = normalizeUuid(req.query.client_id);
    const roleId = normalizeUuid(req.query.role_id);
    const priorInterviewValue = normalizeUuid(req.query.prior_interview_id, { required: false });
    const priorInterviewId = priorInterviewValue || null;
    if ([candidateId, clientId, roleId, priorInterviewValue].some((value) => value === null)) {
      return badRequest(res);
    }
    try {
      const eligibility = await getRecoveryEligibility(db, {
        candidateId,
        clientId,
        roleId,
        priorInterviewId,
      });
      const blockers = Array.isArray(eligibility?.blockers) ? eligibility.blockers : [];
      return res.json({
        ...eligibility,
        feature_enabled: true,
        detail: blockers.length ? blockerDetail(blockers[0]) : null,
      });
    } catch (error) {
      return res.status(error.status || 503).json({
        error: error.code || 'temporary_service_error',
        code: error.code || 'temporary_service_error',
        detail: error.message || 'Unable to review interview eligibility right now.',
      });
    }
  });

  router.post('/:candidateId/authorize', async (req, res) => {
    const candidateId = normalizeUuid(req.params.candidateId);
    const clientId = normalizeUuid(req.body?.client_id);
    const roleId = normalizeUuid(req.body?.role_id);
    const priorInterviewId = normalizeUuid(req.body?.prior_interview_id);
    const decision = normalizeEnum(req.body?.decision, VALID_DECISIONS);
    const reasonCode = normalizeEnum(req.body?.reason_code, VALID_REASONS);
    const reasonDetail = normalizePrimitiveString(req.body?.reason_detail, {
      required: true,
      allowEmpty: true,
      maxCodePoints: 500,
      maxBytes: 2000,
    });
    const resetMode = normalizeEnum(req.body?.mode, VALID_MODES);
    const idempotencyKey = normalizeUuid(req.body?.idempotency_key);
    const requiredCoverageAttested = req.body?.required_coverage_attested;
    const clientApprovalAcknowledged = req.body?.client_approval_acknowledged;

    if ([candidateId, clientId, roleId, priorInterviewId, decision, reasonCode,
      reasonDetail, resetMode, idempotencyKey].some((value) => value === null)
      || typeof requiredCoverageAttested !== 'boolean'
      || typeof clientApprovalAcknowledged !== 'boolean') {
      return badRequest(res);
    }
    if (resetMode === 'reset_and_send' && !emailFeatureEnabled()) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'interview_recovery_email_disabled',
        detail: publicErrorDetail('interview_recovery_email_disabled'),
      });
    }
    if (reasonCode === 'other' && !reasonDetail) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'interview_reset_other_detail_required',
        detail: publicErrorDetail('interview_reset_other_detail_required'),
      });
    }
    if (reasonDetail.length > 500) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'interview_reset_reason_detail_too_long',
        detail: publicErrorDetail('interview_reset_reason_detail_too_long'),
      });
    }
    if (!requiredCoverageAttested) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'recovery_attestation_required',
        detail: publicErrorDetail('recovery_attestation_required'),
      });
    }
    if (!clientApprovalAcknowledged) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'client_approval_required',
        detail: publicErrorDetail('client_approval_required'),
      });
    }

    let authorization;
    try {
      authorization = await authorizeReplacement(db, {
        candidateId,
        roleId,
        clientId,
        priorInterviewId,
        actorUserId: req.user?.id,
        actorEmail: req.user?.email || null,
        actorRole: 'admin',
        decision,
        reasonCode,
        reasonDetail,
        resetMode,
        requiredCoverageAttested: requiredCoverageAttested === true,
        clientApprovalAcknowledged: clientApprovalAcknowledged === true,
        idempotencyKey,
      });
    } catch (error) {
      return res.status(error.status || 503).json({
        error: error.code || 'temporary_service_error',
        code: error.code || 'temporary_service_error',
        detail: error.message,
      });
    }

    let emailStatus = authorization?.email_status || (resetMode === 'reset_only' ? 'not_requested' : 'pending');
    try {
      await supersedeOtpChallenges(db, {
        candidateId,
        roleId,
        reason: 'recovery_authorized',
      });
    } catch (error) {
      return res.status(503).json({
        error: 'temporary_service_error',
        code: 'temporary_service_error',
        detail: 'Interview access was reset, but verification cleanup is still reconciling. Please retry this action.',
      });
    }
    if (resetMode === 'reset_and_send' && authorization?.replayed !== true) {
      const { data: claimData, error: claimError } = await db.rpc('claim_interview_recovery_email_core', {
        p_authorization_id: authorization.authorization_id,
      });
      const claim = Array.isArray(claimData) ? claimData[0] : claimData;
      if (!claimError && claim?.claimed && claim?.claim_token) {
        let otpChallenge = null;
        try {
          const [{ data: candidate, error: candidateError }, { data: role, error: roleError }] = await Promise.all([
            db.from('candidates').select('id,name,email,client_id,role_id').eq('id', candidateId).eq('client_id', clientId).eq('role_id', roleId).single(),
            db.from('roles').select('id,title,slug_or_token,client_id').eq('id', roleId).eq('client_id', clientId).single(),
          ]);
          if (candidateError || !candidate) throw candidateError || new Error('reset_candidate_not_found');
          if (roleError || !role) throw roleError || new Error('reset_role_not_found');

          otpChallenge = await issueOtpChallenge(db, {
            email: candidate.email,
            candidateId,
            clientId,
            roleId,
            interviewAttemptId: priorInterviewId,
            recoveryAuthorizationId: authorization.authorization_id,
          });

          const link = resetLink(role, candidate, otpChallenge.challengeId);
          await sendEmail({
            to: candidate.email,
            subject: 'Your interview access has been reset',
            text: `One replacement interview has been approved. Your verification code is ${otpChallenge.code}. ${link || ''}`,
            html: resetEmailHtml(candidate.name, role.title, otpChallenge.code, link),
          });
          await markOtpChallengeDelivery(db, otpChallenge.challengeId, 'sent');
          const { data: completedStatus, error: completeError } = await db.rpc('complete_interview_recovery_email_core', {
            p_authorization_id: authorization.authorization_id,
            p_claim_token: claim.claim_token,
            p_success: true,
            p_failure_code: null,
          });
          if (completeError) throw completeError;
          emailStatus = completedStatus || 'sent';
        } catch (error) {
          if (otpChallenge) {
            await markOtpChallengeDelivery(db, otpChallenge.challengeId, 'failed').catch(() => {});
            await supersedeOtpChallenges(db, {
              candidateId,
              roleId,
              reason: 'recovery_email_failed',
            }).catch(() => {});
          }
          const { data: completedStatus } = await db.rpc('complete_interview_recovery_email_core', {
            p_authorization_id: authorization.authorization_id,
            p_claim_token: claim.claim_token,
            p_success: false,
            p_failure_code: String(error?.message || 'delivery_failed').slice(0, 100),
          });
          emailStatus = completedStatus || 'failed';
        }
      } else if (claimError) {
        emailStatus = 'failed';
      }
    }

    return res.status(200).json({
      ok: true,
      message: AUTHORIZATION_SUCCESS,
      authorization_id: authorization?.authorization_id || null,
      adjudication_id: authorization?.adjudication_id || null,
      prior_interview_id: authorization?.prior_interview_id || priorInterviewId,
      replacement_interview_id: authorization?.replacement_interview_id || null,
      email_status: emailStatus,
      replayed: authorization?.replayed === true,
      audit_log_id: authorization?.audit_log_id || null,
    });
  });

  router.post('/:candidateId/reconcile-vendor-start', async (req, res) => {
    if (req.isGlobalAdmin !== true) {
      return res.status(403).json({ error: 'forbidden', code: 'admin_scope_required', detail: publicErrorDetail('admin_scope_required') });
    }
    const candidateId = normalizeUuid(req.params.candidateId);
    const clientId = normalizeUuid(req.body?.client_id);
    const roleId = normalizeUuid(req.body?.role_id);
    const interviewId = normalizeUuid(req.body?.interview_id);
    const authorizationId = normalizeUuid(req.body?.authorization_id);
    if ([candidateId, clientId, roleId, interviewId, authorizationId].some((value) => value === null)) {
      return badRequest(res);
    }
    const { data: boundInterview, error: bindingError } = await db
      .from('interviews')
      .select('id,vendor_start_state')
      .eq('id', interviewId)
      .eq('candidate_id', candidateId)
      .eq('client_id', clientId)
      .eq('role_id', roleId)
      .eq('replacement_authorization_id', authorizationId)
      .maybeSingle();
    if (bindingError) {
      return res.status(503).json({ error: 'temporary_service_error', code: 'temporary_service_error', detail: publicErrorDetail(null) });
    }
    if (!boundInterview) {
      return res.status(404).json({ error: 'not_found', code: 'recovery_attempt_not_found', detail: 'The replacement interview could not be found.' });
    }
    try {
      const requestId = typeof req.request_id === 'string' ? req.request_id.slice(0, 120) : crypto.randomUUID();
      if (boundInterview.vendor_start_state === 'binding_recovery_required') {
        const binding = await recoverVendorBinding(db, {
          interviewId,
          authorizationId,
          actorUserId: req.user.id,
          actorEmail: req.user.email || null,
          requestId,
        });
        return res.status(200).json({
          ok: true,
          status: binding?.status || binding || 'started',
          interview_id: interviewId,
          conversation_id: binding?.conversation_id || null,
          operation: 'database_binding_recovery',
        });
      }
      const result = await reconcileAmbiguousTavusStart({
        db,
        provider: tavusReadOnlyProviderFactory(),
        interviewId,
        authorizationId,
        requestId,
      });
      const responseStatus = result.status === 'vendor_reconciliation_in_progress' ? 409 : 200;
      return res.status(responseStatus).json({
        ok: responseStatus === 200,
        status: result.status,
        interview_id: interviewId,
        conversation_id: result.conversation_id || null,
        match_count: Number.isInteger(result.match_count) ? result.match_count : null,
        scan_complete: result.scan_complete === true,
        scan_status: result.scan_status || null,
        operation: 'read_only_vendor_reconciliation',
      });
    } catch (_) {
      return res.status(503).json({
        error: 'vendor_reconciliation_required',
        code: 'VENDOR_RECONCILIATION_REQUIRED',
        detail: publicErrorDetail('vendor_reconciliation_required'),
      });
    }
  });

  return router;
}

module.exports = {
  createInterviewRecoveryRouter,
  AUTHORIZATION_SUCCESS,
  COMPLETED_BLOCKED,
};
