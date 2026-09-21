'use strict'

const express = require('express')
const crypto = require('crypto')
const { supabaseAdmin } = require('../../clients/supabase')
const { htmlToPdf } = require('../../render/pdfRenderer')
const { buildMembershipAgreementHtml } = require('../../render/membershipAgreement')
const {
  sendMembershipAgreementEmail,
  sendSubscriptionCheckoutEmail
} = require('../../clients/sendgrid')
const { buildMembershipAgreementSignUrl } = require('../../config/urlConfig')
const { checkAndIncrementRateLimit, hashRateLimitSubject } = require('../../services/rateLimit')
const {
  agreementInputFromDraft,
  agreementSchedule,
  calculatePricing,
  fingerprint,
  listSalesPackages,
  makeSalesError,
  normalizeSalesDraft,
  safeDeal,
  safePromotionSummary,
  validateSalesDraft
} = require('../../services/salesWorkspace')

const AGREEMENTS_BUCKET = process.env.SUPABASE_AGREEMENTS_BUCKET || 'agreements'
const PREVIEW_TTL_MS = 15 * 60 * 1000
const LEGACY_SIGNING_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,255}$/
const SALES_RATE_WINDOW_MS = 10 * 60 * 1000
const SALES_RATE_LIMITS = Object.freeze({
  create: 10,
  resend_agreement: 10,
  send_payment_reminder: 10
})
const INTENT_COLUMNS = [
  'id', 'status', 'selected_plan_key', 'selected_billing_cadence', 'package_snapshot',
  'company_legal_name', 'company_dba', 'buyer_first_name', 'buyer_last_name',
  'buyer_email', 'buyer_phone', 'buyer_title', 'agreement_id',
  'stripe_checkout_session_id', 'client_id', 'created_at', 'updated_at', 'expires_at',
  'created_by_user_id', 'created_by_email', 'ghl_contact_id', 'ghl_opportunity_id',
  'sales_note', 'candidate_assistance_name', 'candidate_assistance_email',
  'promotion_code_id', 'promotion_code', 'promotion_label', 'promotion_amount_off_cents',
  'promotion_percent_off', 'promotion_discount_cents', 'platform_fee_cents',
  'initial_payment_cents', 'term_start_basis', 'activated_at', 'canceled_at',
  'activation_claimed_at', 'activation_claim_key',
  'sales_preview_id'
].join(',')
const AGREEMENT_COLUMNS = [
  'id', 'status', 'is_current', 'checkout_status', 'checkout_session_id',
  'client_id', 'sent_at', 'opened_at', 'signed_at', 'signer_token_expires_at',
  'agreement_expires_at', 'checkout_created_at', 'template_snapshot', 'draft_pdf_path',
  'initial_term_start', 'initial_renewal_date', 'superseded_by_agreement_id'
].join(',')

function nowIso() {
  return new Date().toISOString()
}

function replacementCheckoutDisposition(session) {
  if (!session) return 'missing'
  if (String(session.status || '').toLowerCase() === 'complete' || String(session.payment_status || '').toLowerCase() === 'paid') return 'paid'
  if (String(session.status || '').toLowerCase() === 'open') return 'open'
  return 'expired'
}

function requestId(req) {
  return req.request_id || null
}

function errorBody(error, req) {
  return {
    error: error?.code || 'sales_workspace_error',
    code: error?.code || 'sales_workspace_error',
    detail: error?.message || 'The sales request could not be completed.',
    ...(error?.fields ? { fields: error.fields } : {}),
    request_id: requestId(req)
  }
}

function respondError(res, req, error) {
  return res.status(Number(error?.status) || 500).json(errorBody(error, req))
}

function normalizeIdempotencyKey(req) {
  const key = String(req.header('Idempotency-Key') || '').trim()
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw makeSalesError(400, 'idempotency_key_required', 'A valid Idempotency-Key header is required.')
  }
  return key
}

function stripeClient() {
  const secret = String(process.env.STRIPE_SECRET_KEY || '').trim()
  if (!secret) throw makeSalesError(503, 'stripe_not_configured', 'Promotion validation is not available.')
  // Shared singleton (Step 3): built on first use, not at boot.
  return require('../../clients/stripe')
}

function promotionFromStripe(code, promotionCode) {
  const coupon = promotionCode?.coupon || promotionCode?.promotion?.coupon || null
  const percentOff = Number(coupon?.percent_off)
  const amountOff = Number(coupon?.amount_off)
  const amountOffCents = Number.isInteger(amountOff) && amountOff >= 0 ? amountOff : null
  const normalizedPercent = Number.isFinite(percentOff) && percentOff > 0 ? percentOff : null
  let label = 'Approved discount'
  if (normalizedPercent) label = `${normalizedPercent}% off the initial platform fee`
  else if (amountOffCents !== null) label = `$${(amountOffCents / 100).toFixed(2)} off the initial platform fee`
  return safePromotionSummary({
    code,
    promotion_code_id: promotionCode?.id,
    label,
    amount_off_cents: amountOffCents,
    percent_off: normalizedPercent,
    expires_at: promotionCode?.expires_at
      ? new Date(Number(promotionCode.expires_at) * 1000).toISOString()
      : null
  })
}

function promotionEligibilityError(promotionCode, pricing) {
  const restrictions = promotionCode?.restrictions || {}
  const coupon = promotionCode?.coupon || promotionCode?.promotion?.coupon || {}
  const minimumAmount = Number(restrictions.minimum_amount)
  const minimumCurrency = String(restrictions.minimum_amount_currency || '').trim().toLowerCase()
  const couponCurrency = String(coupon?.currency || '').trim().toLowerCase()
  const subtotal = Number(pricing?.platform_fee_cents || 0) + Number(pricing?.first_role_prepay_cents || 0)
  if (restrictions.first_time_transaction === true) return 'This code requires customer history that cannot be verified before account creation.'
  if (Number.isFinite(Number(coupon?.amount_off)) && Number(coupon.amount_off) > 0 && couponCurrency && couponCurrency !== 'usd') {
    return 'This code is not available for USD alphaScreen purchases.'
  }
  if (Number.isFinite(minimumAmount) && minimumAmount > 0) {
    if (minimumCurrency && minimumCurrency !== 'usd') return 'This code is not available for USD alphaScreen purchases.'
    if (subtotal < minimumAmount) return 'This purchase does not meet the code minimum.'
  }
  if (Array.isArray(coupon?.applies_to?.products) && coupon.applies_to.products.length > 0) {
    return 'This product-restricted code is not available in the sales workspace.'
  }
  return ''
}

