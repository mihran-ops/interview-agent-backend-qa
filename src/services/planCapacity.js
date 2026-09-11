'use strict';

const INTERNAL_SYNTHETIC_CLIENT_IDS_ENV = 'INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS';

const PLAN_CAPACITY = Object.freeze({
  basic: Object.freeze({
    membership_level: 'basic',
    display_name: 'Essential',
    interview_duration_minutes: 10,
    max_interview_minutes: 10,
    scored_question_count: 5,
  }),
  pro: Object.freeze({
    membership_level: 'pro',
    display_name: 'Pro',
    interview_duration_minutes: 12,
    max_interview_minutes: 12,
    scored_question_count: 6,
  }),
  enterprise: Object.freeze({
    membership_level: 'enterprise',
    display_name: 'Enterprise',
    interview_duration_minutes: 15,
    max_interview_minutes: 15,
    scored_question_count: 7,
  }),
});

class PlanCapacityError extends Error {
  constructor(message, code = 'INVALID_MEMBERSHIP_LEVEL') {
    super(message);
    this.name = 'PlanCapacityError';
    this.code = code;
    this.status = 400;
  }
}

function normalizeMembershipLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const canonical = normalized === 'essential' ? 'basic' : normalized;
  return Object.prototype.hasOwnProperty.call(PLAN_CAPACITY, canonical) ? canonical : '';
}

function getPlanCapacity(value) {
  const membershipLevel = normalizeMembershipLevel(value);
  return membershipLevel ? PLAN_CAPACITY[membershipLevel] : null;
}

function requirePlanCapacity(value) {
  const capacity = getPlanCapacity(value);
  if (!capacity) {
    throw new PlanCapacityError('Membership level must be Essential, Pro, or Enterprise.');
  }
  return capacity;
}

function parseInternalSyntheticClientIds(env = process.env) {
  return new Set(
    String(env?.[INTERNAL_SYNTHETIC_CLIENT_IDS_ENV] || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isInternalSyntheticClient(clientId, env = process.env) {
  const normalizedClientId = String(clientId || '').trim();
  return Boolean(normalizedClientId && parseInternalSyntheticClientIds(env).has(normalizedClientId));
}

function validInternalSyntheticDuration(value) {
  const duration = Number(value);
  return Number.isInteger(duration) && duration > 0 && duration <= 59 ? duration : null;
}

function resolvePlanCapacity({ planTier, clientId, configuredDurationMinutes, env = process.env } = {}) {
  const capacity = requirePlanCapacity(planTier);
  const internalDuration = isInternalSyntheticClient(clientId, env)
    ? validInternalSyntheticDuration(configuredDurationMinutes)
    : null;

  if (isInternalSyntheticClient(clientId, env) && internalDuration === null) {
    throw new PlanCapacityError(
      'Internal synthetic interview duration is invalid.',
      'INVALID_INTERNAL_SYNTHETIC_DURATION',
    );
  }

  if (internalDuration !== null) {
    return Object.freeze({
      ...capacity,
      interview_duration_minutes: internalDuration,
      max_interview_minutes: internalDuration,
      internal_synthetic_duration_override: true,
    });
  }

  return capacity;
}

function planCapacityLookupError(error) {
  const lookupError = new PlanCapacityError(
    'Membership capacity could not be loaded.',
    'PLAN_CAPACITY_LOOKUP_FAILED',
  );
  lookupError.status = 503;
  lookupError.cause = error || null;
  return lookupError;
}

async function lookupPlanSettings(db, clientId) {
  const { data, error } = await db
    .from('client_plan_settings')
    .select('client_id,plan_tier,max_interview_minutes')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw planCapacityLookupError(error);
  return data || null;
}

async function resolvePlanCapacityForClient({ db, clientId, env = process.env } = {}) {
  const scopedClientId = String(clientId || '').trim();
  if (!db || typeof db.from !== 'function' || !scopedClientId) {
    throw new PlanCapacityError('Client membership capacity requires a database and client id.');
  }

  const directSettings = await lookupPlanSettings(db, scopedClientId);
  if (directSettings) {
    return resolvePlanCapacity({
      planTier: directSettings.plan_tier,
      clientId: scopedClientId,
      configuredDurationMinutes: directSettings.max_interview_minutes,
      env,
    });
  }

  const { resolveBillingOwnerForScope } = require('./clientBillingScope');
  const billingScope = await resolveBillingOwnerForScope(db, scopedClientId);
  if (!billingScope?.ok) {
    if (Number(billingScope?.status) >= 500) throw planCapacityLookupError(billingScope?.body);
    return requirePlanCapacity(null);
  }

  const billingClientId = String(billingScope.billingClientId || '').trim();
  if (!billingClientId || billingClientId === scopedClientId) return requirePlanCapacity(null);
  const billingSettings = await lookupPlanSettings(db, billingClientId);
  if (!billingSettings) return requirePlanCapacity(null);
  return resolvePlanCapacity({
    planTier: billingSettings.plan_tier,
    clientId: billingClientId,
    configuredDurationMinutes: billingSettings.max_interview_minutes,
    env,
  });
}

module.exports = {
  INTERNAL_SYNTHETIC_CLIENT_IDS_ENV,
  PLAN_CAPACITY,
  PlanCapacityError,
  getPlanCapacity,
  isInternalSyntheticClient,
  normalizeMembershipLevel,
  parseInternalSyntheticClientIds,
  requirePlanCapacity,
  resolvePlanCapacity,
  resolvePlanCapacityForClient,
};
