'use strict'

const crypto = require('crypto')
const { addDays, addYears, format: formatDate, parseISO } = require('date-fns')
const { formatInTimeZone, fromZonedTime } = require('date-fns-tz')
const {
  buildAlphaScreenPackageSnapshot,
  listPublicAlphaScreenPackages,
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval
} = require('./alphaScreenPackages')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SALES_BUSINESS_TIME_ZONE = 'America/Denver'
const DEAL_STATUSES = Object.freeze([
  'agreement_sent',
  'signed_payment_needed',
  'checkout_in_progress',
  'setup_in_progress',
  'activated',
  'needs_attention',
  'expired',
  'canceled'
])

function makeSalesError(status, code, detail, fields = null) {
  const error = new Error(detail || code || 'sales_workspace_error')
  error.status = Number(status) || 500
  error.code = String(code || 'sales_workspace_error')
  if (fields) error.fields = fields
  return error
}

function trimText(value, max = 300) {
  return String(value || '').trim().slice(0, max)
}

function normalizePhone(value) {
  const raw = trimText(value, 40)
  return raw.replace(/[^\d+().\-\s]/g, '').trim()
}

function normalizeSalesDraft(input = {}) {
  return {
    company_legal_name: trimText(input.company_legal_name, 160),
    company_dba: trimText(input.company_dba, 160),
    buyer_first_name: trimText(input.buyer_first_name, 80),
    buyer_last_name: trimText(input.buyer_last_name, 80),
    buyer_email: trimText(input.buyer_email, 254).toLowerCase(),
    buyer_phone: normalizePhone(input.buyer_phone),
    buyer_title: trimText(input.buyer_title, 120),
    candidate_assistance_name: trimText(input.candidate_assistance_name, 160),
    candidate_assistance_email: trimText(input.candidate_assistance_email, 254).toLowerCase(),
    ghl_contact_id: trimText(input.ghl_contact_id, 160),
    ghl_opportunity_id: trimText(input.ghl_opportunity_id, 160),
    sales_note: trimText(input.sales_note, 1200),
    plan_key: normalizeAlphaScreenPlanKey(input.plan_key),
    billing_cadence: normalizeBillingInterval(input.billing_cadence),
    first_role_prepay_selected: input.first_role_prepay_selected === true,
    promotion_code: trimText(input.promotion_code, 80).toUpperCase()
  }
}

function validateSalesDraft(draft) {
  const fields = {}
  if (!draft.company_legal_name) fields.company_legal_name = 'Company legal name is required.'
  if (!draft.buyer_first_name) fields.buyer_first_name = 'Buyer first name is required.'
  if (!draft.buyer_last_name) fields.buyer_last_name = 'Buyer last name is required.'
  if (!EMAIL_RE.test(draft.buyer_email)) fields.buyer_email = 'Enter a valid buyer email.'
  if (!draft.buyer_phone) fields.buyer_phone = 'Buyer phone is required.'
  if (!draft.buyer_title) fields.buyer_title = 'Buyer title is required.'
  if (!draft.candidate_assistance_name) {
    fields.candidate_assistance_name = 'Candidate-assistance contact name is required.'
  }
  if (!EMAIL_RE.test(draft.candidate_assistance_email)) {
    fields.candidate_assistance_email = 'Enter a valid candidate-assistance email.'
  }
  if (!draft.plan_key) fields.plan_key = 'Select Essential or Pro.'
  if (!draft.billing_cadence) fields.billing_cadence = 'Select monthly or annual billing.'
  if (Object.keys(fields).length) {
    throw makeSalesError(400, 'invalid_sales_draft', 'Review the highlighted sales details.', fields)
  }
  return draft
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = stableValue(value[key])
    return output
  }, {})
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function safePromotionSummary(promotion = null) {
  if (!promotion) return null
  const percentOff = Number(promotion.percent_off)
  const amountOff = Number(promotion.amount_off_cents)
  return {
    code: trimText(promotion.code, 80).toUpperCase(),
    promotion_code_id: trimText(promotion.promotion_code_id, 255),
    label: trimText(promotion.label, 160),
    amount_off_cents: Number.isInteger(amountOff) && amountOff >= 0 ? amountOff : null,
    percent_off: Number.isFinite(percentOff) && percentOff > 0 ? percentOff : null,
    expires_at: promotion.expires_at || null
  }
}

