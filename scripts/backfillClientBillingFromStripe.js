require('dotenv').config();

const Stripe = require('stripe');
const { supabaseAdmin } = require('../src/clients/supabase');
const { requirePlanCapacity } = require('../src/services/planCapacity');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const LIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const PLAN_SETTINGS_DEFAULTS = {
  basic: {
    per_role_fee: 399,
    included_interviews_per_role: 25,
    additional_interview_fee: 35,
    max_interview_minutes: requirePlanCapacity('basic').max_interview_minutes
  },
  pro: {
    per_role_fee: 699,
    included_interviews_per_role: 50,
    additional_interview_fee: 45,
    max_interview_minutes: requirePlanCapacity('pro').max_interview_minutes
  }
};

function addMonthsToIso(isoString, months) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  return d.toISOString();
}

function normalizeBillingInterval(raw, fallback = null) {
  const intervalRaw = String(raw || '').toLowerCase();
  if (intervalRaw === 'month') return 'monthly';
  if (intervalRaw === 'year') return 'annual';
  if (fallback === 'monthly' || fallback === 'annual') return fallback;
  return null;
}

function parseMoneyValue(raw, options = {}) {
  const allowZero = options.allowZero !== false;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  if (allowZero ? rounded < 0 : rounded <= 0) return null;
  return rounded;
}

function parseWholeNumber(raw, options = {}) {
  const allowZero = options.allowZero !== false;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (allowZero ? n < 0 : n <= 0) return null;
  return n;
}

function getSubscriptionMetadataSources(subscription) {
  const subscriptionMetadata = subscription?.metadata && typeof subscription?.metadata === 'object' ? subscription.metadata : {};
  const priceMetadata = subscription?.items?.data?.[0]?.price?.metadata && typeof subscription?.items?.data?.[0]?.price?.metadata === 'object'
    ? subscription.items.data[0].price.metadata
    : {};
  const planMetadata = subscription?.items?.data?.[0]?.plan?.metadata && typeof subscription?.items?.data?.[0]?.plan?.metadata === 'object'
    ? subscription.items.data[0].plan.metadata
    : {};
  return { subscriptionMetadata, priceMetadata, planMetadata };
}

function getSubscriptionMetadataValue(metadataSources, key, fallback = null) {
  const pick = (obj) => {
    const value = obj?.[key];
    if (value == null) return null;
    const text = String(value).trim();
    return text ? text : null;
  };
  return (
    pick(metadataSources?.subscriptionMetadata) ||
    pick(metadataSources?.priceMetadata) ||
    pick(metadataSources?.planMetadata) ||
    fallback
  );
}

function buildClientPlanSettingsPayloadFromSubscription(subscription, clientId) {
  if (!clientId) return null;
  const subStatus = String(subscription?.status || '').toLowerCase();
  if (!LIVE_SUB_STATUSES.has(subStatus)) return null;

  const metadataSources = getSubscriptionMetadataSources(subscription);
  const metadataSource = String(getSubscriptionMetadataValue(metadataSources, 'source', '') || '').trim().toLowerCase();
  if (metadataSource !== 'admin_subscription_checkout') return null;

  const planTier = String(getSubscriptionMetadataValue(metadataSources, 'plan_tier', '') || '').trim().toLowerCase();
  if (!['basic', 'pro', 'enterprise'].includes(planTier)) return null;

  const metadataBillingInterval = String(getSubscriptionMetadataValue(metadataSources, 'billing_interval', '') || '').trim().toLowerCase();
  const intervalRaw =
    subscription?.items?.data?.[0]?.price?.recurring?.interval ||
    subscription?.plan?.interval ||
    '';
  const billingInterval = ['monthly', 'annual'].includes(metadataBillingInterval)
    ? metadataBillingInterval
    : normalizeBillingInterval(intervalRaw, null);
  if (!['monthly', 'annual'].includes(String(billingInterval || '').toLowerCase())) return null;

  if (planTier === 'enterprise') {
    const platformFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'platform_fee', null), { allowZero: false });
    const perRoleFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'per_role_fee', null));
    const includedInterviewsPerRole = parseWholeNumber(getSubscriptionMetadataValue(metadataSources, 'included_interviews_per_role', null));
    const additionalInterviewFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'additional_interview_fee', null));
    if (
      platformFee === null ||
      perRoleFee === null ||
      includedInterviewsPerRole === null ||
      additionalInterviewFee === null
    ) {
      return null;
    }
    return {
      client_id: clientId,
      plan_tier: 'enterprise',
      billing_interval: billingInterval,
      platform_fee: platformFee,
      per_role_fee: perRoleFee,
      included_interviews_per_role: includedInterviewsPerRole,
      additional_interview_fee: additionalInterviewFee,
      max_interview_minutes: requirePlanCapacity('enterprise').max_interview_minutes
    };
  }

  const defaults = PLAN_SETTINGS_DEFAULTS[planTier];
  if (!defaults) return null;
  return {
    client_id: clientId,
    plan_tier: planTier,
    billing_interval: billingInterval,
    platform_fee: null,
    per_role_fee: defaults.per_role_fee,
    included_interviews_per_role: defaults.included_interviews_per_role,
    additional_interview_fee: defaults.additional_interview_fee,
    max_interview_minutes: defaults.max_interview_minutes
  };
}

