'use strict'

const express = require('express')
const crypto = require('crypto')
const { supabaseAdmin } = require('../../lib/supabaseClient')
const {
  buildAlphaScreenPackageSnapshot,
  isAlphaScreenBillingCadenceSupported,
  listPublicAlphaScreenPackages,
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval
} = require('../../lib/alphaScreenPackages')
const { buildMembershipAgreementSignUrl } = require('../../../config/urlConfig')
const { htmlToPdf } = require('../../../utils/pdfRenderer')
const { buildMembershipAgreementHtml } = require('../../../utils/renderMembershipAgreement')
const { resolvePublicCheckoutReturnState } = require('../../lib/publicPurchaseActivation')
const { getRequestSubjectKey, hashRateLimitSubject, checkAndIncrementRateLimit } = require('../../lib/rateLimit')
const { sendRetailSignupEmailVerificationCode } = require('../../../utils/mailer')
const {
  RETAIL_SMS_CONSENT_COPY_VERSION,
  RetailSmsVerificationError,
  consumeRetailSignupSmsOtp,
  deliverRetailSignupSmsOtp,
  invalidateRetailSmsVerification,
  loadRetailSmsVerificationState,
  normalizeRetailPhone,
  readRetailSmsConfiguration
} = require('../../lib/retailSmsVerification')

const AGREEMENTS_BUCKET = process.env.SUPABASE_AGREEMENTS_BUCKET || 'agreements'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RETAIL_RATE_WINDOW_MS = 10 * 60 * 1000
const RETAIL_PURCHASE_INTENT_RATE_MAX = Number(process.env.ALPHASCREEN_PURCHASE_INTENT_RATE_MAX || 12)
const RETAIL_PURCHASE_INTENT_IP_RATE_MAX = Number(process.env.ALPHASCREEN_PURCHASE_INTENT_IP_RATE_MAX || 60)
const RETAIL_CHECKOUT_STATUS_RATE_MAX = Number(process.env.ALPHASCREEN_CHECKOUT_STATUS_RATE_MAX || 60)
const RETAIL_AGREEMENT_RATE_MAX = Number(process.env.ALPHASCREEN_AGREEMENT_RATE_MAX || 10)
const RETAIL_PUBLIC_IP_SAFETY_RATE_MAX = Number(process.env.ALPHASCREEN_PUBLIC_IP_SAFETY_RATE_MAX || 60)
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000
const INTENT_EXPIRATION_MS = 14 * 24 * 60 * 60 * 1000
const SIGNING_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RETAIL_EMAIL_VERIFICATION_TTL_SECONDS = 10 * 60
const RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60
const RETAIL_EMAIL_VERIFICATION_SEND_RATE_MAX = 10
const RETAIL_EMAIL_VERIFICATION_VERIFY_RATE_MAX = 20
const RETAIL_EMAIL_VERIFICATION_STATUS_RATE_MAX = 120
const RETAIL_EMAIL_VERIFICATION_METHOD = 'retail_signup_email_otp_v1'
const RETAIL_SMS_VERIFICATION_TTL_SECONDS = 10 * 60
const RETAIL_SMS_VERIFICATION_RESEND_COOLDOWN_SECONDS = 120
const RETAIL_SMS_VERIFICATION_SEND_RATE_MAX = 10
const RETAIL_SMS_VERIFICATION_VERIFY_RATE_MAX = 20
const RETAIL_SMS_VERIFICATION_STATUS_RATE_MAX = 120
const BLOCKING_PURCHASE_INTENT_STATUSES = ['pending', 'agreement_pending', 'checkout_pending', 'completed']
const BLOCKING_AGREEMENT_STATUSES = ['sent', 'signed']
const SIGNUP_ALREADY_EXISTS_MESSAGE = 'This email is already associated with an alphaScreen account or signup. Sign in, check your email, or contact support for help.'

const RETAIL_VERIFICATION_INTENT_SELECT = [
  'id',
  'status',
  'selected_plan_key',
  'selected_billing_cadence',
  'buyer_email',
  'buyer_phone',
  'email_verified_at',
  'email_verified_address',
  'email_verification_method',
  'email_verification_version',
  'phone_verified_at',
  'phone_verified_destination_fingerprint',
  'phone_verification_method',
  'phone_verification_version',
  'expires_at',
  'agreement_id'
].join(',')