function calculatePricing(draft, promotion = null) {
  const packageSnapshot = buildAlphaScreenPackageSnapshot(draft.plan_key, draft.billing_cadence, {
    firstRolePrepaySelected: draft.first_role_prepay_selected
  })
  if (!packageSnapshot) throw makeSalesError(400, 'invalid_package', 'Select an available membership and billing cadence.')

  const platformFeeCents = Number(packageSnapshot.platform_fee_cents || 0)
  const firstRole = packageSnapshot.first_role_prepay
  const firstRolePrepayCents = draft.first_role_prepay_selected
    ? Number(firstRole?.discounted_credit_amount_cents || 0)
    : 0
  const safePromotion = safePromotionSummary(promotion)
  let promotionDiscountCents = 0
  if (safePromotion?.percent_off) {
    promotionDiscountCents = Math.round(platformFeeCents * (safePromotion.percent_off / 100))
  } else if (Number.isInteger(safePromotion?.amount_off_cents)) {
    promotionDiscountCents = safePromotion.amount_off_cents
  }
  promotionDiscountCents = Math.max(0, Math.min(platformFeeCents, promotionDiscountCents))

  return {
    package_snapshot: packageSnapshot,
    pricing: {
      platform_fee_cents: platformFeeCents,
      first_role_prepay_cents: firstRolePrepayCents,
      promotion_discount_cents: promotionDiscountCents,
      initial_payment_cents: Math.max(0, platformFeeCents + firstRolePrepayCents - promotionDiscountCents),
      recurring_platform_fee_cents: platformFeeCents,
      per_role_fee_cents: Math.round(Number(packageSnapshot.per_role_fee || 0) * 100),
      promotion: safePromotion
    }
  }
}

function listSalesPackages(options = {}) {
  return listPublicAlphaScreenPackages(options).map((item) => ({
    plan_key: item.plan_key,
    display_name: item.display_name,
    platform_monthly_fee_cents: item.platform_monthly_fee_cents,
    platform_annual_fee_cents: item.platform_annual_fee_cents,
    per_role_fee_cents: Math.round(Number(item.per_role_fee || 0) * 100),
    included_interviews_per_role: item.included_interviews_per_role,
    max_interview_minutes: item.max_interview_minutes,
    additional_interview_fee_cents: Math.round(Number(item.additional_interview_fee || 0) * 100),
    first_role_prepay: {
      enabled: item.first_role_prepay?.enabled === true,
      amount_cents: Number(item.first_role_prepay?.discounted_credit_amount_cents || 0),
      normal_role_fee_cents: Number(item.first_role_prepay?.normal_role_fee_cents || 0),
      discount_label: `${Number(item.first_role_prepay?.discount_percent || 10)}% first-role prepay savings`
    }
  }))
}

function agreementSchedule(now = new Date(), timeZone = SALES_BUSINESS_TIME_ZONE) {
  const instant = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(instant.getTime())) throw makeSalesError(500, 'invalid_agreement_clock', 'Agreement dates could not be calculated.')
  const effectiveDate = formatInTimeZone(instant, timeZone, 'yyyy-MM-dd')
  const renewalDate = formatDate(addYears(parseISO(effectiveDate), 1), 'yyyy-MM-dd')
  const nextDate = formatDate(addDays(parseISO(effectiveDate), 1), 'yyyy-MM-dd')
  const expiresAt = fromZonedTime(`${nextDate}T00:00:00`, timeZone).toISOString()
  return {
    effective_date: effectiveDate,
    renewal_date: renewalDate,
    expires_at: expiresAt,
    time_zone: timeZone
  }
}

function isAgreementExpired(agreement = {}, now = new Date()) {
  const deadline = Date.parse(String(agreement?.agreement_expires_at || ''))
  const clock = now instanceof Date ? now.getTime() : new Date(now).getTime()
  return Number.isFinite(deadline) && Number.isFinite(clock) && deadline <= clock
}

