'use strict';

// Opening a signing session and recording the signature.

const express = require('express');
const { requireAuth, withClientScope } = require('../../../middleware/auth');
const {
  AGREEMENTS_BUCKET,
  EMAIL_SIGNED_URL_TTL_SECONDS,
  MEMBERSHIP_INTERNAL_NOTIFY_EMAIL,
  SIGNED_URL_TTL_SECONDS,
  buildAgreementInputFromRow,
  buildMembershipAgreementHtml,
  createAgreementSignedUrl,
  crypto,
  extractErrorMessage,
  getClientIp,
  hashToken,
  htmlToPdf,
  isPublicPurchaseIntentAgreement,
  loadAgreementByTokenHash,
  normalizeAccepted,
  parseSignaturePayload,
  publicAgreementTokenRateLimit,
  readToken,
  requireAgreementClientWhenPresent,
  resolveAgreementPublicSessionState,
  respondWithAgreementClientGuard,
  sendMembershipAgreementCompletedInternalNotification,
  sendMembershipAgreementSignedCopyEmail,
  slugify,
  supabaseAdmin,
  validateSignableAgreement,
} = require('../../../services/membershipAgreements/index');

const router = express.Router();

router.post('/session', publicAgreementTokenRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(400).json({
        error: 'token_required',
        code: 'token_required',
        detail: 'Signing token is required.',
        request_id
      });
    }

    const tokenHash = hashToken(token);
    const agreement = await loadAgreementByTokenHash(tokenHash);
    const sessionState = resolveAgreementPublicSessionState(agreement);
    if (!sessionState.ok) {
      return res.status(sessionState.status).json({
        error: sessionState.code,
        code: sessionState.code,
        detail: sessionState.detail,
        request_id
      });
    }
    const parentGuard = await requireAgreementClientWhenPresent(agreement, { route: 'membership_agreements_session', agreement_id: agreement.id });
    if (!parentGuard.ok) return respondWithAgreementClientGuard(res, parentGuard, request_id);

    let openedAt = agreement.opened_at || null;
    if (sessionState.state === 'signable' && !openedAt) {
      openedAt = new Date().toISOString();
      const { error: openedErr } = await supabaseAdmin
        .from('membership_agreements')
        .update({ opened_at: openedAt, updated_at: openedAt })
        .eq('id', agreement.id);
      if (openedErr) {
        console.error('[membership-agreements/session] opened_at_update_failed', {
          request_id,
          agreement_id: agreement.id,
          error: openedErr.message,
          code: openedErr.code
        });
      }
    }

    const draftPdfUrl =
      sessionState.state === 'signable'
        ? await createAgreementSignedUrl(agreement.draft_pdf_path, SIGNED_URL_TTL_SECONDS)
        : null;
    const executedPdfUrl =
      sessionState.state !== 'signable'
        ? await createAgreementSignedUrl(agreement.executed_pdf_path, SIGNED_URL_TTL_SECONDS)
        : null;

    return res.json({
      ok: true,
      session: {
        agreement_id: agreement.id,
        state: sessionState.state,
        status: agreement.status,
        is_current: agreement.is_current === true,
        checkout_status: agreement.checkout_status || null,
        client_legal_name: agreement.client_legal_name,
        dba_trade_name: agreement.dba_trade_name,
        primary_admin_name: agreement.primary_admin_name,
        admin_email: agreement.admin_email,
        membership_tier: agreement.membership_tier,
        billing_option: agreement.billing_option,
        auto_renew: agreement.auto_renew,
        notice_deadline_days: agreement.notice_deadline_days,
        initial_term_start: agreement.initial_term_start,
        initial_renewal_date: agreement.initial_renewal_date,
        expires_at: agreement.signer_token_expires_at,
        sent_at: agreement.sent_at,
        signed_at: agreement.signed_at,
        opened_at: openedAt,
        draft_pdf_url: draftPdfUrl,
        executed_pdf_url: executedPdfUrl
      },
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/session] unexpected', { request_id, error: e?.message || e, code: e?.code || null });
    return res.status(500).json({
      error: 'server_error',
      code: e?.code || 'server_error',
      detail: extractErrorMessage(e?.message || '', 'Server error.'),
      request_id
    });
  }
});