function retailRateLimitSubject(...parts) {
  return `v1:${hashRateLimitSubject('retail', ...parts)}`
}

function sendRateLimitResponse(res, req, { code, detail, retryAfterSeconds }) {
  const retryAfter = Math.max(0, Math.ceil(Number(retryAfterSeconds || 0)))
  if (retryAfter > 0) res.set('Retry-After', String(retryAfter))
  return res.status(429).json({
    error: 'rate_limited',
    code,
    detail,
    retry_after_seconds: retryAfter,
    request_id: req.request_id || null
  })
}

async function enforceRetailRateLimit(req, res, {
  routeName,
  subjectParts,
  maxCount,
  code = 'RETAIL_PUBLIC_RATE_LIMITED',
  detail = 'Please wait before trying again.',
  ipSafetyMax = RETAIL_PUBLIC_IP_SAFETY_RATE_MAX
}) {
  try {
    const primary = await checkAndIncrementRateLimit({
      routeName,
      subjectKey: retailRateLimitSubject(...subjectParts),
      windowMs: RETAIL_RATE_WINDOW_MS,
      maxCount
    })
    if (!primary.allowed) {
      sendRateLimitResponse(res, req, {
        code,
        detail,
        retryAfterSeconds: primary.retryAfterSeconds
      })
      return false
    }

    if (ipSafetyMax > 0) {
      const ipSafety = await checkAndIncrementRateLimit({
        routeName: `${routeName}:ip_safety`,
        subjectKey: retailRateLimitSubject('ip', getRequestSubjectKey(req)),
        windowMs: RETAIL_RATE_WINDOW_MS,
        maxCount: ipSafetyMax
      })
      if (!ipSafety.allowed) {
        sendRateLimitResponse(res, req, {
          code: 'RETAIL_PUBLIC_RATE_LIMITED',
          detail: 'Please wait before trying again.',
          retryAfterSeconds: ipSafety.retryAfterSeconds
        })
        return false
      }
    }
    return true
  } catch (error) {
    console.error('[alphascreen] rate_limit_failed:', error?.code || 'unknown')
    res.status(503).json({
      error: 'retail_signup_unavailable',
      code: 'RETAIL_SIGNUP_UNAVAILABLE',
      request_id: req.request_id || null
    })
    return false
  }
}

function trimText(value, max = 300) {
  return String(value || '').trim().slice(0, max)
}

function cleanPhone(value) {
  const raw = trimText(value, 40)
  return raw ? raw.replace(/[^\d+().\-\s]/g, '').slice(0, 40).trim() : ''
}

function cleanPath(value) {
  const raw = trimText(value, 500)
  if (!raw) return ''
  try {
    const url = new URL(raw, 'https://www.alphasourceai.com')
    return trimText(url.pathname || '/', 300)
  } catch (_) {
    return trimText(raw.split('?')[0].split('#')[0], 300)
  }
}

function cleanLookupId(value) {
  return trimText(value, 200)
}

function readOptionalBoolean(value) {
  if (value === true) return true
  return false
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'client'
}

function dateOnly(date) {
  const safe = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date()
  return safe.toISOString().slice(0, 10)
}

function addOneYearDateOnly(date) {
  const safe = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date()
  const next = new Date(Date.UTC(safe.getUTCFullYear() + 1, safe.getUTCMonth(), safe.getUTCDate()))
  return next.toISOString().slice(0, 10)
}

function packageNumber(snapshot, ...keys) {
  for (const key of keys) {
    const value = Number(snapshot?.[key])
    if (Number.isFinite(value) && value >= 0) return value
  }
  return null
}

function isValidEmail(value) {
  const email = trimText(value, 254).toLowerCase()
  return EMAIL_RE.test(email)
}

function normalizeEmail(value) {
  return trimText(value, 254).toLowerCase()
}

function generateRetailVerificationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function generateRetailVerificationSalt() {
  return crypto.randomBytes(32).toString('hex')
}

function hashRetailVerificationCode(code, salt) {
  return crypto.createHash('sha256').update(`${String(salt || '')}:${String(code || '')}`).digest('hex')
}

function hasValidRetailEmailVerification(intent) {
  const buyerEmail = normalizeEmail(intent?.buyer_email)
  return Boolean(
    buyerEmail &&
    intent?.email_verified_at &&
    normalizeEmail(intent?.email_verified_address) === buyerEmail &&
    String(intent?.email_verification_method || '').trim() === RETAIL_EMAIL_VERIFICATION_METHOD
  )
}

