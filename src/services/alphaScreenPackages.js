'use strict'

const { requirePlanCapacity } = require('./planCapacity')

const PUBLIC_PACKAGE_KEYS = Object.freeze(['basic', 'pro'])
const BILLING_INTERVALS = Object.freeze(['monthly', 'annual'])
const ANNUAL_PLATFORM_FEE_NOTE = 'Discounted annual platform fee'
const FIRST_ROLE_PREPAY_CREDIT_TYPE = 'first_role_prepay'
const BASIC_CAPACITY = requirePlanCapacity('basic')
const PRO_CAPACITY = requirePlanCapacity('pro')

function moneyCents(value) {
  return Math.round(Number(value || 0) * 100)
}

const ALPHA_SCREEN_PACKAGES = Object.freeze({
  basic: Object.freeze({
    plan_key: 'basic',
    display_name: 'Essential',
    platform_monthly_fee: 299,
    platform_annual_fee: 3299,
    annual_platform_fee_note: ANNUAL_PLATFORM_FEE_NOTE,
    included_interviews: 20,
    included_interviews_per_role: 20,
    interview_duration_minutes: BASIC_CAPACITY.interview_duration_minutes,
    max_interview_minutes: BASIC_CAPACITY.max_interview_minutes,
    scored_question_count: BASIC_CAPACITY.scored_question_count,
    additional_interview_price: 30,
    additional_interview_fee: 30,
    per_role_fee: 399,
    first_role_prepay_enabled: true,
    first_role_prepay_discount_percent: 10,
    first_role_prepay_price_cents: 35900,
    first_role_prepay_stripe_price_env: 'STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY',
    billing_cadences: Object.freeze({
      monthly: Object.freeze({
        key: 'monthly',
        display_name: 'Monthly',
        stripe_price_env_var: 'STRIPE_PRICE_BASIC_MONTHLY'
      }),
      annual: Object.freeze({
        key: 'annual',
        display_name: 'Annual',
        stripe_price_env_var: 'STRIPE_PRICE_BASIC_ANNUAL'
      })
    })
  }),
  pro: Object.freeze({
    plan_key: 'pro',
    display_name: 'Pro',
    platform_monthly_fee: 599,
    platform_annual_fee: 6499,
    annual_platform_fee_note: ANNUAL_PLATFORM_FEE_NOTE,
    included_interviews: 30,
    included_interviews_per_role: 30,
    interview_duration_minutes: PRO_CAPACITY.interview_duration_minutes,
    max_interview_minutes: PRO_CAPACITY.max_interview_minutes,
    scored_question_count: PRO_CAPACITY.scored_question_count,
    additional_interview_price: 35,
    additional_interview_fee: 35,
    per_role_fee: 699,
    first_role_prepay_enabled: true,
    first_role_prepay_discount_percent: 10,
    first_role_prepay_price_cents: 62900,
    first_role_prepay_stripe_price_env: 'STRIPE_PRICE_PRO_FIRST_ROLE_PREPAY',
    billing_cadences: Object.freeze({
      monthly: Object.freeze({
        key: 'monthly',
        display_name: 'Monthly',
        stripe_price_env_var: 'STRIPE_PRICE_PRO_MONTHLY'
      }),
      annual: Object.freeze({
        key: 'annual',
        display_name: 'Annual',
        stripe_price_env_var: 'STRIPE_PRICE_PRO_ANNUAL'
      })
    })
  })
})

function normalizeAlphaScreenPlanKey(value) {
  const normalized = String(value || '').trim().toLowerCase()
  const key = normalized === 'essential' ? 'basic' : normalized
  return Object.prototype.hasOwnProperty.call(ALPHA_SCREEN_PACKAGES, key) ? key : ''
}

function normalizeBillingInterval(value) {
  const key = String(value || '').trim().toLowerCase()
  return BILLING_INTERVALS.includes(key) ? key : ''
}

function getAlphaScreenPackage(planKey) {
  const key = normalizeAlphaScreenPlanKey(planKey)
  return key ? ALPHA_SCREEN_PACKAGES[key] : null
}

