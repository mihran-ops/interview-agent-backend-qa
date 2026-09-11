'use strict';

// Retail email and SMS verification for a purchase intent.

const express = require('express');
const {
  RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  RETAIL_EMAIL_VERIFICATION_SEND_RATE_MAX,
  RETAIL_EMAIL_VERIFICATION_STATUS_RATE_MAX,
  RETAIL_EMAIL_VERIFICATION_TTL_SECONDS,
  RETAIL_EMAIL_VERIFICATION_VERIFY_RATE_MAX,
  RETAIL_SMS_CONSENT_COPY_VERSION,
  RETAIL_SMS_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  RETAIL_SMS_VERIFICATION_SEND_RATE_MAX,
  RETAIL_SMS_VERIFICATION_STATUS_RATE_MAX,
  RETAIL_SMS_VERIFICATION_TTL_SECONDS,
  RETAIL_SMS_VERIFICATION_VERIFY_RATE_MAX,
  RETAIL_VERIFICATION_INTENT_SELECT,
  RetailSmsVerificationError,
  UUID_RE,
  consumeRetailSignupSmsOtp,
  deliverRetailSignupSmsOtp,
  enforceRetailRateLimit,
  generateRetailVerificationCode,
  generateRetailVerificationSalt,
  getRequestSubjectKey,
  hasValidRetailEmailVerification,
  hashRetailVerificationCode,
  invalidateRetailSmsVerification,
  loadLatestRetailEmailVerification,
  loadRetailEmailVerificationStatus,
  loadRetailSmsVerificationState,
  normalizeEmail,
  publicEmailVerificationState,
  publicSmsVerificationState,
  readRetailSmsConfiguration,
  sendRetailSignupEmailVerificationCode,
  sendSmsVerificationResponse,
  sendVerificationResponse,
  supabaseAdmin,
  trimText,
  validatePurchaseIntentForEmailVerification,
  validatePurchaseIntentForSmsVerification,
} = require('../../../services/alphaScreen/index');

const router = express.Router();