function secondsUntil(value) {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp)) return 0
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

function resendCooldownForVerification(verification) {
  const sentAt = Date.parse(String(verification?.sent_at || ''))
  if (!Number.isFinite(sentAt)) return 0
  return Math.max(0, RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS - Math.floor((Date.now() - sentAt) / 1000))
}

function publicEmailVerificationState(intent, verification = null, resendCooldownSeconds = null) {
  const verified = hasValidRetailEmailVerification(intent)
  const codeActive = Boolean(
    !verified &&
    verification &&
    !verification.used_at &&
    !verification.invalidated_at &&
    secondsUntil(verification.expires_at) > 0
  )
  const calculatedResendCooldownSeconds = resendCooldownSeconds !== null &&
    resendCooldownSeconds !== undefined &&
    Number.isFinite(Number(resendCooldownSeconds))
    ? Math.max(0, Number(resendCooldownSeconds))
    : resendCooldownForVerification(verification)
  return {
    verified,
    status: verified ? 'verified' : codeActive ? 'code_sent' : 'unverified',
    code_active: codeActive,
    expires_in_seconds: codeActive ? secondsUntil(verification.expires_at) : 0,
    resend_cooldown_seconds: calculatedResendCooldownSeconds
  }
}

async function loadLatestRetailEmailVerification(intentId, buyerEmail) {
  const { data, error } = await supabaseAdmin
    .from('retail_signup_email_verifications')
    .select('id,sent_at,expires_at,used_at,invalidated_at,invalidation_reason,code_salt')
    .eq('purchase_intent_id', intentId)
    .eq('buyer_email', buyerEmail)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return { verification: data || null, error }
}

async function loadRetailEmailVerificationStatus(intentId, buyerEmail) {
  const { data, error } = await supabaseAdmin
    .from('retail_signup_email_verifications')
    .select('id,sent_at,expires_at,used_at,invalidated_at,invalidation_reason')
    .eq('purchase_intent_id', intentId)
    .eq('buyer_email', buyerEmail)
    .order('sent_at', { ascending: false })
    .limit(5)
  const rows = Array.isArray(data) ? data : []
  const verification = rows[0] || null
  const hourlySentAt = rows
    .map((row) => Date.parse(String(row?.sent_at || '')))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= Date.now() - 60 * 60 * 1000)
    .sort((left, right) => left - right)
  const hourlyCooldownSeconds = hourlySentAt.length >= 5
    ? Math.max(0, Math.ceil(((hourlySentAt[0] + 60 * 60 * 1000) - Date.now()) / 1000))
    : 0
  return {
    verification,
    resendCooldownSeconds: Math.max(resendCooldownForVerification(verification), hourlyCooldownSeconds),
    error
  }
}

function validatePurchaseIntentForEmailVerification(intent) {
  if (!intent) {
    return { ok: false, status: 404, code: 'purchase_intent_not_found', detail: 'Signup request was not found.' }
  }
  if (intent.expires_at) {
    const expiresAt = Date.parse(String(intent.expires_at))
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { ok: false, status: 410, code: 'purchase_intent_expired', detail: 'Signup request has expired.' }
    }
  }
  if (String(intent.status || '').trim().toLowerCase() !== 'pending') {
    return { ok: false, status: 409, code: 'purchase_intent_not_eligible', detail: 'Signup request is not eligible for email verification.' }
  }
  if (!isValidEmail(intent.buyer_email)) {
    return { ok: false, status: 409, code: 'purchase_intent_not_eligible', detail: 'Signup request is not eligible for email verification.' }
  }
  return { ok: true }
}

function validatePurchaseIntentForSmsVerification(intent) {
  if (!intent) {
    return { ok: false, status: 404, code: 'purchase_intent_not_found', detail: 'Signup request was not found.' }
  }
  if (intent.expires_at) {
    const expiresAt = Date.parse(String(intent.expires_at))
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { ok: false, status: 410, code: 'purchase_intent_expired', detail: 'Signup request has expired.' }
    }
  }
  if (String(intent.status || '').trim().toLowerCase() !== 'pending') {
    return { ok: false, status: 409, code: 'purchase_intent_not_eligible', detail: 'Signup request is not eligible for text verification.' }
  }
  if (!normalizeRetailPhone(intent.buyer_phone)) {
    return { ok: false, status: 409, code: 'RETAIL_SMS_VERIFICATION_INVALID_DESTINATION', detail: 'Text verification requires a valid U.S. mobile number. Choose email instead.' }
  }
  return { ok: true }
}

