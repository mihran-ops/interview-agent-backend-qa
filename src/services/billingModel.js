'use strict';

// Which billing model a client is charged under.
//
//   fixed    - a per-role interview allowance that is lost when the role closes
//   rollover - unused allowance becomes client-wide credit for rollover_days
//   usage    - interviews beyond the included count are billed on the platform invoice
//
// Rows written before the billing_model column existed carry null, so the model
// falls back to the one implied by plan_tier. Resolution goes through the
// billing owner, the same way getRoleInterviewAvailability does, so a child
// entity is charged under its parent's model.

const { resolveBillingOwnerForScope } = require('./clientBillingScope');

const BILLING_MODELS = Object.freeze(['fixed', 'rollover', 'usage']);
const DEFAULT_BILLING_MODEL = 'fixed';
const DEFAULT_ROLLOVER_DAYS = 90;

const PLAN_TIER_BILLING_MODELS = Object.freeze({
  basic: 'fixed',
  pro: 'rollover',
  enterprise: 'usage'
});

// client_plan_settings holds money in dollars, so a resolved fee is converted
// to cents here and every consumer works in cents from that point on.
const CENTS_PER_DOLLAR = 100;

const UNRESOLVED = Object.freeze({
  billing_model: null,
  plan_tier: null,
  included_interviews_per_role: null,
  per_role_fee_cents: null,
  usage_interview_fee_cents: null,
  rollover_days: null
});

function normalizePlanTier(value) {
  const tier = String(value == null ? '' : value).trim().toLowerCase();
  return tier === 'essential' ? 'basic' : tier;
}

function defaultBillingModelForPlanTier(planTier) {
  return PLAN_TIER_BILLING_MODELS[normalizePlanTier(planTier)] || DEFAULT_BILLING_MODEL;
}

function normalizeBillingModel(value, planTier) {
  const model = String(value == null ? '' : value).trim().toLowerCase();
  if (BILLING_MODELS.includes(model)) return model;
  return defaultBillingModelForPlanTier(planTier);
}

function parseWholeNonNegative(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parsePositiveWhole(value) {
  const parsed = parseWholeNonNegative(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function parseDollarsToCents(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * CENTS_PER_DOLLAR);
}

async function resolveBillingModel({ db, clientId }) {
  if (!db || !clientId) return { ...UNRESOLVED };

  const billingScope = await resolveBillingOwnerForScope(db, clientId);
  if (!billingScope.ok) return { ...UNRESOLVED };
  const billingClientId = billingScope.billingClientId || clientId;

  const { data: planSettings, error: planSettingsError } = await db
    .from('client_plan_settings')
    .select('plan_tier,billing_model,included_interviews_per_role,per_role_fee,usage_interview_fee_cents,rollover_days')
    .eq('client_id', billingClientId)
    .maybeSingle();
  if (planSettingsError || !planSettings) return { ...UNRESOLVED };

  const planTier = normalizePlanTier(planSettings.plan_tier) || null;
  return {
    billing_model: normalizeBillingModel(planSettings.billing_model, planTier),
    plan_tier: planTier,
    included_interviews_per_role: parseWholeNonNegative(planSettings.included_interviews_per_role),
    per_role_fee_cents: parseDollarsToCents(planSettings.per_role_fee),
    usage_interview_fee_cents: parseWholeNonNegative(planSettings.usage_interview_fee_cents),
    rollover_days: parsePositiveWhole(planSettings.rollover_days) ?? DEFAULT_ROLLOVER_DAYS
  };
}

module.exports = {
  BILLING_MODELS,
  DEFAULT_BILLING_MODEL,
  DEFAULT_ROLLOVER_DAYS,
  defaultBillingModelForPlanTier,
  normalizeBillingModel,
  normalizePlanTier,
  resolveBillingModel
};