async function upsertClientPlanSettingsFromSubscription(subscription, clientId) {
  const payload = buildClientPlanSettingsPayloadFromSubscription(subscription, clientId);
  if (!payload) return false;
  const { error } = await supabaseAdmin
    .from('client_plan_settings')
    .upsert(payload, { onConflict: 'client_id' });
  if (error) throw new Error(error.message || 'Client plan settings upsert failed');
  return true;
}

async function loadTargetClients() {
  const selectFields = 'id,name,stripe_customer_id,stripe_subscription_id,subscription_status,billing_status';

  const { data: byStatus, error: byStatusError } = await supabaseAdmin
    .from('clients')
    .select(selectFields)
    .in('subscription_status', ['active', 'trialing']);

  if (byStatusError) {
    throw new Error(byStatusError.message || 'Failed to load clients by status');
  }

  const { data: bySubscription, error: bySubscriptionError } = await supabaseAdmin
    .from('clients')
    .select(selectFields)
    .not('stripe_subscription_id', 'is', null)
    .neq('stripe_subscription_id', '');

  if (bySubscriptionError) {
    throw new Error(bySubscriptionError.message || 'Failed to load clients by subscription id');
  }

  const merged = new Map();
  for (const client of byStatus || []) merged.set(client.id, client);
  for (const client of bySubscription || []) merged.set(client.id, client);
  return Array.from(merged.values());
}

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[backfill] Missing STRIPE_SECRET_KEY');
    process.exitCode = 1;
    return;
  }

  const clients = await loadTargetClients();
  console.log(`[backfill] clients_to_process=${clients.length}`);

  let updated = 0;
  let skippedNoSubscriptionId = 0;
  let failed = 0;

  for (const client of clients) {
    const subscriptionId = String(client.stripe_subscription_id || '').trim();

    if (!subscriptionId) {
      skippedNoSubscriptionId += 1;
      console.log(`[skip] client_id=${client.id} name=${client.name || ''} reason=no_subscription_id`);
      continue;
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      const subStatus = String(subscription.status || '').toLowerCase();
      const periodEnd =
        subscription.current_period_end ??
        subscription.items?.data?.[0]?.current_period_end ??
        null;
      const currentTermEnd = periodEnd ? new Date(Number(periodEnd) * 1000).toISOString() : null;
      const cancelAtTermEnd = subscription.cancel_at_period_end === true;
      const scheduleId = subscription.schedule && typeof subscription.schedule === 'object'
        ? subscription.schedule.id || null
        : (typeof subscription.schedule === 'string' ? subscription.schedule : null);
      const billingStatus = (subStatus === 'active' || subStatus === 'trialing') ? 'active' : 'inactive';
      const intervalRaw = String(
        subscription.items?.data?.[0]?.price?.recurring?.interval ||
        subscription.plan?.interval ||
        ''
      ).toLowerCase();
      const billingInterval = intervalRaw === 'month'
        ? 'monthly'
        : (intervalRaw === 'year' ? 'annual' : null);
      const contractStartIso = subscription.start_date
        ? new Date(Number(subscription.start_date) * 1000).toISOString()
        : null;
      const contractEndIso = addMonthsToIso(contractStartIso, 12);

      const { error: updateError } = await supabaseAdmin
        .from('clients')
        .update({
          stripe_subscription_id: subscriptionId,
          stripe_subscription_schedule_id: scheduleId,
          subscription_status: subStatus || null,
          current_term_end: currentTermEnd,
          cancel_at_term_end: cancelAtTermEnd,
          billing_status: billingStatus,
          billing_interval: billingInterval,
          contract_start_at: contractStartIso,
          contract_end_at: contractEndIso,
          auto_renew: true
        })
        .eq('id', client.id);

      if (updateError) {
        throw new Error(updateError.message || 'Client update failed');
      }
      const planSettingsUpserted = await upsertClientPlanSettingsFromSubscription(subscription, client.id);

      updated += 1;
      console.log(
        `[ok] client_id=${client.id} sub_id=${subscriptionId} status=${subStatus || 'null'} billing=${billingStatus} current_term_end=${currentTermEnd || 'null'} plan_settings=${planSettingsUpserted ? 'upserted' : 'skipped'}`
      );
    } catch (err) {
      failed += 1;
      console.error(`[fail] client_id=${client.id} sub_id=${subscriptionId} error=${err?.message || err}`);
    }
  }

  console.log(
    `[summary] total=${clients.length} updated=${updated} skipped_no_subscription_id=${skippedNoSubscriptionId} failed=${failed}`
  );
}

main().catch((err) => {
  console.error(`[fatal] ${err?.message || err}`);
  process.exitCode = 1;
});