function publicSmsVerificationState(state = {}) {
  return {
    available: state.available === true,
    verified: state.verified === true,
    status: state.status || 'unverified',
    code_active: state.codeActive === true,
    expires_in_seconds: Number(state.expiresInSeconds || 0),
    resend_cooldown_seconds: Number(state.resendCooldownSeconds || 0)
  }
}

function sendSmsVerificationResponse(res, req, status, options = {}) {
  const retryAfter = Math.max(0, Math.ceil(Number(options.retryAfterSeconds || 0)))
  if (status === 429 && retryAfter > 0) res.set('Retry-After', String(retryAfter))
  return res.status(status).json({
    error: options.error || 'sms_verification_failed',
    code: options.code || 'RETAIL_SMS_VERIFICATION_FAILED',
    detail: options.detail || 'Text verification could not be completed. Choose email or try again.',
    retry_after_seconds: retryAfter,
    request_id: req.request_id || null
  })
}

function sendVerificationResponse(res, req, status, options = {}) {
  const retryAfter = Math.max(0, Math.ceil(Number(options.retryAfterSeconds || 0)))
  if (status === 429 && retryAfter > 0) res.set('Retry-After', String(retryAfter))
  return res.status(status).json({
    error: options.error || 'email_verification_failed',
    code: options.code || 'RETAIL_EMAIL_VERIFICATION_FAILED',
    detail: options.detail || 'Email verification could not be completed. No agreement was created.',
    retry_after_seconds: retryAfter,
    request_id: req.request_id || null
  })
}

function validationError(res, req, code, detail, fields = []) {
  return res.status(400).json({
    error: code,
    code,
    detail,
    fields,
    request_id: req.request_id || null
  })
}

function normalizePurchaseIntentInput(body = {}) {
  const rawPlanKey = trimText(body.plan_key || body.plan || body.selected_plan_key, 40).toLowerCase()
  const rawBillingCadence = trimText(body.billing_cadence || body.billing_interval || body.selected_billing_cadence, 40).toLowerCase()
  const planKey = normalizeAlphaScreenPlanKey(rawPlanKey)
  const billingCadence = normalizeBillingInterval(rawBillingCadence)
  const buyerEmail = trimText(body.buyer_email || body.email, 254).toLowerCase()
  const nestedPrepay = body.first_role_prepay && typeof body.first_role_prepay === 'object'
    ? body.first_role_prepay
    : {}

  return {
    raw_plan_key: rawPlanKey,
    raw_billing_cadence: rawBillingCadence,
    selected_plan_key: planKey,
    selected_billing_cadence: billingCadence,
    company_legal_name: trimText(body.company_legal_name || body.companyLegalName, 160),
    company_dba: trimText(body.company_dba || body.companyDba, 160),
    buyer_first_name: trimText(body.buyer_first_name || body.first_name || body.firstName, 80),
    buyer_last_name: trimText(body.buyer_last_name || body.last_name || body.lastName, 80),
    buyer_email: buyerEmail,
    buyer_phone: cleanPhone(body.buyer_phone || body.phone),
    buyer_title: trimText(body.buyer_title || body.title, 120),
    source_path: cleanPath(body.source_path || body.path),
    first_role_prepay_selected: readOptionalBoolean(
      Object.prototype.hasOwnProperty.call(body, 'first_role_prepay_selected')
        ? body.first_role_prepay_selected
        : nestedPrepay.selected
    ),
    agreement_acknowledged: body.agreement_acknowledged === true,
    contact_acknowledged: body.contact_acknowledged === true
  }
}