function getAlphaScreenPlanSettingsDefaults(planKey) {
  const pkg = getAlphaScreenPackage(planKey)
  if (!pkg) return null
  return {
    per_role_fee: pkg.per_role_fee,
    included_interviews_per_role: pkg.included_interviews_per_role,
    additional_interview_fee: pkg.additional_interview_fee,
    max_interview_minutes: pkg.max_interview_minutes
  }
}

function getAlphaScreenPlatformFee(planKey, billingInterval) {
  const pkg = getAlphaScreenPackage(planKey)
  const interval = normalizeBillingInterval(billingInterval)
  if (!pkg || !interval) return null
  return interval === 'annual' ? pkg.platform_annual_fee : pkg.platform_monthly_fee
}

function buildAlphaScreenPlanSettingsPayload({ clientId, planKey, billingInterval } = {}) {
  const client_id = String(clientId || '').trim()
  const plan_tier = normalizeAlphaScreenPlanKey(planKey)
  const billing_interval = normalizeBillingInterval(billingInterval)
  const defaults = getAlphaScreenPlanSettingsDefaults(plan_tier)
  const platformFee = getAlphaScreenPlatformFee(plan_tier, billing_interval)
  if (!client_id || !plan_tier || !billing_interval || !defaults || platformFee === null) return null
  return {
    client_id,
    plan_tier,
    billing_interval,
    platform_fee: platformFee,
    ...defaults
  }
}

function getAlphaScreenStripePriceEnvName(planKey, billingInterval) {
  const pkg = getAlphaScreenPackage(planKey)
  const interval = normalizeBillingInterval(billingInterval)
  return String(pkg?.billing_cadences?.[interval]?.stripe_price_env_var || '').trim()
}

function getAlphaScreenStripePriceId(planKey, billingInterval, env = process.env) {
  const envName = getAlphaScreenStripePriceEnvName(planKey, billingInterval)
  return envName ? String(env?.[envName] || '').trim() : ''
}

function getAlphaScreenFirstRolePrepayConfig(planKey) {
  const pkg = getAlphaScreenPackage(planKey)
  if (!pkg || pkg.first_role_prepay_enabled !== true) return null
  return {
    enabled: true,
    credit_type: FIRST_ROLE_PREPAY_CREDIT_TYPE,
    normal_role_fee_cents: moneyCents(pkg.per_role_fee),
    discounted_credit_amount_cents: Number(pkg.first_role_prepay_price_cents),
    discount_percent: Number(pkg.first_role_prepay_discount_percent),
    non_refundable: true,
    expires: false,
    stripe_price_env_var: pkg.first_role_prepay_stripe_price_env
  }
}

function getAlphaScreenFirstRolePrepayStripePriceEnvName(planKey) {
  return String(getAlphaScreenFirstRolePrepayConfig(planKey)?.stripe_price_env_var || '').trim()
}

function getAlphaScreenFirstRolePrepayStripePriceId(planKey, env = process.env) {
  const envName = getAlphaScreenFirstRolePrepayStripePriceEnvName(planKey)
  return envName ? String(env?.[envName] || '').trim() : ''
}

function isAlphaScreenBillingCadenceSupported(planKey, billingInterval) {
  const pkg = getAlphaScreenPackage(planKey)
  const interval = normalizeBillingInterval(billingInterval)
  return Boolean(pkg?.billing_cadences?.[interval])
}

function buildAlphaScreenFirstRolePrepaySnapshot(planKey, { selected = false } = {}) {
  const config = getAlphaScreenFirstRolePrepayConfig(planKey)
  if (!config) return null
  const { stripe_price_env_var, ...safeConfig } = config
  return {
    ...safeConfig,
    selected: selected === true
  }
}