function createSalesRouter(options = {}) {
  const router = express.Router()
  const db = options.db || supabaseAdmin
  const renderAgreement = options.renderAgreement || buildMembershipAgreementHtml
  const renderPdf = options.renderPdf || htmlToPdf
  const sendAgreementEmail = options.sendAgreementEmail || sendMembershipAgreementEmail
  const sendCheckoutEmail = options.sendCheckoutEmail || sendSubscriptionCheckoutEmail
  const buildSignUrl = options.buildSignUrl || buildMembershipAgreementSignUrl
  const getStripe = options.getStripe || stripeClient
  const rateLimit = options.rateLimit || checkAndIncrementRateLimit

  async function enforceSalesRateLimit(req, res, action) {
    const maxCount = SALES_RATE_LIMITS[action]
    if (!maxCount) return true
    try {
      const result = await rateLimit({
        routeName: `sales:${action}`,
        subjectKey: `v1:${hashRateLimitSubject('sales', action, req.salesRep.user_id)}`,
        windowMs: SALES_RATE_WINDOW_MS,
        maxCount
      })
      if (result.allowed) return true
      const retryAfter = Math.max(0, Math.ceil(Number(result.retryAfterSeconds || 0)))
      if (retryAfter > 0) res.set('Retry-After', String(retryAfter))
      res.status(429).json({
        error: 'rate_limited',
        code: 'sales_rate_limited',
        detail: 'Please wait before trying that sales action again.',
        retry_after_seconds: retryAfter,
        request_id: requestId(req)
      })
      return false
    } catch (error) {
      console.error('[sales/rate-limit] check_failed', {
        action,
        request_id: requestId(req),
        code: error?.code || null
      })
      res.status(503).json({
        error: 'rate_limit_unavailable',
        code: 'rate_limit_unavailable',
        detail: 'The sales action could not be safely started. Please try again.',
        request_id: requestId(req)
      })
      return false
    }
  }

  async function validatePromotion(code, draft) {
    const normalizedCode = String(code || '').trim().toUpperCase()
    if (!normalizedCode) return null
    const stripe = getStripe()
    const result = await stripe.promotionCodes.list({
      code: normalizedCode,
      active: true,
      limit: 10,
      expand: ['data.coupon']
    })
    const promotionCode = (result?.data || []).find((item) => {
      if (String(item?.code || '').trim().toUpperCase() !== normalizedCode) return false
      if (item?.active !== true) return false
      if (item?.coupon && item.coupon.valid === false) return false
      if (item?.expires_at && Number(item.expires_at) * 1000 <= Date.now()) return false
      if (item?.max_redemptions && Number(item.times_redeemed || 0) >= Number(item.max_redemptions)) return false
      return true
    })
    if (!promotionCode) {
      throw makeSalesError(422, 'promotion_code_invalid', 'That code is inactive, expired, or not eligible for this membership.')
    }
    const basePricing = calculatePricing(draft, null).pricing
    const eligibilityError = promotionEligibilityError(promotionCode, basePricing)
    if (eligibilityError) {
      throw makeSalesError(422, 'promotion_code_ineligible', eligibilityError)
    }
    const promotion = promotionFromStripe(normalizedCode, promotionCode)
    calculatePricing(draft, promotion)
    return promotion
  }

  async function event(intentId, actorUserId, eventType, safeMetadata = {}) {
    const payload = {
      purchase_intent_id: intentId,
      actor_user_id: actorUserId || null,
      event_type: eventType,
      safe_metadata: safeMetadata
    }
    const { error } = await db.from('sales_deal_events').insert(payload)
    if (error) console.error('[sales/events] write_failed', { intent_id: intentId, event_type: eventType, code: error.code || null })
  }

  async function removeReplacementArtifacts(agreementId, pdfPath) {
    try { await db.from('membership_agreements').delete().eq('id', agreementId).eq('status', 'draft') } catch (_) {}
    if (pdfPath) {
      try { await db.storage.from(AGREEMENTS_BUCKET).remove([pdfPath]) } catch (_) {}
    }
  }

  async function replaceExpiredAgreement(intent, agreement, rep) {
    const checkoutSessionId = String(intent.stripe_checkout_session_id || agreement.checkout_session_id || '').trim()
    if (checkoutSessionId) {
      let session = null
      try {
        session = await getStripe().checkout.sessions.retrieve(checkoutSessionId)
      } catch (error) {
        if (String(error?.code || '').toLowerCase() !== 'resource_missing') throw error
      }
      const disposition = replacementCheckoutDisposition(session)
      if (disposition === 'paid') {
        throw makeSalesError(409, 'agreement_already_paid', 'Payment has completed. This deal is being activated and cannot be replaced.')
      }
      if (disposition === 'open') await getStripe().checkout.sessions.expire(checkoutSessionId)
    }

    const schedule = agreementSchedule()
    const draft = validateSalesDraft(normalizeSalesDraft({
      company_legal_name: intent.company_legal_name,
      company_dba: intent.company_dba,
      buyer_first_name: intent.buyer_first_name,
      buyer_last_name: intent.buyer_last_name,
      buyer_email: intent.buyer_email,
      buyer_phone: intent.buyer_phone,
      buyer_title: intent.buyer_title,
      candidate_assistance_name: intent.candidate_assistance_name,
      candidate_assistance_email: intent.candidate_assistance_email,
      ghl_contact_id: intent.ghl_contact_id,
      ghl_opportunity_id: intent.ghl_opportunity_id,
      sales_note: intent.sales_note,
      plan_key: intent.selected_plan_key,
      billing_cadence: intent.selected_billing_cadence,
      first_role_prepay_selected: intent.package_snapshot?.first_role_prepay?.selected === true,
      promotion_code: intent.promotion_code
    }))
    const agreementInput = agreementInputFromDraft(draft, intent.package_snapshot, schedule)
    const { html, normalized } = renderAgreement(agreementInput, { showPackageTerms: true, generatedAt: nowIso(), timeZone: 'America/Denver' })
    const pdf = await renderPdf(html, {
      format: 'Letter',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
    })
    const agreementId = crypto.randomUUID()
    const draftPdfPath = `membership-agreements/${agreementId}/sales-assisted-draft.pdf`
    const upload = await db.storage.from(AGREEMENTS_BUCKET).upload(draftPdfPath, pdf, {
      contentType: 'application/pdf',
      upsert: false
    })
    if (upload.error) throw makeSalesError(503, 'agreement_storage_failed', 'The replacement agreement could not be stored.')

    const signerToken = crypto.randomBytes(32).toString('hex')
    const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex')
    const generatedAt = nowIso()
    const templateSnapshot = {
      template_name: 'membership-agreement',
      template_version: 'membership_agreement_v3_sales_assisted',
      source: 'sales_assisted',
      generated_at: generatedAt,
      term_start_basis: 'agreement_date',
      agreement_expires_at: schedule.expires_at,
      purchase_intent: { id: intent.id, channel: 'sales_assisted' },
      package_snapshot: intent.package_snapshot,
      pricing_snapshot: agreement.template_snapshot?.pricing_snapshot || null,
      values: normalized,
      rendered_html: html
    }
    const { error: insertError } = await db.from('membership_agreements').insert({
      id: agreementId,
      client_id: agreement.client_id || intent.client_id || null,
      status: 'draft',
      is_current: false,
      client_legal_name: normalized.client_legal_name,
      dba_trade_name: normalized.dba_trade_name || null,
      primary_admin_name: normalized.primary_admin_name,
      admin_email: normalized.admin_email,
      membership_tier: normalized.membership_tier,
      initial_term_start: normalized.initial_term_start,
      initial_renewal_date: normalized.initial_renewal_date,
      agreement_expires_at: schedule.expires_at,
      billing_option: normalized.billing_option,
      auto_renew: normalized.auto_renew,
      notice_deadline_days: normalized.notice_deadline_days,
      template_version: 'membership_agreement_v3_sales_assisted',
      template_snapshot: templateSnapshot,
      draft_pdf_path: draftPdfPath,
      signer_token_hash: signerTokenHash,
      signer_token_expires_at: schedule.expires_at,
      created_by_user_id: rep.user_id,
      created_by_email: rep.email
    })
    if (insertError) {
      await removeReplacementArtifacts(agreementId, draftPdfPath)
      throw makeSalesError(503, 'agreement_create_failed', 'The replacement agreement could not be created.')
    }

    const { data: replaced, error: replaceError } = await db.rpc('replace_sales_assisted_agreement', {
      p_intent_id: intent.id,
      p_old_agreement_id: agreement.id,
      p_new_agreement_id: agreementId,
      p_new_expires_at: schedule.expires_at,
      p_replaced_at: generatedAt
    })
    if (replaceError || replaced !== true) {
      await removeReplacementArtifacts(agreementId, draftPdfPath)
      if (!replaceError) throw makeSalesError(409, 'agreement_state_changed', 'The agreement changed while it was being replaced. Refresh the deal.')
      if (String(replaceError.message || '').includes('not_replaceable')) {
        throw makeSalesError(409, 'agreement_already_paid', 'Payment completed while the agreement was being replaced.')
      }
      throw makeSalesError(503, 'agreement_replace_failed', 'The replacement agreement could not be finalized.')
    }

    const mailResult = await sendAgreementEmail(intent.buyer_email, buildSignUrl(signerToken), {
      client_legal_name: intent.company_legal_name,
      primary_admin_name: `${intent.buyer_first_name || ''} ${intent.buyer_last_name || ''}`.trim(),
      membership_tier: intent.package_snapshot?.display_name || intent.selected_plan_key,
      expires_on: schedule.expires_at
    })
    if (mailResult?.skipped) throw makeSalesError(503, 'agreement_email_not_configured', 'The replacement agreement was saved, but email delivery is not configured.')
    await event(intent.id, rep.user_id, 'agreement_replaced', { prior_agreement_id: agreement.id, agreement_id: agreementId })
    return { message: 'A newly dated agreement was sent for signature.', agreement_id: agreementId }
  }

  async function loadAgreements(intents) {
    const ids = Array.from(new Set((intents || []).map((item) => item.agreement_id).filter(Boolean)))
    if (!ids.length) return new Map()
    const { data, error } = await db.from('membership_agreements').select(AGREEMENT_COLUMNS).in('id', ids)
    if (error) throw makeSalesError(503, 'agreement_lookup_failed', 'Agreement status could not be loaded.')
    return new Map((data || []).map((row) => [row.id, row]))
  }

  async function loadOwnedDeal(dealId, repUserId) {
    const { data: intent, error } = await db
      .from('public_purchase_intents')
      .select(INTENT_COLUMNS)
      .eq('id', dealId)
      .eq('channel', 'sales_assisted')
      .eq('created_by_user_id', repUserId)
      .maybeSingle()
    if (error) throw makeSalesError(503, 'deal_lookup_failed', 'The deal could not be loaded.')
    if (!intent) throw makeSalesError(404, 'deal_not_found', 'Deal not found.')
    const agreements = await loadAgreements([intent])
    return { intent, agreement: agreements.get(intent.agreement_id) || null }
  }

  async function idempotentResult(repUserId, routeKey, key, body) {
    const requestFingerprint = fingerprint(body)
    const { data, error } = await db
      .from('sales_idempotency_keys')
      .select('request_fingerprint,response_status,response_body,expires_at')
      .eq('actor_user_id', repUserId)
      .eq('route_key', routeKey)
      .eq('idempotency_key', key)
      .maybeSingle()
    if (error) throw makeSalesError(503, 'idempotency_lookup_failed', 'The request could not be safely checked for duplicates.')
    if (!data) return { requestFingerprint, replay: null }
    if (data.request_fingerprint !== requestFingerprint) {
      throw makeSalesError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used for different request data.')
    }
    if (data.response_status && data.response_body) {
      return { requestFingerprint, replay: { status: data.response_status, body: data.response_body } }
    }
    throw makeSalesError(409, 'request_in_progress', 'This request is already being processed.')
  }

  async function reserveIdempotency(repUserId, routeKey, key, requestFingerprint) {
    const { error } = await db.from('sales_idempotency_keys').insert({
      actor_user_id: repUserId,
      route_key: routeKey,
      idempotency_key: key,
      request_fingerprint: requestFingerprint
    })
    if (error) {
      if (error.code === '23505') throw makeSalesError(409, 'request_in_progress', 'This request is already being processed.')
      throw makeSalesError(503, 'idempotency_reservation_failed', 'The request could not be safely started.')
    }
  }

  async function finishIdempotency(repUserId, routeKey, key, status, body) {
    const { error } = await db
      .from('sales_idempotency_keys')
      .update({ response_status: status, response_body: body })
      .eq('actor_user_id', repUserId)
      .eq('route_key', routeKey)
      .eq('idempotency_key', key)
    if (error) console.error('[sales/idempotency] response_persist_failed', { route_key: routeKey, code: error.code || null })
  }

  async function releaseIdempotency(repUserId, routeKey, key) {
    try {
      const { error } = await db
        .from('sales_idempotency_keys')
        .delete()
        .eq('actor_user_id', repUserId)
        .eq('route_key', routeKey)
        .eq('idempotency_key', key)
      if (error) console.error('[sales/idempotency] release_failed', { route_key: routeKey, code: error.code || null })
    } catch (error) {
      console.error('[sales/idempotency] release_failed', { route_key: routeKey, code: error?.code || null })
    }
  }

  router.get('/me', (req, res) => res.json(req.salesRep))

  router.get('/packages', (_req, res) => {
    return res.json({ items: listSalesPackages({ env: process.env }) })
  })

  router.post('/promotion-codes/validate', async (req, res) => {
    try {
      normalizeIdempotencyKey(req)
      const draft = normalizeSalesDraft({ ...req.body, promotion_code: req.body?.code })
      if (!draft.plan_key || !draft.billing_cadence) {
        throw makeSalesError(400, 'invalid_package', 'Select an available membership and billing cadence.')
      }
      const promotion = await validatePromotion(req.body?.code, draft)
      return res.json(promotion)
    } catch (error) {
      return respondError(res, req, error)
    }
  })

  router.post('/deals/preview', async (req, res) => {
    try {
      normalizeIdempotencyKey(req)
      const draft = validateSalesDraft(normalizeSalesDraft(req.body))
      const promotion = draft.promotion_code ? await validatePromotion(draft.promotion_code, draft) : null
      const { package_snapshot: packageSnapshot, pricing } = calculatePricing(draft, promotion)
      const schedule = agreementSchedule()
      const agreementInput = agreementInputFromDraft(draft, packageSnapshot, schedule)
      const { html } = renderAgreement(agreementInput, { showPackageTerms: true, generatedAt: nowIso(), timeZone: 'America/Denver' })
      const pdf = await renderPdf(html, {
        format: 'Letter',
        margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
      })
      const previewId = crypto.randomUUID()
      const previewPath = `sales-previews/${req.salesRep.user_id}/${previewId}.pdf`
      const upload = await db.storage.from(AGREEMENTS_BUCKET).upload(previewPath, pdf, {
        contentType: 'application/pdf',
        upsert: false
      })
      if (upload.error) throw makeSalesError(503, 'preview_storage_failed', 'The agreement preview could not be stored.')
      const expiresAt = new Date(Math.min(Date.now() + PREVIEW_TTL_MS, Date.parse(schedule.expires_at))).toISOString()
      const draftFingerprint = fingerprint(draft)
      const { error: insertError } = await db.from('sales_deal_previews').insert({
        id: previewId,
        created_by_user_id: req.salesRep.user_id,
        normalized_draft: draft,
        package_snapshot: packageSnapshot,
        pricing_snapshot: pricing,
        draft_fingerprint: draftFingerprint,
        preview_pdf_path: previewPath,
        expires_at: expiresAt,
        agreement_effective_date: schedule.effective_date,
        agreement_renewal_date: schedule.renewal_date,
        agreement_expires_at: schedule.expires_at
      })
      if (insertError) throw makeSalesError(503, 'preview_persist_failed', 'The agreement preview could not be recorded.')
      const signedUrlTtlSeconds = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000))
      const signed = await db.storage.from(AGREEMENTS_BUCKET).createSignedUrl(previewPath, signedUrlTtlSeconds)
      if (signed.error || !signed.data?.signedUrl) throw makeSalesError(503, 'preview_url_failed', 'The agreement preview link could not be created.')
      return res.status(201).json({
        preview_id: previewId,
        preview_url: signed.data.signedUrl,
        expires_at: expiresAt,
        agreement_effective_date: schedule.effective_date,
        agreement_renewal_date: schedule.renewal_date,
        agreement_expires_at: schedule.expires_at,
        normalized_draft: draft,
        pricing
      })
    } catch (error) {
      return respondError(res, req, error)
    }
  })

  router.post('/deals', async (req, res) => {
    const routeKey = 'POST:/sales/deals'
    let key = ''
    let reserved = false
    let createdIntentId = ''
    let createdAgreementId = ''
    let createdAgreementPdfPath = ''
    let dealReadyForRecovery = false
    try {
      key = normalizeIdempotencyKey(req)
      const draft = validateSalesDraft(normalizeSalesDraft(req.body))
      const previewId = String(req.body?.preview_id || '').trim()
      if (!previewId) throw makeSalesError(409, 'preview_required', 'Preview the agreement before sending it.')
      const idem = await idempotentResult(req.salesRep.user_id, routeKey, key, { ...draft, preview_id: previewId })
      if (idem.replay) return res.status(idem.replay.status).json(idem.replay.body)
      if (!await enforceSalesRateLimit(req, res, 'create')) return
      await reserveIdempotency(req.salesRep.user_id, routeKey, key, idem.requestFingerprint)
      reserved = true

      const { data: preview, error: previewError } = await db
        .from('sales_deal_previews')
        .select('id,normalized_draft,package_snapshot,pricing_snapshot,draft_fingerprint,expires_at,consumed_at,agreement_effective_date,agreement_renewal_date,agreement_expires_at')
        .eq('id', previewId)
        .eq('created_by_user_id', req.salesRep.user_id)
        .maybeSingle()
      if (previewError) throw makeSalesError(503, 'preview_lookup_failed', 'The agreement preview could not be loaded.')
      if (!preview) throw makeSalesError(404, 'preview_not_found', 'The agreement preview was not found.')
      if (preview.consumed_at) throw makeSalesError(409, 'preview_already_used', 'This agreement preview was already used.')
      if (new Date(preview.expires_at).getTime() <= Date.now()) throw makeSalesError(409, 'preview_expired', 'The agreement preview expired. Generate a new preview.')
      const currentSchedule = agreementSchedule()
      if (
        !preview.agreement_effective_date ||
        !preview.agreement_renewal_date ||
        !preview.agreement_expires_at ||
        preview.agreement_effective_date !== currentSchedule.effective_date ||
        Date.parse(preview.agreement_expires_at) <= Date.now()
      ) {
        throw makeSalesError(409, 'preview_expired', 'The agreement date changed. Generate a new preview.')
      }
      if (preview.draft_fingerprint !== fingerprint(draft) || fingerprint(preview.normalized_draft) !== fingerprint(draft)) {
        throw makeSalesError(409, 'preview_mismatch', 'The agreement terms changed. Generate a new preview.')
      }
      const currentPromotion = draft.promotion_code ? await validatePromotion(draft.promotion_code, draft) : null
      const currentTerms = calculatePricing(draft, currentPromotion)
      if (
        fingerprint(currentTerms.package_snapshot) !== fingerprint(preview.package_snapshot) ||
        fingerprint(currentTerms.pricing) !== fingerprint(preview.pricing_snapshot)
      ) {
        throw makeSalesError(409, 'preview_terms_changed', 'Pricing or promotion eligibility changed. Generate a new preview.')
      }

      const { data: existingClient, error: clientError } = await db
        .from('clients')
        .select('id')
        .ilike('email', draft.buyer_email)
        .limit(1)
        .maybeSingle()
      if (clientError && clientError.code !== 'PGRST116') throw makeSalesError(503, 'buyer_conflict_check_failed', 'The buyer email could not be checked.')
      if (existingClient) throw makeSalesError(409, 'buyer_email_already_registered', 'This buyer email is already associated with an alphaScreen account.')

      const { data: existingIntent, error: intentConflictError } = await db
        .from('public_purchase_intents')
        .select('id,status')
        .ilike('buyer_email', draft.buyer_email)
        .neq('status', 'canceled')
        .neq('status', 'expired')
        .limit(1)
        .maybeSingle()
      if (intentConflictError && intentConflictError.code !== 'PGRST116') {
        throw makeSalesError(503, 'buyer_conflict_check_failed', 'Existing signup activity could not be checked.')
      }
      if (existingIntent) {
        throw makeSalesError(409, 'existing_signup_conflict', 'This buyer already has an account or an in-progress purchase. Ask an administrator to review it.')
      }

      const intentId = crypto.randomUUID()
      const agreementId = crypto.randomUUID()
      const now = nowIso()
      const intentPayload = {
        id: intentId,
        status: 'pending',
        selected_plan_key: draft.plan_key,
        selected_billing_cadence: draft.billing_cadence,
        package_snapshot: preview.package_snapshot,
        company_legal_name: draft.company_legal_name,
        company_dba: draft.company_dba || null,
        buyer_first_name: draft.buyer_first_name,
        buyer_last_name: draft.buyer_last_name,
        buyer_email: draft.buyer_email,
        buyer_phone: draft.buyer_phone || null,
        buyer_title: draft.buyer_title || null,
        source_path: '/sales',
        agreement_id: agreementId,
        expires_at: preview.agreement_expires_at,
        channel: 'sales_assisted',
        created_by_user_id: req.salesRep.user_id,
        created_by_email: req.salesRep.email,
        ghl_contact_id: draft.ghl_contact_id || null,
        ghl_opportunity_id: draft.ghl_opportunity_id || null,
        sales_note: draft.sales_note || null,
        candidate_assistance_name: draft.candidate_assistance_name || null,
        candidate_assistance_email: draft.candidate_assistance_email || null,
        promotion_code_id: preview.pricing_snapshot?.promotion?.promotion_code_id || null,
        promotion_code: preview.pricing_snapshot?.promotion?.code || null,
        promotion_label: preview.pricing_snapshot?.promotion?.label || null,
        promotion_amount_off_cents: preview.pricing_snapshot?.promotion?.amount_off_cents || null,
        promotion_percent_off: preview.pricing_snapshot?.promotion?.percent_off || null,
        promotion_discount_cents: Number(preview.pricing_snapshot?.promotion_discount_cents || 0),
        platform_fee_cents: Number(preview.pricing_snapshot?.platform_fee_cents || 0),
        initial_payment_cents: Number(preview.pricing_snapshot?.initial_payment_cents || 0),
        term_start_basis: 'agreement_date',
        sales_preview_id: previewId,
        created_at: now,
        updated_at: now
      }
      const { data: insertedIntent, error: intentError } = await db
        .from('public_purchase_intents')
        .insert(intentPayload)
        .select(INTENT_COLUMNS)
        .single()
      if (intentError) {
        if (intentError.code === '23505') {
          throw makeSalesError(409, 'existing_signup_conflict', 'This preview or buyer is already associated with an active sales transaction.')
        }
        throw makeSalesError(503, 'deal_create_failed', 'The sales transaction could not be created.')
      }
      createdIntentId = intentId

      const agreementScheduleSnapshot = {
        effective_date: preview.agreement_effective_date,
        renewal_date: preview.agreement_renewal_date,
        expires_at: preview.agreement_expires_at
      }
      const agreementInput = agreementInputFromDraft(draft, preview.package_snapshot, agreementScheduleSnapshot)
      const { html, normalized } = renderAgreement(agreementInput, { showPackageTerms: true, generatedAt: now, timeZone: 'America/Denver' })
      const pdf = await renderPdf(html, {
        format: 'Letter',
        margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
      })
      const draftPdfPath = `membership-agreements/${agreementId}/sales-assisted-draft.pdf`
      createdAgreementPdfPath = draftPdfPath
      const upload = await db.storage.from(AGREEMENTS_BUCKET).upload(draftPdfPath, pdf, {
        contentType: 'application/pdf',
        upsert: false
      })
      if (upload.error) throw makeSalesError(503, 'agreement_storage_failed', 'The agreement could not be stored.')

      const signerToken = crypto.randomBytes(32).toString('hex')
      const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex')
      const signerTokenExpiresAt = preview.agreement_expires_at
      const signingUrl = buildSignUrl(signerToken)
      const templateSnapshot = {
        template_name: 'membership-agreement',
        template_version: 'membership_agreement_v3_sales_assisted',
        source: 'sales_assisted',
        generated_at: now,
        term_start_basis: 'agreement_date',
        agreement_expires_at: signerTokenExpiresAt,
        purchase_intent: { id: intentId, channel: 'sales_assisted' },
        package_snapshot: preview.package_snapshot,
        pricing_snapshot: preview.pricing_snapshot,
        values: normalized,
        rendered_html: html
      }
      const { error: agreementError } = await db.from('membership_agreements').insert({
        id: agreementId,
        client_id: null,
        status: 'draft',
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
        template_version: 'membership_agreement_v3_sales_assisted',
        template_snapshot: templateSnapshot,
        draft_pdf_path: draftPdfPath,
        signer_token_hash: signerTokenHash,
        signer_token_expires_at: signerTokenExpiresAt,
        agreement_expires_at: signerTokenExpiresAt,
        created_by_user_id: req.salesRep.user_id,
        created_by_email: req.salesRep.email
      })
      if (agreementError) throw makeSalesError(503, 'agreement_create_failed', 'The agreement could not be created.')
      createdAgreementId = agreementId

      const { data: updatedIntent, error: finalizeError } = await db
        .from('public_purchase_intents')
        .update({ status: 'agreement_pending', updated_at: nowIso() })
        .eq('id', intentId)
        .eq('created_by_user_id', req.salesRep.user_id)
        .select(INTENT_COLUMNS)
        .single()
      if (finalizeError) throw makeSalesError(503, 'deal_finalize_failed', 'The agreement was sent but the deal status could not be finalized.')
      const sentAt = nowIso()
      const { data: finalizedAgreement, error: agreementFinalizeError } = await db
        .from('membership_agreements')
        .update({ status: 'sent', sent_at: sentAt })
        .eq('id', agreementId)
        .eq('status', 'draft')
        .select('id')
        .maybeSingle()
      if (agreementFinalizeError) throw makeSalesError(503, 'agreement_finalize_failed', 'The agreement was created but could not be made available for signing.')
      if (!finalizedAgreement) throw makeSalesError(409, 'agreement_state_changed', 'The agreement state changed before delivery. Review the deal before retrying.')
      const { error: previewConsumeError } = await db
        .from('sales_deal_previews')
        .update({ consumed_at: sentAt })
        .eq('id', previewId)
        .eq('created_by_user_id', req.salesRep.user_id)
        .is('consumed_at', null)
      if (previewConsumeError) {
        console.error('[sales/preview] consume_marker_failed', { preview_id: previewId, code: previewConsumeError.code || null })
      }
      dealReadyForRecovery = true

      let mailResult
      try {
        mailResult = await sendAgreementEmail(draft.buyer_email, signingUrl, {
          client_legal_name: draft.company_legal_name,
          primary_admin_name: `${draft.buyer_first_name} ${draft.buyer_last_name}`.trim(),
          membership_tier: preview.package_snapshot?.display_name || draft.plan_key,
          expires_on: signerTokenExpiresAt
        })
      } catch (mailError) {
        await event(intentId, req.salesRep.user_id, 'agreement_email_failed')
        throw makeSalesError(503, 'agreement_email_failed', 'The deal was saved, but the agreement email was not delivered. Open the deal and resend it.', { deal_id: intentId })
      }
      if (mailResult?.skipped) {
        await event(intentId, req.salesRep.user_id, 'agreement_email_failed')
        throw makeSalesError(503, 'agreement_email_not_configured', 'The deal was saved, but agreement email delivery is not configured. Open the deal and resend it.', { deal_id: intentId })
      }
      await event(intentId, req.salesRep.user_id, 'agreement_sent', { agreement_id: agreementId })

      const body = {
        deal: safeDeal(updatedIntent || insertedIntent, { id: agreementId, status: 'sent', sent_at: sentAt }),
        message: `Agreement sent to ${draft.buyer_email}.`
      }
      await finishIdempotency(req.salesRep.user_id, routeKey, key, 201, body)
      return res.status(201).json(body)
    } catch (error) {
      if (reserved && key) {
        const body = errorBody(error, req)
        if (!dealReadyForRecovery && (createdIntentId || Number(error?.status || 500) >= 500)) {
          const cleanup = async (step, operation) => {
            try { await operation() } catch (cleanupError) {
              console.error('[sales/deals] incomplete_deal_cleanup_failed', {
                step,
                purchase_intent_id: createdIntentId || null,
                agreement_id: createdAgreementId || null,
                code: cleanupError?.code || null
              })
            }
          }
          if (createdIntentId) {
            await cleanup('purchase_intent', () => db.from('public_purchase_intents').delete().eq('id', createdIntentId).eq('created_by_user_id', req.salesRep.user_id))
          }
          if (createdAgreementId) {
            await cleanup('agreement', () => db.from('membership_agreements').delete().eq('id', createdAgreementId))
          }
          if (createdAgreementPdfPath) {
            await cleanup('agreement_pdf', () => db.storage.from(AGREEMENTS_BUCKET).remove([createdAgreementPdfPath]))
          }
          await releaseIdempotency(req.salesRep.user_id, routeKey, key)
        } else {
          await finishIdempotency(req.salesRep.user_id, routeKey, key, Number(error?.status) || 500, body)
        }
      }
      return respondError(res, req, error)
    }
  })

  router.get('/deals', async (req, res) => {
    try {
      const { data, error } = await db
        .from('public_purchase_intents')
        .select(INTENT_COLUMNS)
        .eq('channel', 'sales_assisted')
        .eq('created_by_user_id', req.salesRep.user_id)
        .order('created_at', { ascending: false })
        .limit(250)
      if (error) throw makeSalesError(503, 'deal_list_failed', 'Deals could not be loaded.')
      const agreements = await loadAgreements(data || [])
      return res.json({ items: (data || []).map((intent) => safeDeal(intent, agreements.get(intent.agreement_id) || null)) })
    } catch (error) {
      return respondError(res, req, error)
    }
  })

  router.get('/deals/:id', async (req, res) => {
    try {
      const { intent, agreement } = await loadOwnedDeal(req.params.id, req.salesRep.user_id)
      const { data: events, error } = await db
        .from('sales_deal_events')
        .select('id,event_type,safe_metadata,created_at')
        .eq('purchase_intent_id', intent.id)
        .order('created_at', { ascending: true })
      if (error) throw makeSalesError(503, 'deal_timeline_failed', 'The deal timeline could not be loaded.')
      return res.json({
        ...safeDeal(intent, agreement),
        buyer_phone: intent.buyer_phone || '',
        buyer_title: intent.buyer_title || '',
        candidate_assistance_name: intent.candidate_assistance_name || '',
        candidate_assistance_email: intent.candidate_assistance_email || '',
        ghl_contact_id: intent.ghl_contact_id || null,
        sales_note: intent.sales_note || '',
        timeline: events || []
      })
    } catch (error) {
      return respondError(res, req, error)
    }
  })

  router.post('/deals/:id/resend-agreement', async (req, res) => {
    const routeKey = 'POST:/sales/deals/:id/resend-agreement'
    let key = ''
    let reserved = false
    try {
      key = normalizeIdempotencyKey(req)
      const idem = await idempotentResult(req.salesRep.user_id, routeKey, key, { deal_id: req.params.id })
      if (idem.replay) return res.status(idem.replay.status).json(idem.replay.body)
      if (!await enforceSalesRateLimit(req, res, 'resend_agreement')) return
      await reserveIdempotency(req.salesRep.user_id, routeKey, key, idem.requestFingerprint)
      reserved = true
      const { intent, agreement } = await loadOwnedDeal(req.params.id, req.salesRep.user_id)
      if (!agreement || !['sent', 'signed'].includes(agreement.status) || agreement.checkout_status === 'paid') {
        throw makeSalesError(409, 'agreement_not_resendable', 'This agreement cannot be resent.')
      }
      const explicitDeadline = Date.parse(String(agreement.agreement_expires_at || ''))
      if (Number.isFinite(explicitDeadline) && explicitDeadline <= Date.now()) {
        const body = await replaceExpiredAgreement(intent, agreement, req.salesRep)
        await finishIdempotency(req.salesRep.user_id, routeKey, key, 200, body)
        return res.json(body)
      }
      if (agreement.status !== 'sent') {
        throw makeSalesError(409, 'agreement_not_resendable', 'This agreement is signed. Send a payment reminder before it expires.')
      }
      const signerToken = crypto.randomBytes(32).toString('hex')
      const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex')
      const expiresAt = Number.isFinite(explicitDeadline)
        ? agreement.agreement_expires_at
        : new Date(Date.now() + LEGACY_SIGNING_LINK_TTL_MS).toISOString()
      const { error } = await db.from('membership_agreements').update({
        signer_token_hash: signerTokenHash,
        signer_token_expires_at: expiresAt,
        sent_at: nowIso(),
        updated_at: nowIso()
      }).eq('id', agreement.id).eq('status', 'sent')
      if (error) throw makeSalesError(503, 'agreement_refresh_failed', 'The agreement link could not be refreshed.')
      const mailResult = await sendAgreementEmail(intent.buyer_email, buildSignUrl(signerToken), {
        client_legal_name: intent.company_legal_name,
        primary_admin_name: `${intent.buyer_first_name} ${intent.buyer_last_name}`.trim(),
        membership_tier: intent.package_snapshot?.display_name || intent.selected_plan_key,
        expires_on: expiresAt
      })
      if (mailResult?.skipped) throw makeSalesError(503, 'agreement_email_not_configured', 'Agreement email delivery is not configured.')
      await event(intent.id, req.salesRep.user_id, 'agreement_resent')
      const body = { message: 'The agreement email was sent again.' }
      await finishIdempotency(req.salesRep.user_id, routeKey, key, 200, body)
      return res.json(body)
    } catch (error) {
      if (reserved && key) await finishIdempotency(req.salesRep.user_id, routeKey, key, Number(error?.status) || 500, errorBody(error, req))
      return respondError(res, req, error)
    }
  })

  router.post('/deals/:id/send-payment-reminder', async (req, res) => {
    const routeKey = 'POST:/sales/deals/:id/send-payment-reminder'
    let key = ''
    let reserved = false
    try {
      key = normalizeIdempotencyKey(req)
      const idem = await idempotentResult(req.salesRep.user_id, routeKey, key, { deal_id: req.params.id })
      if (idem.replay) return res.status(idem.replay.status).json(idem.replay.body)
      if (!await enforceSalesRateLimit(req, res, 'send_payment_reminder')) return
      await reserveIdempotency(req.salesRep.user_id, routeKey, key, idem.requestFingerprint)
      reserved = true
      const { intent, agreement } = await loadOwnedDeal(req.params.id, req.salesRep.user_id)
      if (!agreement || !['signed'].includes(agreement.status) || agreement.checkout_status === 'paid') {
        throw makeSalesError(409, 'payment_reminder_not_available', 'A payment reminder is not available for this deal.')
      }
      const explicitDeadline = Date.parse(String(agreement.agreement_expires_at || ''))
      if (Number.isFinite(explicitDeadline) && explicitDeadline <= Date.now()) {
        throw makeSalesError(410, 'agreement_expired', 'This agreement expired. Resend a newly dated agreement for signature.')
      }
      const signerToken = crypto.randomBytes(32).toString('hex')
      const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex')
      const expiresAt = Number.isFinite(explicitDeadline)
        ? agreement.agreement_expires_at
        : new Date(Date.now() + LEGACY_SIGNING_LINK_TTL_MS).toISOString()
      const { error } = await db.from('membership_agreements').update({
        signer_token_hash: signerTokenHash,
        signer_token_expires_at: expiresAt,
        updated_at: nowIso()
      }).eq('id', agreement.id).eq('status', 'signed')
      if (error) throw makeSalesError(503, 'payment_link_refresh_failed', 'The payment continuation link could not be refreshed.')
      const mailResult = await sendCheckoutEmail(
        intent.buyer_email,
        buildSignUrl(signerToken),
        `${intent.buyer_first_name || ''} ${intent.buyer_last_name || ''}`.trim()
      )
      if (mailResult?.skipped) throw makeSalesError(503, 'payment_email_not_configured', 'Payment reminder email delivery is not configured.')
      await event(intent.id, req.salesRep.user_id, 'payment_reminder_sent')
      const body = { message: 'The payment reminder was sent.' }
      await finishIdempotency(req.salesRep.user_id, routeKey, key, 200, body)
      return res.json(body)
    } catch (error) {
      if (reserved && key) await finishIdempotency(req.salesRep.user_id, routeKey, key, Number(error?.status) || 500, errorBody(error, req))
      return respondError(res, req, error)
    }
  })

  router.post('/deals/:id/cancel', async (req, res) => {
    const routeKey = 'POST:/sales/deals/:id/cancel'
    let key = ''
    let reserved = false
    try {
      key = normalizeIdempotencyKey(req)
      const idem = await idempotentResult(req.salesRep.user_id, routeKey, key, { deal_id: req.params.id })
      if (idem.replay) return res.status(idem.replay.status).json(idem.replay.body)
      await reserveIdempotency(req.salesRep.user_id, routeKey, key, idem.requestFingerprint)
      reserved = true
      const { intent, agreement } = await loadOwnedDeal(req.params.id, req.salesRep.user_id)
      if (intent.status === 'completed' || intent.activated_at || agreement?.checkout_status === 'paid') {
        throw makeSalesError(409, 'agreement_already_paid', 'Paid agreements require administrator handling.')
      }
      if (intent.stripe_checkout_session_id) {
        try { await getStripe().checkout.sessions.expire(intent.stripe_checkout_session_id) } catch (error) {
          const code = String(error?.code || '').toLowerCase()
          if (code !== 'resource_missing') throw error
        }
      }
      const now = nowIso()
      const { data: updated, error } = await db
        .from('public_purchase_intents')
        .update({ status: 'canceled', canceled_at: now, updated_at: now })
        .eq('id', intent.id)
        .eq('created_by_user_id', req.salesRep.user_id)
        .neq('status', 'completed')
        .is('activated_at', null)
        .is('activation_claimed_at', null)
        .select(INTENT_COLUMNS)
        .maybeSingle()
      if (error) throw makeSalesError(503, 'deal_cancel_failed', 'The unpaid transaction could not be canceled.')
      if (!updated) throw makeSalesError(409, 'agreement_already_paid', 'Payment completed while cancellation was being processed. An administrator must review this deal.')
      if (agreement?.id) {
        const { data: voidedAgreement, error: voidError } = await db
          .from('membership_agreements')
          .update({ status: 'voided', is_current: false, updated_at: now })
          .eq('id', agreement.id)
          .neq('checkout_status', 'paid')
          .select('id')
          .maybeSingle()
        if (voidError) throw makeSalesError(503, 'agreement_void_failed', 'The transaction was canceled, but the agreement could not be voided.')
        if (!voidedAgreement) throw makeSalesError(409, 'agreement_already_paid', 'Payment completed while cancellation was being processed. An administrator must review this deal.')
      }
      await event(intent.id, req.salesRep.user_id, 'deal_canceled')
      const body = { deal: safeDeal(updated, { ...(agreement || {}), status: 'voided' }), message: 'The unpaid transaction was canceled.' }
      await finishIdempotency(req.salesRep.user_id, routeKey, key, 200, body)
      return res.json(body)
    } catch (error) {
      if (reserved && key) await finishIdempotency(req.salesRep.user_id, routeKey, key, Number(error?.status) || 500, errorBody(error, req))
      return respondError(res, req, error)
    }
  })

  router.post('/enterprise-handoffs', async (req, res) => {
    const routeKey = 'POST:/sales/enterprise-handoffs'
    let key = ''
    let reserved = false
    try {
      key = normalizeIdempotencyKey(req)
      const input = {
        company_name: String(req.body?.company_name || '').trim().slice(0, 160),
        contact_name: String(req.body?.contact_name || '').trim().slice(0, 160),
        contact_email: String(req.body?.contact_email || '').trim().toLowerCase().slice(0, 254),
        contact_phone: String(req.body?.contact_phone || '').trim().slice(0, 40),
        estimated_monthly_interviews: String(req.body?.estimated_monthly_interviews || '').trim().slice(0, 120),
        locations: String(req.body?.locations || '').trim().slice(0, 300),
        desired_timeline: String(req.body?.desired_timeline || '').trim().slice(0, 300),
        requirements: String(req.body?.requirements || '').trim().slice(0, 2000),
        notes: String(req.body?.notes || '').trim().slice(0, 2000),
        ghl_contact_id: String(req.body?.ghl_contact_id || '').trim().slice(0, 160),
        ghl_opportunity_id: String(req.body?.ghl_opportunity_id || '').trim().slice(0, 160)
      }
      if (!input.company_name || !input.contact_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.contact_email)) {
        throw makeSalesError(400, 'invalid_enterprise_handoff', 'Company name, contact name, and a valid contact email are required.')
      }
      const idem = await idempotentResult(req.salesRep.user_id, routeKey, key, input)
      if (idem.replay) return res.status(idem.replay.status).json(idem.replay.body)
      await reserveIdempotency(req.salesRep.user_id, routeKey, key, idem.requestFingerprint)
      reserved = true
      const { data, error } = await db.from('sales_enterprise_handoffs').insert({
        ...input,
        created_by_user_id: req.salesRep.user_id,
        created_by_email: req.salesRep.email,
        delivery_status: 'pending'
      }).select('id').single()
      if (error) throw makeSalesError(503, 'enterprise_handoff_failed', 'The Enterprise handoff could not be recorded.')
      const body = {
        handoff_id: data.id,
        message: `${input.company_name} was recorded for executive follow-up.`
      }
      await finishIdempotency(req.salesRep.user_id, routeKey, key, 201, body)
      return res.status(201).json(body)
    } catch (error) {
      if (reserved && key) await finishIdempotency(req.salesRep.user_id, routeKey, key, Number(error?.status) || 500, errorBody(error, req))
      return respondError(res, req, error)
    }
  })

  return router
}

module.exports = {
  createSalesRouter,
  replacementCheckoutDisposition,
  promotionFromStripe,
  promotionEligibilityError
}