function validatePurchaseIntentInput(input) {
  const missing = []
  if (!input.raw_plan_key) missing.push('plan_key')
  if (!input.raw_billing_cadence) missing.push('billing_cadence')
  if (!input.company_legal_name) missing.push('company_legal_name')
  if (!input.buyer_first_name) missing.push('buyer_first_name')
  if (!input.buyer_last_name) missing.push('buyer_last_name')
  if (!input.buyer_email) missing.push('buyer_email')
  if (!input.buyer_phone) missing.push('buyer_phone')
  if (!input.buyer_title) missing.push('buyer_title')
  if (!input.agreement_acknowledged) missing.push('agreement_acknowledged')
  if (!input.contact_acknowledged) missing.push('contact_acknowledged')
  if (missing.length) {
    return {
      ok: false,
      code: 'required_fields_missing',
      detail: 'Required signup fields are missing.',
      fields: missing
    }
  }
  if (!['basic', 'pro'].includes(input.selected_plan_key)) {
    return { ok: false, code: 'invalid_plan', detail: 'Plan must be basic or pro.', fields: ['plan_key'] }
  }
  if (!input.selected_billing_cadence) {
    return {
      ok: false,
      code: 'invalid_billing_cadence',
      detail: 'Billing cadence is not supported for this plan.',
      fields: ['billing_cadence']
    }
  }
  if (!isAlphaScreenBillingCadenceSupported(input.selected_plan_key, input.selected_billing_cadence)) {
    return {
      ok: false,
      code: 'invalid_billing_cadence',
      detail: 'Billing cadence is not supported for this plan.',
      fields: ['billing_cadence']
    }
  }
  if (!isValidEmail(input.buyer_email)) {
    return { ok: false, code: 'invalid_email', detail: 'A valid email is required.', fields: ['buyer_email'] }
  }
  return { ok: true }
}

function safePackageSummary(snapshot = {}) {
  return {
    plan_key: snapshot.plan_key || null,
    display_name: snapshot.display_name || null,
    billing_cadence: snapshot.billing_cadence || null,
    platform_fee: snapshot.platform_fee ?? null,
    platform_fee_cents: snapshot.platform_fee_cents ?? null,
    platform_fee_billing_cadence: snapshot.platform_fee_billing_cadence || snapshot.billing_cadence || null,
    platform_monthly_fee: snapshot.platform_monthly_fee ?? null,
    platform_monthly_fee_cents: snapshot.platform_monthly_fee_cents ?? null,
    platform_annual_fee: snapshot.platform_annual_fee ?? null,
    platform_annual_fee_cents: snapshot.platform_annual_fee_cents ?? null,
    annual_platform_fee_note: snapshot.annual_platform_fee_note || null,
    included_interviews: snapshot.included_interviews ?? null,
    included_interviews_per_role: snapshot.included_interviews_per_role ?? null,
    interview_duration_minutes: snapshot.interview_duration_minutes ?? null,
    max_interview_minutes: snapshot.max_interview_minutes ?? null,
    scored_question_count: snapshot.scored_question_count ?? null,
    additional_interview_price: snapshot.additional_interview_price ?? null,
    additional_interview_fee: snapshot.additional_interview_fee ?? null,
    overage_price: snapshot.overage_price ?? null,
    per_role_fee: snapshot.per_role_fee ?? null,
    first_role_prepay: snapshot.first_role_prepay && typeof snapshot.first_role_prepay === 'object'
      ? {
          enabled: snapshot.first_role_prepay.enabled === true,
          selected: snapshot.first_role_prepay.selected === true,
          credit_type: snapshot.first_role_prepay.credit_type || null,
          normal_role_fee_cents: snapshot.first_role_prepay.normal_role_fee_cents ?? null,
          discounted_credit_amount_cents: snapshot.first_role_prepay.discounted_credit_amount_cents ?? null,
          discount_percent: snapshot.first_role_prepay.discount_percent ?? null,
          non_refundable: snapshot.first_role_prepay.non_refundable === true,
          expires: snapshot.first_role_prepay.expires === true
        }
      : null
  }
}

function purchaseIntentPrepayColumns(packageSnapshot = {}) {
  const prepay = packageSnapshot.first_role_prepay && typeof packageSnapshot.first_role_prepay === 'object'
    ? packageSnapshot.first_role_prepay
    : null
  if (!prepay?.selected) {
    return {
      first_role_prepay_selected: false,
      first_role_prepay_amount_cents: null,
      first_role_normal_role_fee_cents: null,
      first_role_prepay_discount_percent: null,
      first_role_prepay_credit_type: null
    }
  }
  return {
    first_role_prepay_selected: true,
    first_role_prepay_amount_cents: Number(prepay.discounted_credit_amount_cents),
    first_role_normal_role_fee_cents: Number(prepay.normal_role_fee_cents),
    first_role_prepay_discount_percent: Number(prepay.discount_percent),
    first_role_prepay_credit_type: prepay.credit_type || 'first_role_prepay'
  }
}

