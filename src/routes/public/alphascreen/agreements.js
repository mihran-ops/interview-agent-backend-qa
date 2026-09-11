'use strict';

// Agreement creation for a verified purchase intent.

const express = require('express');
const {
  AGREEMENTS_BUCKET,
  RETAIL_AGREEMENT_RATE_MAX,
  SIGNING_LINK_TTL_MS,
  UUID_RE,
  buildAgreementInputFromPurchaseIntent,
  buildAgreementResponse,
  buildMembershipAgreementHtml,
  buildMembershipAgreementSignUrl,
  crypto,
  enforceRetailRateLimit,
  hasValidRetailEmailVerification,
  htmlToPdf,
  loadRetailSmsVerificationState,
  refreshAgreementSigningUrl,
  slugify,
  supabaseAdmin,
  trimText,
  validateAgreementInput,
  validatePurchaseIntentForAgreement,
} = require('../../../services/alphaScreen/index');

const router = express.Router();

router.post('/purchase-intents/:id/agreement', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  if (!UUID_RE.test(intentId)) {
    return res.status(400).json({
      error: 'purchase_intent_id_required',
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.',
      request_id
    })
  }

  const allowed = await enforceRetailRateLimit(req, res, {
    routeName: 'retail_agreement_create',
    subjectParts: ['agreement_create', intentId],
    maxCount: RETAIL_AGREEMENT_RATE_MAX
  })
  if (!allowed) return

  try {
    const { data: intent, error: intentErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,company_legal_name,company_dba,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,buyer_title,source_path,agreement_id,stripe_checkout_session_id,client_id,email_verified_at,email_verified_address,email_verification_method,email_verification_version,phone_verified_at,phone_verified_destination_fingerprint,phone_verification_method,phone_verification_version,expires_at,created_at')
      .eq('id', intentId)
      .maybeSingle()

    if (intentErr) {
      console.error('[alphascreen/purchase-intents/agreement] intent_lookup_failed:', intentErr.message || intentErr)
      return res.status(503).json({
        error: 'purchase_intent_lookup_failed',
        code: intentErr.code || 'purchase_intent_lookup_failed',
        request_id
      })
    }

    const intentValidation = validatePurchaseIntentForAgreement(intent)
    if (!intentValidation.ok) {
      return res.status(intentValidation.status).json({
        error: intentValidation.code,
        code: intentValidation.code,
        detail: intentValidation.detail,
        request_id
      })
    }

    let existingAgreement = null
    if (intent.agreement_id) {
      const { data, error: existingErr } = await supabaseAdmin
        .from('membership_agreements')
        .select('id,status,signer_token_expires_at,draft_pdf_path,sent_at')
        .eq('id', intent.agreement_id)
        .maybeSingle()

      if (existingErr) {
        console.error('[alphascreen/purchase-intents/agreement] existing_agreement_lookup_failed:', existingErr.message || existingErr)
        return res.status(503).json({
          error: 'agreement_lookup_failed',
          code: existingErr.code || 'agreement_lookup_failed',
          request_id
        })
      }

      existingAgreement = data
    }

    let contactVerified = hasValidRetailEmailVerification(intent)
    if (!contactVerified) {
      try {
        const smsState = await loadRetailSmsVerificationState(supabaseAdmin, intent, process.env)
        contactVerified = smsState.verified === true
      } catch (error) {
        console.error('[alphascreen/purchase-intents/agreement] sms_verification_lookup_failed:', error?.code || 'unknown')
      }
    }

    if (!contactVerified) {
      if (existingAgreement && String(existingAgreement.status || '').trim().toLowerCase() === 'signed') {
        return res.status(409).json({
          error: 'agreement_not_signable',
          code: 'agreement_not_signable',
          detail: 'The linked agreement is not available for signing.',
          request_id
        })
      }
      return res.status(409).json({
        error: 'retail_contact_verification_required',
        code: 'RETAIL_CONTACT_VERIFICATION_REQUIRED',
        detail: 'Verify the buyer by email or text message before continuing to the membership agreement.',
        request_id
      })
    }

    if (existingAgreement) {
      if (existingAgreement && String(existingAgreement.status || '').trim().toLowerCase() === 'sent') {
        const refreshed = await refreshAgreementSigningUrl(existingAgreement)
        const responseIntent = { ...intent, status: 'agreement_pending' }
        const body = buildAgreementResponse(responseIntent, refreshed.agreement, refreshed.signingUrl, { refreshed: true })
        body.request_id = request_id
        return res.json(body)
      }

      if (existingAgreement) {
        return res.status(409).json({
          error: 'agreement_not_signable',
          code: 'agreement_not_signable',
          detail: 'The linked agreement is not available for signing.',
          request_id
        })
      }
    }

    const agreementInput = buildAgreementInputFromPurchaseIntent(intent)
    const agreementInputValidation = validateAgreementInput(agreementInput)
    if (!agreementInputValidation.ok) {
      return res.status(agreementInputValidation.status).json({
        error: agreementInputValidation.code,
        code: agreementInputValidation.code,
        detail: agreementInputValidation.detail,
        fields: agreementInputValidation.fields,
        request_id
      })
    }

    const { html, normalized } = buildMembershipAgreementHtml(agreementInput, { showPackageTerms: true })
    const pdf = await htmlToPdf(html, {
      format: 'Letter',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
    })

    const agreementId = crypto.randomUUID()
    const clientSlug = slugify(normalized.client_legal_name)
    const draftPdfPath = `membership-agreements/${agreementId}/${clientSlug}-draft.pdf`

    const upload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(draftPdfPath, pdf, {
        contentType: 'application/pdf',
        upsert: true
      })

    if (upload.error) {
      console.error('[alphascreen/purchase-intents/agreement] draft_upload_failed:', upload.error.message || upload.error)
      return res.status(500).json({
        error: 'draft_upload_failed',
        code: upload.error.code || 'draft_upload_failed',
        detail: upload.error.message || 'Agreement draft could not be stored.',
        request_id
      })
    }

    const signerToken = crypto.randomBytes(32).toString('hex')
    const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex')
    const signerTokenExpiresAt = new Date(Date.now() + SIGNING_LINK_TTL_MS).toISOString()
    const signingUrl = buildMembershipAgreementSignUrl(signerToken)
    const nowIso = new Date().toISOString()
    const templateSnapshot = {
      template_name: 'membership-agreement',
      template_version: 'membership_agreement_v2_phase1',
      source: 'public_purchase_intent',
      source_document: 'alphaScreen Membership Agreementv2.docx',
      generated_at: nowIso,
      purchase_intent: {
        id: intent.id,
        source_path: intent.source_path || null,
        selected_plan_key: intent.selected_plan_key,
        selected_billing_cadence: intent.selected_billing_cadence,
        first_role_prepay_selected: intent.first_role_prepay_selected === true
      },
      package_snapshot: intentValidation.snapshot,
      values: normalized,
      rendered_html: html
    }

    const { data: insertedAgreement, error: insertErr } = await supabaseAdmin
      .from('membership_agreements')
      .insert({
        id: agreementId,
        client_id: null,
        status: 'sent',
        client_legal_name: normalized.client_legal_name,
        dba_trade_name: normalized.dba_trade_name || null,
        primary_admin_name: normalized.primary_admin_name,
        admin_email: normalized.admin_email,
        membership_tier: normalized.membership_tier,
        initial_term_start: normalized.initial_term_start,
        initial_renewal_date: normalized.initial_renewal_date,
        billing_option: normalized.billing_option,
        auto_renew: normalized.auto_renew,
        notice_deadline_days: normalized.notice_deadline_days,
        template_version: 'membership_agreement_v2_phase1',
        template_snapshot: templateSnapshot,
        draft_pdf_path: draftPdfPath,
        signer_token_hash: signerTokenHash,
        signer_token_expires_at: signerTokenExpiresAt,
        sent_at: nowIso,
        created_by_user_id: null,
        created_by_email: 'public_purchase_intent'
      })
      .select('id,status,signer_token_expires_at,draft_pdf_path,sent_at')
      .single()

    if (insertErr) {
      console.error('[alphascreen/purchase-intents/agreement] agreement_insert_failed:', insertErr.message || insertErr)
      return res.status(503).json({
        error: 'agreement_create_failed',
        code: insertErr.code || 'agreement_create_failed',
        request_id
      })
    }

    const { data: updatedIntent, error: updateErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .update({
        status: 'agreement_pending',
        agreement_id: agreementId,
        updated_at: nowIso
      })
      .eq('id', intent.id)
      .select('id,status,package_snapshot,agreement_id')
      .single()

    if (updateErr) {
      console.error('[alphascreen/purchase-intents/agreement] intent_update_failed:', updateErr.message || updateErr)
      return res.status(503).json({
        error: 'purchase_intent_agreement_link_failed',
        code: updateErr.code || 'purchase_intent_agreement_link_failed',
        request_id
      })
    }

    const body = buildAgreementResponse(
      { ...intent, ...(updatedIntent || {}), package_snapshot: intent.package_snapshot },
      insertedAgreement,
      signingUrl
    )
    body.request_id = request_id
    return res.status(201).json(body)
  } catch (e) {
    console.error('[alphascreen/purchase-intents/agreement] unexpected:', e?.message || e)
    return res.status(Number(e?.status) || 500).json({
      error: e?.code || 'server_error',
      code: e?.code || 'server_error',
      detail: e?.message || 'Server error',
      request_id
    })
  }
})


module.exports = router;