function buildAlphaScreenPackageSnapshot(planKey, billingInterval, options = {}) {
  const pkg = getAlphaScreenPackage(planKey)
  const interval = normalizeBillingInterval(billingInterval)
  if (!pkg || !interval || !pkg.billing_cadences?.[interval]) return null
  const firstRolePrepay = buildAlphaScreenFirstRolePrepaySnapshot(pkg.plan_key, {
    selected: options.firstRolePrepaySelected === true || options.first_role_prepay_selected === true
  })

  return {
    plan_key: pkg.plan_key,
    display_name: pkg.display_name,
    platform_fee: getAlphaScreenPlatformFee(pkg.plan_key, interval),
    platform_fee_cents: moneyCents(getAlphaScreenPlatformFee(pkg.plan_key, interval)),
    platform_fee_billing_cadence: interval,
    platform_monthly_fee: pkg.platform_monthly_fee,
    platform_monthly_fee_cents: moneyCents(pkg.platform_monthly_fee),
    platform_annual_fee: pkg.platform_annual_fee,
    platform_annual_fee_cents: moneyCents(pkg.platform_annual_fee),
    annual_platform_fee_note: pkg.annual_platform_fee_note,
    included_interviews: pkg.included_interviews,
    included_interviews_per_role: pkg.included_interviews_per_role,
    interview_duration_minutes: pkg.interview_duration_minutes,
    max_interview_minutes: pkg.max_interview_minutes,
    scored_question_count: pkg.scored_question_count,
    additional_interview_price: pkg.additional_interview_price,
    additional_interview_fee: pkg.additional_interview_fee,
    overage_price: pkg.additional_interview_price,
    per_role_fee: pkg.per_role_fee,
    first_role_prepay: firstRolePrepay,
    billing_cadence: interval,
    billing_cadence_display_name: pkg.billing_cadences[interval].display_name
  }
}

function listPublicAlphaScreenPackages({ env = process.env } = {}) {
  return PUBLIC_PACKAGE_KEYS.map((key) => {
    const pkg = ALPHA_SCREEN_PACKAGES[key]
    return {
      plan_key: pkg.plan_key,
      display_name: pkg.display_name,
      platform_monthly_fee: pkg.platform_monthly_fee,
      platform_monthly_fee_cents: moneyCents(pkg.platform_monthly_fee),
      platform_annual_fee: pkg.platform_annual_fee,
      platform_annual_fee_cents: moneyCents(pkg.platform_annual_fee),
      annual_platform_fee_note: pkg.annual_platform_fee_note,
      included_interviews: pkg.included_interviews,
      included_interviews_per_role: pkg.included_interviews_per_role,
      interview_duration_minutes: pkg.interview_duration_minutes,
      max_interview_minutes: pkg.max_interview_minutes,
      scored_question_count: pkg.scored_question_count,
      additional_interview_price: pkg.additional_interview_price,
      additional_interview_fee: pkg.additional_interview_fee,
      overage_price: pkg.additional_interview_price,
      per_role_fee: pkg.per_role_fee,
      first_role_prepay: {
        ...buildAlphaScreenFirstRolePrepaySnapshot(pkg.plan_key, { selected: false }),
        stripe_price_configured: Boolean(String(env?.[pkg.first_role_prepay_stripe_price_env] || '').trim())
      },
      billing_cadences: BILLING_INTERVALS.map((interval) => {
        const cadence = pkg.billing_cadences[interval]
        return {
          key: cadence.key,
          display_name: cadence.display_name,
          stripe_price_configured: Boolean(String(env?.[cadence.stripe_price_env_var] || '').trim())
        }
      })
    }
  })
}

module.exports = {
  ALPHA_SCREEN_PACKAGES,
  PUBLIC_PACKAGE_KEYS,
  BILLING_INTERVALS,
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval,
  getAlphaScreenPackage,
  getAlphaScreenPlanSettingsDefaults,
  getAlphaScreenPlatformFee,
  buildAlphaScreenPlanSettingsPayload,
  getAlphaScreenStripePriceEnvName,
  getAlphaScreenStripePriceId,
  getAlphaScreenFirstRolePrepayConfig,
  getAlphaScreenFirstRolePrepayStripePriceEnvName,
  getAlphaScreenFirstRolePrepayStripePriceId,
  isAlphaScreenBillingCadenceSupported,
  buildAlphaScreenFirstRolePrepaySnapshot,
  buildAlphaScreenPackageSnapshot,
  FIRST_ROLE_PREPAY_CREDIT_TYPE,
  listPublicAlphaScreenPackages
}