function buildPurchaseIntentResponse(row, { duplicate = false } = {}) {
  const snapshot = row?.package_snapshot && typeof row.package_snapshot === 'object' ? row.package_snapshot : {}
  return {
    purchase_intent_id: row?.id || null,
    status: row?.status || 'pending',
    duplicate,
    selected_package: safePackageSummary(snapshot),
    email_verification: publicEmailVerificationState(row),
    sms_verification: {
      available: readRetailSmsConfiguration(process.env).valid && Boolean(normalizeRetailPhone(row?.buyer_phone)),
      verified: false,
      status: 'unverified',
      code_active: false,
      expires_in_seconds: 0,
      resend_cooldown_seconds: 0
    },
    next_step_message: duplicate
      ? 'A signup request already exists for this company and package. The next step is membership agreement preparation.'
      : 'Signup request received. The next step is membership agreement preparation.',
    request_id: row?.request_id || null
  }
}

function duplicateSignupResponse(res, req, reason = 'signup_exists') {
  return res.status(409).json({
    error: 'signup_already_exists',
    code: 'SIGNUP_ALREADY_EXISTS',
    detail: SIGNUP_ALREADY_EXISTS_MESSAGE,
    message: SIGNUP_ALREADY_EXISTS_MESSAGE,
    next_step: reason === 'active_member'
      ? 'sign_in_or_contact_support'
      : 'check_email_or_contact_support',
    request_id: req.request_id || null
  })
}

function clientLooksActive(client) {
  if (!client) return true
  if (String(client.archived_at || '').trim()) return false
  return true
}