router.post('/sign', publicAgreementTokenRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(400).json({
        error: 'token_required',
        code: 'token_required',
        detail: 'Signing token is required.',
        request_id
      });
    }

    const typedName = String(req.body?.typed_name || req.body?.typedName || '').trim();
    if (!typedName) {
      return res.status(400).json({
        error: 'typed_name_required',
        code: 'typed_name_required',
        detail: 'Typed name is required.',
        request_id
      });
    }

    const accepted = normalizeAccepted(req.body?.accepted ?? req.body?.agreement_accepted ?? req.body?.agreementAccepted);
    if (!accepted) {
      return res.status(400).json({
        error: 'agreement_acceptance_required',
        code: 'agreement_acceptance_required',
        detail: 'Agreement acceptance checkbox is required.',
        request_id
      });
    }

    let signaturePayload;
    try {
      signaturePayload = parseSignaturePayload(req.body?.signature_image || req.body?.signatureImage || req.body?.signature_image_data_url || req.body?.signatureDataUrl);
    } catch (signatureErr) {
      return res.status(400).json({
        error: signatureErr.code || 'signature_invalid',
        code: signatureErr.code || 'signature_invalid',
        detail: 'A drawn signature image is required.',
        request_id
      });
    }

    const tokenHash = hashToken(token);
    const agreement = await loadAgreementByTokenHash(tokenHash);
    const validation = validateSignableAgreement(agreement);
    if (!validation.ok) {
      return res.status(validation.status).json({
        error: validation.code,
        code: validation.code,
        detail: validation.detail,
        request_id
      });
    }
    const parentGuard = await requireAgreementClientWhenPresent(agreement, { route: 'membership_agreements_sign', agreement_id: agreement.id });
    if (!parentGuard.ok) return respondWithAgreementClientGuard(res, parentGuard, request_id);

    const signedAt = new Date().toISOString();
    const signatureSha256 = crypto.createHash('sha256').update(signaturePayload.buffer).digest('hex');
    const clientSlug = slugify(agreement.client_legal_name);
    const signaturePath = `membership-agreements/${agreement.id}/signature.${signaturePayload.ext}`;

    const signatureUpload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(signaturePath, signaturePayload.buffer, {
        contentType: signaturePayload.mime,
        upsert: true
      });

    if (signatureUpload.error) {
      console.error('[membership-agreements/sign] signature_upload_failed', {
        request_id,
        agreement_id: agreement.id,
        error: signatureUpload.error.message,
        code: signatureUpload.error.code
      });
      return res.status(500).json({
        error: 'signature_upload_failed',
        code: signatureUpload.error.code || 'signature_upload_failed',
        detail: signatureUpload.error.message,
        request_id
      });
    }

    const agreementInput = buildAgreementInputFromRow(agreement);
    const { html } = buildMembershipAgreementHtml(agreementInput, {
      showPackageTerms: isPublicPurchaseIntentAgreement(agreement),
      execution: {
        accepted: true,
        signer_typed_name: typedName,
        signature_image_src: signaturePayload.dataUrl,
        signed_at: signedAt
      }
    });

    const executedPdf = await htmlToPdf(html, {
      format: 'Letter',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
    });

    const executedPdfPath = `membership-agreements/${agreement.id}/${clientSlug}-executed.pdf`;
    const executedUpload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(executedPdfPath, executedPdf, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (executedUpload.error) {
      console.error('[membership-agreements/sign] executed_pdf_upload_failed', {
        request_id,
        agreement_id: agreement.id,
        error: executedUpload.error.message,
        code: executedUpload.error.code
      });
      return res.status(500).json({
        error: 'executed_pdf_upload_failed',
        code: executedUpload.error.code || 'executed_pdf_upload_failed',
        detail: executedUpload.error.message,
        request_id
      });
    }

    const ipAddress = getClientIp(req);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 1024) || null;
    const nextTemplateSnapshot = {
      ...(agreement.template_snapshot && typeof agreement.template_snapshot === 'object' ? agreement.template_snapshot : {}),
      execution: {
        signed_at: signedAt,
        signer_typed_name: typedName,
        signer_accepted: true,
        signature_sha256: signatureSha256,
        signature_image_path: signaturePath,
        executed_pdf_path: executedPdfPath,
        signer_ip: ipAddress,
        signer_user_agent: userAgent
      }
    };

    const { data: signingRows, error: updateErr } = await supabaseAdmin
      .rpc('complete_membership_agreement_signing', {
        p_agreement_id: agreement.id,
        p_signed_at: signedAt,
        p_opened_at: agreement.opened_at || signedAt,
        p_signer_typed_name: typedName,
        p_signature_image_path: signaturePath,
        p_signature_sha256: signatureSha256,
        p_signer_ip: ipAddress,
        p_signer_user_agent: userAgent,
        p_executed_pdf_path: executedPdfPath,
        p_template_snapshot: nextTemplateSnapshot
      });
    const updatedAgreement = Array.isArray(signingRows) ? (signingRows[0] || null) : (signingRows || null);

    if (updateErr) {
      console.error('[membership-agreements/sign] status_update_failed', {
        request_id,
        agreement_id: agreement.id,
        error: updateErr.message,
        code: updateErr.code,
        hint: updateErr.hint
      });
      return res.status(500).json({
        error: 'status_update_failed',
        code: updateErr.code || 'status_update_failed',
        detail: updateErr.message,
        hint: updateErr.hint,
        request_id
      });
    }

    if (!updatedAgreement) {
      return res.status(409).json({
        error: 'agreement_not_signable',
        code: 'agreement_not_signable',
        detail: 'This agreement was already signed or is no longer signable.',
        request_id
      });
    }

    const emailDownloadUrl = await createAgreementSignedUrl(executedPdfPath, EMAIL_SIGNED_URL_TTL_SECONDS);
    const responseDownloadUrl = await createAgreementSignedUrl(executedPdfPath, SIGNED_URL_TTL_SECONDS);
    const executedPdfBuffer = Buffer.isBuffer(executedPdf)
      ? executedPdf
      : ArrayBuffer.isView(executedPdf)
        ? Buffer.from(executedPdf.buffer, executedPdf.byteOffset, executedPdf.byteLength)
        : Buffer.from(executedPdf);

    try {
      const signedCopyEmailResult = await sendMembershipAgreementSignedCopyEmail(updatedAgreement.admin_email, {
        client_legal_name: updatedAgreement.client_legal_name,
        primary_admin_name: updatedAgreement.primary_admin_name,
        signer_typed_name: typedName,
        signed_at: signedAt,
        executed_pdf_url: emailDownloadUrl,
        pdf_base64: executedPdfBuffer.toString('base64'),
        file_name: `${clientSlug}-membership-agreement-signed.pdf`
      });
      if (!signedCopyEmailResult || signedCopyEmailResult.skipped) {
        console.warn('[membership-agreements/sign] signed_copy_email_skipped', {
          request_id,
          agreement_id: updatedAgreement.id || agreement.id,
          result: signedCopyEmailResult || null
        });
      } else {
        console.info('[membership-agreements/sign] signed_copy_email_sent', {
          request_id,
          agreement_id: updatedAgreement.id || agreement.id,
          status_code: signedCopyEmailResult.statusCode || null
        });
      }
    } catch (emailErr) {
      const sendgridResponseBody = emailErr?.response?.body || null;
      const sendgridResponseErrors = Array.isArray(sendgridResponseBody?.errors)
        ? sendgridResponseBody.errors
        : null;
      console.error('[membership-agreements/sign] signed_copy_email_failed', {
        request_id,
        agreement_id: updatedAgreement.id || agreement.id,
        message: emailErr?.message || String(emailErr || ''),
        code: emailErr?.code || null,
        status: emailErr?.response?.statusCode || emailErr?.statusCode || null,
        response_body: sendgridResponseBody,
        response_errors: sendgridResponseErrors
      });
    }

    try {
      await sendMembershipAgreementCompletedInternalNotification(MEMBERSHIP_INTERNAL_NOTIFY_EMAIL, {
        agreement_id: updatedAgreement.id,
        client_legal_name: updatedAgreement.client_legal_name,
        primary_admin_name: updatedAgreement.primary_admin_name,
        admin_email: updatedAgreement.admin_email,
        signer_typed_name: typedName,
        signed_at: signedAt
      });
    } catch (notifyErr) {
      console.error('[membership-agreements/sign] internal_completion_email_failed', {
        request_id,
        agreement_id: agreement.id,
        error: notifyErr?.message || notifyErr
      });
    }

    return res.json({
      ok: true,
      agreement: {
        id: updatedAgreement.id,
        status: updatedAgreement.status,
        signed_at: updatedAgreement.signed_at,
        signer_typed_name: updatedAgreement.signer_typed_name
      },
      executed_pdf_url: responseDownloadUrl,
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/sign] unexpected', { request_id, error: e?.message || e, code: e?.code || null });
    return res.status(500).json({
      error: 'server_error',
      code: e?.code || 'server_error',
      detail: extractErrorMessage(e?.message || '', 'Server error.'),
      request_id
    });
  }
});


module.exports = router;