router.get('/purchase-intents/:id/email-verification/status', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  if (!UUID_RE.test(intentId)) {
    return sendVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }

  try {
    const { data: intent, error } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()

    if (error) {
      console.error('[alphascreen/email-verification] status_lookup_failed:', error?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForEmailVerification(intent)
    if (!validation.ok) {
      return sendVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }

    const buyerEmail = normalizeEmail(intent.buyer_email)
    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_email_verification_status',
      subjectParts: ['email_verification_status', intent.id, getRequestSubjectKey(req)],
      maxCount: RETAIL_EMAIL_VERIFICATION_STATUS_RATE_MAX
    })
    if (!allowed) return

    const {
      verification,
      resendCooldownSeconds,
      error: verificationError
    } = await loadRetailEmailVerificationStatus(intent.id, buyerEmail)
    if (verificationError) {
      console.error('[alphascreen/email-verification] status_verification_lookup_failed:', verificationError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    return res.json({
      ok: true,
      email_verification: publicEmailVerificationState(intent, verification, resendCooldownSeconds),
      request_id
    })
  } catch (error) {
    console.error('[alphascreen/email-verification] status_failed:', error?.code || 'unknown')
    return sendVerificationResponse(res, req, 500)
  }
})

router.post('/purchase-intents/:id/email-verification/send', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  if (!UUID_RE.test(intentId)) {
    return sendVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }

  try {
    const { data: intent, error: intentError } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()

    if (intentError) {
      console.error('[alphascreen/email-verification] send_lookup_failed:', intentError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForEmailVerification(intent)
    if (!validation.ok) {
      return sendVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }

    const buyerEmail = normalizeEmail(intent.buyer_email)
    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_email_verification_send',
      subjectParts: ['email_verification_send', intent.id, buyerEmail],
      maxCount: RETAIL_EMAIL_VERIFICATION_SEND_RATE_MAX
    })
    if (!allowed) return

    const { verification: latestVerification, error: latestVerificationError } = await loadLatestRetailEmailVerification(intent.id, buyerEmail)
    if (latestVerificationError) {
      console.error('[alphascreen/email-verification] send_verification_lookup_failed:', latestVerificationError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    if (hasValidRetailEmailVerification(intent)) {
      return res.json({
        ok: true,
        email_verification: publicEmailVerificationState(intent, latestVerification),
        request_id
      })
    }

    try {
      await invalidateRetailSmsVerification(supabaseAdmin, intent.id, 'channel_changed_to_email')
    } catch (error) {
      console.error('[alphascreen/email-verification] sms_supersede_failed:', error?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const verificationCode = generateRetailVerificationCode()
    const verificationSalt = generateRetailVerificationSalt()
    const verificationHash = hashRetailVerificationCode(verificationCode, verificationSalt)
    const { data: issuedRows, error: issueError } = await supabaseAdmin.rpc('issue_retail_signup_email_verification', {
      p_purchase_intent_id: intent.id,
      p_buyer_email: buyerEmail,
      p_plan_key: intent.selected_plan_key,
      p_billing_cadence: intent.selected_billing_cadence,
      p_code_hash: verificationHash,
      p_code_salt: verificationSalt
    })
    const issued = Array.isArray(issuedRows) ? issuedRows[0] : issuedRows

    if (issueError || !issued?.status) {
      console.error('[alphascreen/email-verification] issue_failed:', issueError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }
    if (issued.status === 'resend_cooldown') {
      return sendVerificationResponse(res, req, 429, {
        code: 'RETAIL_EMAIL_VERIFICATION_COOLDOWN',
        detail: 'Please wait before requesting another code.',
        retryAfterSeconds: Number(issued.resend_after_seconds || RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS)
      })
    }
    if (issued.status === 'hourly_limit') {
      return sendVerificationResponse(res, req, 429, {
        code: 'RETAIL_EMAIL_VERIFICATION_SEND_LIMIT',
        detail: 'Too many verification codes were requested. Try again later.',
        retryAfterSeconds: Number(issued.resend_after_seconds || 60 * 60)
      })
    }
    if (issued.status !== 'issued' || !issued.verification_id) {
      return sendVerificationResponse(res, req, 409, {
        code: 'RETAIL_EMAIL_VERIFICATION_NOT_ELIGIBLE'
      })
    }

    try {
      const delivery = await sendRetailSignupEmailVerificationCode(buyerEmail, verificationCode, {
        purchaseIntentId: intent.id,
        verificationId: issued.verification_id
      })
      if (delivery?.skipped) throw new Error('email_delivery_not_configured')
    } catch (error) {
      await supabaseAdmin
        .from('retail_signup_email_verifications')
        .update({
          invalidated_at: new Date().toISOString(),
          invalidation_reason: 'delivery_failed',
          updated_at: new Date().toISOString()
        })
        .eq('id', issued.verification_id)
        .is('used_at', null)
      console.error('[alphascreen/email-verification] send_failed:', error?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, {
        code: 'RETAIL_EMAIL_VERIFICATION_SEND_FAILED',
        detail: 'We couldn\'t send the verification code. Try again in a moment.'
      })
    }

    return res.status(202).json({
      ok: true,
      email_verification: {
        verified: false,
        status: 'code_sent',
        code_active: true,
        expires_in_seconds: RETAIL_EMAIL_VERIFICATION_TTL_SECONDS,
        resend_cooldown_seconds: Number(issued.resend_after_seconds || RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS)
      },
      request_id
    })
  } catch (error) {
    console.error('[alphascreen/email-verification] send_unexpected:', error?.code || 'unknown')
    return sendVerificationResponse(res, req, 500)
  }
})

router.post('/purchase-intents/:id/email-verification/verify', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  const code = trimText(req.body?.code, 12)
  if (!UUID_RE.test(intentId)) {
    return sendVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }
  if (!/^\d{6}$/.test(code)) {
    return sendVerificationResponse(res, req, 400, {
      code: 'RETAIL_EMAIL_VERIFICATION_INVALID_CODE',
      detail: 'That code is not valid. Check the code and try again.'
    })
  }

  try {
    const { data: intent, error: intentError } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()

    if (intentError) {
      console.error('[alphascreen/email-verification] verify_lookup_failed:', intentError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForEmailVerification(intent)
    if (!validation.ok) {
      return sendVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }
    if (hasValidRetailEmailVerification(intent)) {
      return res.json({ ok: true, email_verification: publicEmailVerificationState(intent), request_id })
    }

    const buyerEmail = normalizeEmail(intent.buyer_email)
    const { verification, error: verificationError } = await loadLatestRetailEmailVerification(intent.id, buyerEmail)

    if (verificationError) {
      console.error('[alphascreen/email-verification] verify_token_lookup_failed:', verificationError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_email_verification_verify',
      subjectParts: ['email_verification_verify', intent.id, verification?.id || 'no_active_verification', buyerEmail],
      maxCount: RETAIL_EMAIL_VERIFICATION_VERIFY_RATE_MAX
    })
    if (!allowed) return

    if (!verification?.code_salt) {
      return sendVerificationResponse(res, req, 400, {
        code: 'RETAIL_EMAIL_VERIFICATION_INVALID_CODE',
        detail: 'That code is not valid. Check the code and try again.'
      })
    }

    const { data: consumedRows, error: consumeError } = await supabaseAdmin.rpc('consume_retail_signup_email_verification', {
      p_purchase_intent_id: intent.id,
      p_buyer_email: buyerEmail,
      p_code_hash: hashRetailVerificationCode(code, verification.code_salt)
    })
    const consumed = Array.isArray(consumedRows) ? consumedRows[0] : consumedRows
    const consumeStatus = String(consumed?.status || '').trim()

    if (consumeError || !consumeStatus) {
      console.error('[alphascreen/email-verification] consume_failed:', consumeError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }
    if (consumeStatus === 'verified') {
      return res.json({
        ok: true,
        email_verification: {
          verified: true,
          status: 'verified',
          code_active: false,
          expires_in_seconds: 0,
          resend_cooldown_seconds: 0
        },
        request_id
      })
    }
    if (consumeStatus === 'expired') {
      return sendVerificationResponse(res, req, 400, {
        code: 'RETAIL_EMAIL_VERIFICATION_EXPIRED',
        detail: 'That code has expired. Request a new code.'
      })
    }
    if (consumeStatus === 'attempt_limit') {
      return sendVerificationResponse(res, req, 429, {
        code: 'RETAIL_EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED',
        detail: 'Too many unsuccessful attempts. Request a new code.'
      })
    }
    return sendVerificationResponse(res, req, 400, {
      code: 'RETAIL_EMAIL_VERIFICATION_INVALID_CODE',
      detail: 'That code is not valid. Check the code and try again.'
    })
  } catch (error) {
    console.error('[alphascreen/email-verification] verify_unexpected:', error?.code || 'unknown')
    return sendVerificationResponse(res, req, 500)
  }
})

router.get('/purchase-intents/:id/sms-verification/status', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  if (!UUID_RE.test(intentId)) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }

  try {
    const { data: intent, error } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()
    if (error) {
      console.error('[alphascreen/sms-verification] status_lookup_failed:', error?.code || 'unknown')
      return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForSmsVerification(intent)
    if (!validation.ok) {
      return sendSmsVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }

    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_sms_verification_status',
      subjectParts: ['sms_verification_status', intent.id, getRequestSubjectKey(req)],
      maxCount: RETAIL_SMS_VERIFICATION_STATUS_RATE_MAX
    })
    if (!allowed) return

    const config = readRetailSmsConfiguration(process.env)
    if (!config.valid) {
      return res.json({
        ok: true,
        sms_verification: publicSmsVerificationState({ available: false }),
        request_id
      })
    }
    const state = await loadRetailSmsVerificationState(supabaseAdmin, intent, process.env)
    return res.json({ ok: true, sms_verification: publicSmsVerificationState(state), request_id })
  } catch (error) {
    console.error('[alphascreen/sms-verification] status_failed:', error?.code || 'unknown')
    return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
  }
})

router.post('/purchase-intents/:id/sms-verification/send', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  const consentCopyVersion = trimText(req.body?.consent_copy_version, 80)
  let providerSendStartedAtMs = null
  if (!UUID_RE.test(intentId)) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }
  if (consentCopyVersion !== RETAIL_SMS_CONSENT_COPY_VERSION) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'RETAIL_SMS_CONSENT_REQUIRED',
      detail: 'Select Text Message and review the text-message disclosure before requesting a code.'
    })
  }

  try {
    const { data: intent, error } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()
    if (error) {
      console.error('[alphascreen/sms-verification] send_lookup_failed:', error?.code || 'unknown')
      return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForSmsVerification(intent)
    if (!validation.ok) {
      return sendSmsVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }

    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_sms_verification_send',
      subjectParts: ['sms_verification_send', intent.id],
      maxCount: RETAIL_SMS_VERIFICATION_SEND_RATE_MAX
    })
    if (!allowed) return

    const current = await loadRetailSmsVerificationState(supabaseAdmin, intent, process.env)
    if (current.verified) {
      return res.json({ ok: true, sms_verification: publicSmsVerificationState(current), request_id })
    }

    providerSendStartedAtMs = Date.now()
    const result = await deliverRetailSignupSmsOtp({
      db: supabaseAdmin,
      intent,
      requestIp: getRequestSubjectKey(req),
      consentCopyVersion,
      env: process.env
    })
    console.info('[alphascreen/sms-verification] send_outcome', {
      outcome: result.outcome || 'unknown',
      provider_status: result.status || null,
      request_duration_ms: Math.max(0, Date.now() - providerSendStartedAtMs),
      retry_attempted: result.retryAttempted === true,
      failover_attempted: result.failoverAttempted === true
    })
    if (result.outcome !== 'accepted') {
      if (result.outcome === 'invalid_destination') {
        return sendSmsVerificationResponse(res, req, 409, {
          code: 'RETAIL_SMS_VERIFICATION_INVALID_DESTINATION',
          detail: 'Text verification requires a valid U.S. mobile number. Choose email instead.'
        })
      }
      if (result.outcome === 'blocked_destination') {
        return sendSmsVerificationResponse(res, req, 409, {
          code: 'RETAIL_SMS_VERIFICATION_BLOCKED',
          detail: 'Text verification is unavailable for this number. Choose email instead.'
        })
      }
      return sendSmsVerificationResponse(res, req, 503, {
        code: result.outcome === 'ambiguous_outcome'
          ? 'RETAIL_SMS_VERIFICATION_SEND_UNCERTAIN'
          : 'RETAIL_SMS_VERIFICATION_SEND_FAILED',
        detail: 'We could not confirm text delivery. Choose email or try again.'
      })
    }

    return res.status(202).json({
      ok: true,
      sms_verification: {
        available: true,
        verified: false,
        status: 'code_sent',
        code_active: true,
        expires_in_seconds: RETAIL_SMS_VERIFICATION_TTL_SECONDS,
        resend_cooldown_seconds: Number(result.retryAfterSeconds || RETAIL_SMS_VERIFICATION_RESEND_COOLDOWN_SECONDS)
      },
      request_id
    })
  } catch (error) {
    if (error instanceof RetailSmsVerificationError) {
      if (error.code === 'RETAIL_SMS_VERIFICATION_COOLDOWN') {
        return sendSmsVerificationResponse(res, req, 429, {
          code: error.code,
          detail: 'Please wait before requesting another code.',
          retryAfterSeconds: error.retryAfterSeconds
        })
      }
      if (error.code === 'RETAIL_SMS_VERIFICATION_SEND_LIMIT') {
        return sendSmsVerificationResponse(res, req, 429, {
          code: error.code,
          detail: 'Too many verification codes were requested. Choose email or try again later.',
          retryAfterSeconds: error.retryAfterSeconds
        })
      }
    }
    console.error('[alphascreen/sms-verification] send_failed:', {
      code: error?.code || 'unknown',
      request_duration_ms: providerSendStartedAtMs === null ? null : Math.max(0, Date.now() - providerSendStartedAtMs)
    })
    return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
  }
})