async function findSignupConflictByEmail(email) {
  const buyerEmail = trimText(email, 254).toLowerCase()
  if (!buyerEmail) return { conflict: null, error: null }

  const { data: existingMember, error: memberErr } = await supabaseAdmin
    .from('client_members')
    .select('client_id,email,role')
    .eq('email', buyerEmail)
    .limit(1)
    .maybeSingle()

  if (memberErr) return { conflict: null, error: memberErr }

  if (existingMember?.client_id) {
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,archived_at')
      .eq('id', existingMember.client_id)
      .maybeSingle()

    if (clientErr) return { conflict: null, error: clientErr }
    if (clientLooksActive(client)) {
      return { conflict: { reason: 'active_member' }, error: null }
    }
  }

  const { data: existingIntent, error: intentErr } = await supabaseAdmin
    .from('public_purchase_intents')
    .select('id,status,agreement_id,client_id,created_at')
    .eq('buyer_email', buyerEmail)
    .in('status', BLOCKING_PURCHASE_INTENT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (intentErr) return { conflict: null, error: intentErr }
  if (existingIntent?.id) {
    const status = String(existingIntent.status || '').trim().toLowerCase()
    return {
      conflict: { reason: status === 'completed' ? 'paid_setup_pending' : 'purchase_in_progress' },
      error: null
    }
  }

  const { data: existingAgreement, error: agreementErr } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,status,checkout_status,client_id,created_at')
    .eq('admin_email', buyerEmail)
    .in('status', BLOCKING_AGREEMENT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (agreementErr) return { conflict: null, error: agreementErr }
  if (existingAgreement?.id) {
    const checkoutStatus = String(existingAgreement.checkout_status || '').trim().toLowerCase()
    return {
      conflict: { reason: checkoutStatus === 'paid' ? 'paid_setup_pending' : 'agreement_in_progress' },
      error: null
    }
  }

  return { conflict: null, error: null }
}

function signingPathFromUrl(signingUrl) {
  const raw = String(signingUrl || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.pathname || raw
  } catch (_) {
    return raw
  }
}

function buildAgreementResponse(intent, agreement, signingUrl, { refreshed = false } = {}) {
  const snapshot = intent?.package_snapshot && typeof intent.package_snapshot === 'object' ? intent.package_snapshot : {}
  return {
    ok: true,
    purchase_intent_id: intent?.id || null,
    status: intent?.status || 'agreement_pending',
    agreement: {
      id: agreement?.id || null,
      status: agreement?.status || 'sent',
      signing_url: signingUrl || null,
      signing_path: signingPathFromUrl(signingUrl) || null,
      expires_at: agreement?.signer_token_expires_at || null,
      refreshed: refreshed === true,
      selected_package: safePackageSummary(snapshot)
    },
    next_step_message: 'Membership agreement is ready for review and signature. Payment and account setup happen after signing in later steps.'
  }
}

function validatePurchaseIntentForAgreement(intent) {
  if (!intent) {
    return { ok: false, status: 404, code: 'purchase_intent_not_found', detail: 'Signup request was not found.' }
  }
  const status = String(intent.status || '').trim().toLowerCase()
  if (intent.expires_at) {
    const expiresAt = Date.parse(String(intent.expires_at))
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { ok: false, status: 410, code: 'purchase_intent_expired', detail: 'Signup request has expired.' }
    }
  }
  if (!['pending', 'agreement_pending'].includes(status)) {
    return { ok: false, status: 409, code: 'purchase_intent_not_eligible', detail: 'Signup request is not eligible for agreement preparation.' }
  }
  const snapshot = intent.package_snapshot && typeof intent.package_snapshot === 'object' ? intent.package_snapshot : null
  if (!snapshot || !snapshot.plan_key || !snapshot.billing_cadence) {
    return { ok: false, status: 409, code: 'package_snapshot_missing', detail: 'Signup request package snapshot is missing.' }
  }
  const planKey = normalizeAlphaScreenPlanKey(snapshot.plan_key)
  const billingCadence = normalizeBillingInterval(snapshot.billing_cadence)
  if (!['basic', 'pro'].includes(planKey) || !billingCadence) {
    return { ok: false, status: 409, code: 'package_snapshot_invalid', detail: 'Signup request package snapshot is invalid.' }
  }
  return { ok: true, planKey, billingCadence, snapshot }
}

function buildAgreementInputFromPurchaseIntent(intent) {
  const snapshot = intent?.package_snapshot && typeof intent.package_snapshot === 'object' ? intent.package_snapshot : {}
  const now = new Date()
  const firstName = trimText(intent?.buyer_first_name, 80)
  const lastName = trimText(intent?.buyer_last_name, 80)
  const adminName = trimText(`${firstName} ${lastName}`, 170) || trimText(intent?.buyer_email, 254)
  const includedInterviews = packageNumber(snapshot, 'included_interviews_per_role', 'included_interviews')
  const interviewDuration = packageNumber(snapshot, 'max_interview_minutes', 'interview_duration_minutes')
  const additionalInterviewFee = packageNumber(snapshot, 'additional_interview_fee', 'additional_interview_price', 'overage_price')
  const perRoleFee = packageNumber(snapshot, 'per_role_fee')
  const billingOption = normalizeBillingInterval(snapshot.billing_cadence || intent?.selected_billing_cadence)
  const platformFee = packageNumber(snapshot, 'platform_fee') ??
    (billingOption === 'annual'
      ? packageNumber(snapshot, 'platform_annual_fee')
      : packageNumber(snapshot, 'platform_monthly_fee'))

  return {
    client_id: null,
    client_legal_name: trimText(intent?.company_legal_name, 160),
    dba_trade_name: trimText(intent?.company_dba, 160) || trimText(intent?.company_legal_name, 160),
    primary_admin_name: adminName,
    admin_email: trimText(intent?.buyer_email, 254).toLowerCase(),
    membership_tier: normalizeAlphaScreenPlanKey(snapshot.plan_key),
    platform_fee: platformFee,
    per_role_fee: perRoleFee,
    first_role_prepay: snapshot.first_role_prepay && typeof snapshot.first_role_prepay === 'object'
      ? { ...snapshot.first_role_prepay }
      : null,
    additional_interview_fee: additionalInterviewFee,
    included_interviews_per_role: includedInterviews,
    max_interview_minutes: interviewDuration,
    initial_term_start: dateOnly(now),
    initial_renewal_date: addOneYearDateOnly(now),
    billing_option: billingOption,
    auto_renew: true,
    notice_deadline_days: 30
  }
}

function validateAgreementInput(input) {
  const missing = []
  if (!input.client_legal_name) missing.push('company_legal_name')
  if (!input.primary_admin_name) missing.push('buyer_name')
  if (!isValidEmail(input.admin_email)) missing.push('buyer_email')
  if (!input.membership_tier) missing.push('plan_key')
  if (!input.billing_option) missing.push('billing_cadence')
  if (!input.included_interviews_per_role) missing.push('included_interviews')
  if (!input.max_interview_minutes) missing.push('interview_duration_minutes')
  if (input.platform_fee === null || input.platform_fee === undefined) missing.push('platform_fee')
  if (input.additional_interview_fee === null || input.additional_interview_fee === undefined) missing.push('additional_interview_fee')
  if (input.per_role_fee === null || input.per_role_fee === undefined) missing.push('per_role_fee')
  if (missing.length) {
    return {
      ok: false,
      status: 409,
      code: 'agreement_values_missing',
      detail: 'Signup request is missing agreement package values.',
      fields: missing
    }
  }
  return { ok: true }
}

async function refreshAgreementSigningUrl(agreement) {
  const signerToken = crypto.randomBytes(32).toString('hex')
  const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex')
  const signerTokenExpiresAt = new Date(Date.now() + SIGNING_LINK_TTL_MS).toISOString()
  const signingUrl = buildMembershipAgreementSignUrl(signerToken)

  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .update({
      signer_token_hash: signerTokenHash,
      signer_token_expires_at: signerTokenExpiresAt,
      updated_at: new Date().toISOString()
    })
    .eq('id', agreement.id)
    .eq('status', 'sent')
    .select('id,status,signer_token_expires_at,draft_pdf_path,sent_at')
    .single()

  if (error) {
    const err = new Error(error.message || 'agreement_token_refresh_failed')
    err.code = error.code || 'agreement_token_refresh_failed'
    err.status = 500
    throw err
  }

  return { agreement: data || agreement, signingUrl }
}

module.exports = {
  AGREEMENTS_BUCKET,
  DUPLICATE_WINDOW_MS,
  INTENT_EXPIRATION_MS,
  RETAIL_AGREEMENT_RATE_MAX,
  RETAIL_CHECKOUT_STATUS_RATE_MAX,
  RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  RETAIL_EMAIL_VERIFICATION_SEND_RATE_MAX,
  RETAIL_EMAIL_VERIFICATION_STATUS_RATE_MAX,
  RETAIL_EMAIL_VERIFICATION_TTL_SECONDS,
  RETAIL_EMAIL_VERIFICATION_VERIFY_RATE_MAX,
  RETAIL_PURCHASE_INTENT_IP_RATE_MAX,
  RETAIL_PURCHASE_INTENT_RATE_MAX,
  RETAIL_SMS_CONSENT_COPY_VERSION,
  RETAIL_SMS_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  RETAIL_SMS_VERIFICATION_SEND_RATE_MAX,
  RETAIL_SMS_VERIFICATION_STATUS_RATE_MAX,
  RETAIL_SMS_VERIFICATION_TTL_SECONDS,
  RETAIL_SMS_VERIFICATION_VERIFY_RATE_MAX,
  RETAIL_VERIFICATION_INTENT_SELECT,
  RetailSmsVerificationError,
  SIGNING_LINK_TTL_MS,
  UUID_RE,
  buildAgreementInputFromPurchaseIntent,
  buildAgreementResponse,
  buildAlphaScreenPackageSnapshot,
  buildMembershipAgreementHtml,
  buildMembershipAgreementSignUrl,
  buildPurchaseIntentResponse,
  cleanLookupId,
  consumeRetailSignupSmsOtp,
  crypto,
  deliverRetailSignupSmsOtp,
  duplicateSignupResponse,
  enforceRetailRateLimit,
  findSignupConflictByEmail,
  generateRetailVerificationCode,
  generateRetailVerificationSalt,
  getRequestSubjectKey,
  hasValidRetailEmailVerification,
  hashRetailVerificationCode,
  htmlToPdf,
  invalidateRetailSmsVerification,
  listPublicAlphaScreenPackages,
  loadLatestRetailEmailVerification,
  loadRetailEmailVerificationStatus,
  loadRetailSmsVerificationState,
  normalizeEmail,
  normalizePurchaseIntentInput,
  publicEmailVerificationState,
  publicSmsVerificationState,
  purchaseIntentPrepayColumns,
  readRetailSmsConfiguration,
  refreshAgreementSigningUrl,
  resolvePublicCheckoutReturnState,
  sendRetailSignupEmailVerificationCode,
  sendSmsVerificationResponse,
  sendVerificationResponse,
  slugify,
  supabaseAdmin,
  trimText,
  validateAgreementInput,
  validatePurchaseIntentForAgreement,
  validatePurchaseIntentForEmailVerification,
  validatePurchaseIntentForSmsVerification,
  validatePurchaseIntentInput,
  validationError,
};