function agreementInputFromDraft(draft, packageSnapshot, schedule = agreementSchedule()) {
  return {
    client_id: '',
    client_legal_name: draft.company_legal_name,
    dba_trade_name: draft.company_dba,
    primary_admin_name: `${draft.buyer_first_name} ${draft.buyer_last_name}`.trim(),
    admin_email: draft.buyer_email,
    membership_tier: draft.plan_key,
    platform_fee: packageSnapshot.platform_fee,
    per_role_fee: packageSnapshot.per_role_fee,
    additional_interview_fee: packageSnapshot.additional_interview_fee,
    included_interviews_per_role: packageSnapshot.included_interviews_per_role,
    max_interview_minutes: packageSnapshot.max_interview_minutes,
    first_role_prepay: packageSnapshot.first_role_prepay,
    initial_term_start: schedule.effective_date,
    initial_renewal_date: schedule.renewal_date,
    agreement_expires_at: schedule.expires_at,
    term_start_basis: 'agreement_date',
    billing_option: draft.billing_cadence,
    auto_renew: true,
    notice_deadline_days: 30
  }
}

function deriveDealStatus(intent = {}, agreement = null, now = new Date()) {
  const intentStatus = trimText(intent.status, 40).toLowerCase()
  const agreementStatus = trimText(agreement?.status, 40).toLowerCase()
  const checkoutStatus = trimText(agreement?.checkout_status, 40).toLowerCase()
  if (intentStatus === 'canceled' || agreementStatus === 'voided') return 'canceled'
  if (intentStatus === 'completed' || intent.activated_at || checkoutStatus === 'paid') {
    return intentStatus === 'completed' || intent.activated_at ? 'activated' : 'setup_in_progress'
  }
  if (isAgreementExpired(agreement, now)) return 'expired'
  if (intentStatus === 'expired') return 'expired'
  if (intentStatus === 'checkout_pending' || checkoutStatus === 'pending_payment') return 'checkout_in_progress'
  if (agreementStatus === 'signed') return 'signed_payment_needed'
  if (agreementStatus === 'sent') return 'agreement_sent'
  if (intentStatus === 'agreement_pending') return 'needs_attention'
  return 'needs_attention'
}

const STATUS_LABELS = Object.freeze({
  agreement_sent: 'Agreement sent',
  signed_payment_needed: 'Signed — payment needed',
  checkout_in_progress: 'Checkout in progress',
  setup_in_progress: 'Account setup in progress',
  activated: 'Activated / Closed Won',
  needs_attention: 'Needs attention',
  expired: 'Expired',
  canceled: 'Canceled'
})

const STATUS_ACTIONS = Object.freeze({
  agreement_sent: ['resend_agreement', 'cancel'],
  signed_payment_needed: ['send_payment_reminder', 'cancel'],
  checkout_in_progress: ['send_payment_reminder', 'cancel'],
  setup_in_progress: ['escalate'],
  activated: ['view'],
  needs_attention: ['escalate'],
  expired: ['resend_agreement', 'cancel'],
  canceled: ['view']
})

function safeDeal(intent, agreement = null) {
  const status = deriveDealStatus(intent, agreement)
  const actions = STATUS_ACTIONS[status] || ['view']
  const packageSnapshot = intent.package_snapshot && typeof intent.package_snapshot === 'object'
    ? intent.package_snapshot
    : {}
  return {
    id: intent.id,
    company_legal_name: intent.company_legal_name,
    company_dba: intent.company_dba || '',
    buyer_name: `${intent.buyer_first_name || ''} ${intent.buyer_last_name || ''}`.trim(),
    buyer_email: intent.buyer_email,
    plan_key: intent.selected_plan_key,
    plan_name: packageSnapshot.display_name || (intent.selected_plan_key === 'basic' ? 'Essential' : 'Pro'),
    billing_cadence: intent.selected_billing_cadence,
    status,
    status_label: STATUS_LABELS[status],
    initial_payment_cents: Number(intent.initial_payment_cents || packageSnapshot.platform_fee_cents || 0),
    promotion_label: intent.promotion_label || null,
    created_at: intent.created_at,
    updated_at: intent.updated_at,
    next_action: actions[0],
    available_actions: actions,
    ghl_opportunity_id: intent.ghl_opportunity_id || null
  }
}

module.exports = {
  DEAL_STATUSES,
  agreementInputFromDraft,
  agreementSchedule,
  calculatePricing,
  deriveDealStatus,
  fingerprint,
  isAgreementExpired,
  listSalesPackages,
  makeSalesError,
  normalizeSalesDraft,
  safeDeal,
  safePromotionSummary,
  validateSalesDraft
}