router.post('/purchase-intents/:id/sms-verification/verify', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  const code = trimText(req.body?.code, 12)
  if (!UUID_RE.test(intentId)) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }
  if (!/^\d{6}$/.test(code)) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'RETAIL_SMS_VERIFICATION_INVALID_CODE',
      detail: 'That code is not valid. Check the code and try again.'
    })
  }

  try {
    const { data: intent, error } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()
    if (error) {
      console.error('[alphascreen/sms-verification] verify_lookup_failed:', error?.code || 'unknown')
      return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForSmsVerification(intent)
    if (!validation.ok) {
      return sendSmsVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }
    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_sms_verification_verify',
      subjectParts: ['sms_verification_verify', intent.id],
      maxCount: RETAIL_SMS_VERIFICATION_VERIFY_RATE_MAX
    })
    if (!allowed) return

    const current = await loadRetailSmsVerificationState(supabaseAdmin, intent, process.env)
    if (current.verified) {
      return res.json({ ok: true, sms_verification: publicSmsVerificationState(current), request_id })
    }
    const consumed = await consumeRetailSignupSmsOtp({ db: supabaseAdmin, intent, code, env: process.env })
    if (consumed.status === 'verified') {
      return res.json({
        ok: true,
        sms_verification: {
          available: true,
          verified: true,
          status: 'verified',
          code_active: false,
          expires_in_seconds: 0,
          resend_cooldown_seconds: 0
        },
        request_id
      })
    }
    if (consumed.status === 'expired') {
      return sendSmsVerificationResponse(res, req, 400, {
        code: 'RETAIL_SMS_VERIFICATION_EXPIRED',
        detail: 'That code has expired. Request a new code.'
      })
    }
    if (consumed.status === 'attempt_limit') {
      return sendSmsVerificationResponse(res, req, 429, {
        code: 'RETAIL_SMS_VERIFICATION_ATTEMPTS_EXCEEDED',
        detail: 'Too many unsuccessful attempts. Request a new code.'
      })
    }
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'RETAIL_SMS_VERIFICATION_INVALID_CODE',
      detail: 'That code is not valid. Check the code and try again.'
    })
  } catch (error) {
    console.error('[alphascreen/sms-verification] verify_failed:', error?.code || 'unknown')
    return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
  }
})


module.exports = router;
