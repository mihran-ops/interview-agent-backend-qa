// routes/webhookStripe.js
const express = require('express');
const stripe = require('../../clients/stripe');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireParentClient } = require('../../services/clientBillingScope');
const { getRoleInterviewAvailability } = require('../../services/roleInterviewAvailability');
const { buildAlphaScreenPlanSettingsPayload } = require('../../services/alphaScreenPackages');
const { activatePublicPurchaseAgreementCheckout } = require('../../services/publicPurchaseActivation');
const { finalizePendingRolePurchase } = require('../../services/rolePurchaseFinalizer');
const { requirePlanCapacity } = require('../../services/planCapacity');
const { defaultBillingModelForPlanTier, resolveBillingModel } = require('../../services/billingModel');
const { applyUsageToInvoice, findLastBilledPeriodEnd } = require('../../services/usageBilling');
const router = express.Router();

const SETTLED_PAYMENT_STATUSES = new Set(['paid', 'no_payment_required']);

// True only once Stripe says the money is actually collected. A completed checkout
// session is not sufficient on its own.
function isSettledPayment(session) {
  return SETTLED_PAYMENT_STATUSES.has(String(session?.payment_status || '').trim().toLowerCase());
}

// A failure that will never succeed on redelivery, so acknowledging it is correct.
// Anything not marked this way is treated as transient and left for Stripe to retry.
function permanentFailure(message) {
  const err = new Error(message);
  err.permanentFailure = true;
  return err;
}

function isUniqueViolation(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  return code === '23505' || /duplicate key|unique/i.test(msg);
}

function toIsoFromUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function addMonthsToIso(isoValue, monthsToAdd) {
  if (!isoValue) return null;
  const d = new Date(isoValue);
  if (!Number.isFinite(d.getTime())) return null;
  d.setMonth(d.getMonth() + Number(monthsToAdd || 0));
  return d.toISOString();
}

function pickId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function buildBillingInvoiceSyncPayload(stripeInvoice) {
  const statusRaw = String(stripeInvoice?.status || '').trim().toLowerCase();
  const hostedInvoiceUrlRaw = String(stripeInvoice?.hosted_invoice_url || '').trim();
  const totalRaw = Number(stripeInvoice?.total);
  const amountDueRaw = Number(stripeInvoice?.amount_due);
  const amountTotalCents = Number.isFinite(totalRaw)
    ? Math.round(totalRaw)
    : Number.isFinite(amountDueRaw)
      ? Math.round(amountDueRaw)
      : null;
  const currencyRaw = String(stripeInvoice?.currency || '').trim().toLowerCase();

  const payload = {};
  if (statusRaw) payload.status = statusRaw;
  if (hostedInvoiceUrlRaw) payload.hosted_invoice_url = hostedInvoiceUrlRaw;
  if (amountTotalCents !== null) payload.amount_total_cents = amountTotalCents;
  if (currencyRaw) payload.currency = currencyRaw;
  return payload;
}

async function syncBillingInvoiceFromStripeEvent(stripeInvoice, request_id) {
  const stripeInvoiceId = pickId(stripeInvoice?.id);
  if (!stripeInvoiceId) return;
  const payload = buildBillingInvoiceSyncPayload(stripeInvoice);
  if (!Object.keys(payload).length) return;

  const { error } = await supabaseAdmin
    .from('billing_invoices')
    .update(payload)
    .eq('stripe_invoice_id', stripeInvoiceId);
  if (error) {
    throw new Error(`Billing invoice sync failed (${stripeInvoiceId}): ${error.message || 'update_failed'}`);
  }
}

const LIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES = new Set(['admin_subscription_checkout', 'agreement_checkout']);

// How long an activation claim may be held before another delivery may take it over.
const ACTIVATION_CLAIM_STALE_MS = 15 * 60 * 1000;

async function requireParentClientForStripeBilling(clientId, context = {}) {
  const result = await requireParentClient(supabaseAdmin, clientId, context);
  if (result.ok) return result;

  const body = result.body || {};
  const err = new Error(body.detail || body.error || body.code || 'Client billing scope check failed');
  err.code = body.code || body.error || 'CLIENT_BILLING_SCOPE_CHECK_FAILED';
  err.status = result.status || 500;
  err.detail = body.detail || err.message;
  err.context = body.context || context || null;
  throw err;
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

function buildClientPlanSettingsPayloadFromSubscription(subscription, clientId, options = {}) {
  if (!clientId) return null;
  const subStatus = String(subscription?.status || '').toLowerCase();
  if (!LIVE_SUB_STATUSES.has(subStatus)) return null;

  const metadataSources = getSubscriptionMetadataSources(subscription);
  const metadataSource = String(getSubscriptionMetadataValue(metadataSources, 'source', options.fallbackSource || '') || '').trim().toLowerCase();
  if (!MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource)) return null;

  const planTier = String(getSubscriptionMetadataValue(metadataSources, 'plan_tier', options.fallbackPlanTier || '') || '').trim().toLowerCase();
  if (!['basic', 'pro', 'enterprise'].includes(planTier)) return null;

  const metadataBillingInterval = String(getSubscriptionMetadataValue(metadataSources, 'billing_interval', options.fallbackBillingInterval || '') || '').trim().toLowerCase();
  const intervalRaw =
    subscription?.items?.data?.[0]?.price?.recurring?.interval ||
    subscription?.plan?.interval ||
    '';
  const billingInterval = ['monthly', 'annual'].includes(metadataBillingInterval)
    ? metadataBillingInterval
    : normalizeBillingInterval(intervalRaw, options.fallbackBillingInterval || null);
  if (!['monthly', 'annual'].includes(String(billingInterval || '').toLowerCase())) return null;

  if (planTier === 'enterprise') {
    const platformFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'platform_fee', options.fallbackPlatformFee), { allowZero: false });
    const perRoleFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'per_role_fee', options.fallbackPerRoleFee));
    const includedInterviewsPerRole = parseWholeNumber(getSubscriptionMetadataValue(metadataSources, 'included_interviews_per_role', options.fallbackIncludedInterviewsPerRole));
    const additionalInterviewFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'additional_interview_fee', options.fallbackAdditionalInterviewFee));
    // Optional: Enterprise clients on the usage model price extra interviews with
    // it. The raw value is checked for presence first, because parseWholeNumber
    // reads an absent value as zero, which would silently reprice the client.
    const usageInterviewFeeCentsRaw = getSubscriptionMetadataValue(metadataSources, 'usage_interview_fee_cents', options.fallbackUsageInterviewFeeCents ?? null);
    const usageInterviewFeeCents = usageInterviewFeeCentsRaw == null
      ? null
      : parseWholeNumber(usageInterviewFeeCentsRaw);

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
      max_interview_minutes: requirePlanCapacity('enterprise').max_interview_minutes,
      ...(usageInterviewFeeCents === null ? {} : { usage_interview_fee_cents: usageInterviewFeeCents })
    };
  }

  return buildAlphaScreenPlanSettingsPayload({
    clientId,
    planKey: planTier,
    billingInterval
  });
}

async function upsertClientPlanSettingsFromSubscription(subscription, clientId, options = {}) {
  const payload = buildClientPlanSettingsPayloadFromSubscription(subscription, clientId, options);
  if (!payload) {
    const metadataSources = getSubscriptionMetadataSources(subscription);
    const metadataSource = String(getSubscriptionMetadataValue(metadataSources, 'source', options.fallbackSource || '') || '').trim().toLowerCase();
    const planTier = String(getSubscriptionMetadataValue(metadataSources, 'plan_tier', options.fallbackPlanTier || '') || '').trim().toLowerCase();
    if (MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource) && planTier === 'enterprise') {
      const platformFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'platform_fee', options.fallbackPlatformFee), { allowZero: false });
      const perRoleFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'per_role_fee', options.fallbackPerRoleFee));
      const includedInterviewsPerRole = parseWholeNumber(getSubscriptionMetadataValue(metadataSources, 'included_interviews_per_role', options.fallbackIncludedInterviewsPerRole));
      const additionalInterviewFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'additional_interview_fee', options.fallbackAdditionalInterviewFee));
      const missingFields = [];
      if (platformFee === null) missingFields.push('platform_fee');
      if (perRoleFee === null) missingFields.push('per_role_fee');
      if (includedInterviewsPerRole === null) missingFields.push('included_interviews_per_role');
      if (additionalInterviewFee === null) missingFields.push('additional_interview_fee');

      const err = new Error(`Enterprise plan settings metadata missing: ${missingFields.join(', ') || 'unknown'}`);
      err.code = 'enterprise_plan_settings_metadata_missing';
      err.missing_fields = missingFields;
      err.client_id = clientId;
      err.subscription_id = pickId(subscription?.id) || null;
      err.source = metadataSource;
      throw err;
    }
    return false;
  }
  await requireParentClientForStripeBilling(clientId, {
    route: 'stripe_webhook_client_plan_settings',
    client_id: clientId,
    subscription_id: pickId(subscription?.id) || null
  });
  // The tier decides the billing model for a newly provisioned client. The column
  // is set on every upsert so a tier change moves the client onto the right model.
  const { error } = await supabaseAdmin
    .from('client_plan_settings')
    .upsert(
      { ...payload, billing_model: defaultBillingModelForPlanTier(payload.plan_tier) },
      { onConflict: 'client_id' }
    );
  if (error) throw new Error(error.message || 'Client plan settings upsert failed');
  return true;
}

function buildClientSubscriptionUpdatesFromStripe(subscription, options = {}) {
  const subStatus = String(subscription?.status || '').toLowerCase();
  const metadata = subscription?.metadata && typeof subscription?.metadata === 'object' ? subscription.metadata : {};
  const metadataSource = String(metadata?.source || options.fallbackSource || '').trim().toLowerCase();
  const metadataPlanTier = String(metadata?.plan_tier || options.fallbackPlanTier || '').trim().toLowerCase();
  const currentTermEnd = toIsoFromUnixSeconds(
    subscription?.current_period_end ??
    subscription?.items?.data?.[0]?.current_period_end ??
    null
  );
  const cancelAtTermEnd = subscription?.cancel_at_period_end === true;
  const isLive = LIVE_SUB_STATUSES.has(subStatus);
  const contractStartAt = toIsoFromUnixSeconds(subscription?.start_date) || null;
  const contractEndAt = contractStartAt ? addMonthsToIso(contractStartAt, 12) : null;
  const intervalRaw =
    subscription?.items?.data?.[0]?.price?.recurring?.interval ||
    subscription?.plan?.interval ||
    '';
  const updates = {
    stripe_customer_id: pickId(subscription?.customer) || options.fallbackCustomerId || null,
    stripe_subscription_id: pickId(subscription?.id) || options.fallbackSubscriptionId || null,
    stripe_subscription_schedule_id: pickId(subscription?.schedule) || null,
    subscription_status: subStatus || null,
    current_term_end: currentTermEnd,
    cancel_at_term_end: cancelAtTermEnd,
    billing_interval: normalizeBillingInterval(intervalRaw, options.fallbackBillingInterval || null),
    billing_status: isLive ? 'active' : 'inactive',
    auto_renew: isLive ? !cancelAtTermEnd : false,
    cancel_effective_at: isLive ? null : (currentTermEnd || new Date().toISOString()),
    contract_start_at: contractStartAt,
    contract_end_at: contractEndAt
  };
  if (MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource) && ['basic', 'pro', 'enterprise'].includes(metadataPlanTier)) {
    updates.plan_tier = metadataPlanTier;
  }
  return updates;
}

// Usage billing rides the platform-fee invoice: when Stripe opens the next
// cycle's draft, the interviews a usage client ran beyond its included counts are
// added to it as line items before it finalizes.
//
// Only a draft invoice can take items. A finalized one is left alone and the
// usage stays unbilled for the next cycle, which is a delay rather than a loss.
async function addUsageLinesToInvoice(invoice, requestId) {
  const billingReason = String(invoice?.billing_reason || '').trim().toLowerCase();
  if (billingReason !== 'subscription_cycle') return;

  const invoiceId = pickId(invoice?.id);
  const subscriptionId = pickId(invoice?.subscription);
  const customerId = pickId(invoice?.customer);
  if (!invoiceId || (!subscriptionId && !customerId)) return;

  let client = null;
  if (subscriptionId) {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('id,stripe_customer_id,contract_start_at')
      .eq('stripe_subscription_id', subscriptionId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Usage billing client lookup failed');
    client = data || null;
  }
  if (!client && customerId) {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('id,stripe_customer_id,contract_start_at')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Usage billing client lookup failed');
    client = data || null;
  }
  if (!client?.id) return;

  const billing = await resolveBillingModel({ db: supabaseAdmin, clientId: client.id });
  if (billing.billing_model !== 'usage') return;

  const invoiceStatus = String(invoice?.status || '').trim().toLowerCase();
  if (invoiceStatus && invoiceStatus !== 'draft') {
    console.warn('usage_invoice_already_finalized', {
      request_id: requestId || null,
      client_id: client.id,
      stripe_invoice_id: invoiceId,
      status: invoiceStatus
    });
    return;
  }

  const periodEnd = toIsoFromUnixSeconds(
    invoice?.lines?.data?.[0]?.period?.end ?? invoice?.period_end ?? null
  );
  const lastBilledPeriodEnd = await findLastBilledPeriodEnd({ db: supabaseAdmin, clientId: client.id });
  const periodStart = lastBilledPeriodEnd
    || client.contract_start_at
    || toIsoFromUnixSeconds(invoice?.period_start ?? null);

  const result = await applyUsageToInvoice({
    db: supabaseAdmin,
    stripe,
    clientId: client.id,
    customerId: customerId || client.stripe_customer_id || null,
    invoiceId,
    periodStart,
    periodEnd,
    metadata: { stripe_invoice_id: invoiceId }
  });

  console.log('usage_invoice_lines_applied', {
    request_id: requestId || null,
    client_id: client.id,
    stripe_invoice_id: invoiceId,
    applied: result.applied === true,
    reason: result.reason || null,
    items: result.items,
    total_cents: result.total_cents
  });
}

function shouldIgnoreStaleSubscriptionUpdate(client, incomingSubscriptionId, eventType) {
  const currentSubscriptionId = String(client?.stripe_subscription_id || '').trim();
  const subscriptionId = String(incomingSubscriptionId || '').trim();
  if (!currentSubscriptionId || !subscriptionId || currentSubscriptionId === subscriptionId) return false;
  console.log('stripe_webhook_subscription_stale_ignored', {
    client_id: client?.id || null,
    incoming_subscription_id: subscriptionId,
    current_subscription_id: currentSubscriptionId,
    event_type: eventType || null
  });
  return true;
}

// A stuck claim otherwise fails silently: the webhook answers 200, Stripe stops
// retrying, and nothing else clears the claim. Surface it so it can be found.
function warnIfActivationStuck(result, context) {
  if (result?.ok === true || result?.status !== 'activation_in_progress') return;
  console.warn('[stripe-webhook] agreement_activation_in_progress', {
    ...context,
    purchase_intent_id: result?.purchase_intent_id || null
  });
}

async function markAgreementCheckoutPaid(agreementId, options = {}) {
  const normalizedAgreementId = String(agreementId || '').trim();
  if (!normalizedAgreementId) return;
  const db = options.db || supabaseAdmin;
  const claim = await claimAgreementPurchaseActivation(
    normalizedAgreementId,
    options.checkoutSessionId || null,
    db
  );
  if (!claim.proceed) return claim.result;
  try {
    const activate = options.activate || activatePublicPurchaseAgreementCheckout;
    const result = await activate({
      agreementId: normalizedAgreementId,
      checkoutSessionId: options.checkoutSessionId || null,
      paidAt: options.paidAt || null,
      subscription: options.subscription || null,
      fallbackCustomerId: options.fallbackCustomerId || null,
      fallbackSubscriptionId: options.fallbackSubscriptionId || null,
      fallbackClientId: options.fallbackClientId || null,
      fallbackPlanTier: options.fallbackPlanTier || null,
      fallbackBillingInterval: options.fallbackBillingInterval || null,
      requestId: options.requestId || null,
      db
    });
    if (claim.claimed && result?.ok !== true) {
      await releaseAgreementPurchaseActivationClaim(claim.intentId, claim.key, db);
    }
    return result;
  } catch (error) {
    if (claim.claimed) {
      await releaseAgreementPurchaseActivationClaim(claim.intentId, claim.key, db);
    }
    throw error;
  }
}

async function claimAgreementPurchaseActivation(agreementId, checkoutSessionId, db = supabaseAdmin) {
  const normalizedAgreementId = String(agreementId || '').trim();
  if (!normalizedAgreementId) return { proceed: false, result: { ok: false, status: 'agreement_missing' } };
  const { data: intent, error: lookupError } = await db
    .from('public_purchase_intents')
    .select('id,status,activated_at,canceled_at,activation_claimed_at,activation_claim_key')
    .eq('agreement_id', normalizedAgreementId)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message || 'Public purchase intent lookup failed');
  if (!intent) return { proceed: true, claimed: false };

  const status = String(intent.status || '').trim().toLowerCase();
  if (status === 'canceled' || intent.canceled_at) {
    return {
      proceed: false,
      result: { ok: false, status: 'purchase_canceled', purchase_intent_id: intent.id }
    };
  }
  if (status === 'completed' && intent.activated_at) return { proceed: true, claimed: false };

  const key = String(checkoutSessionId || '').trim() || `agreement:${normalizedAgreementId}`;
  const claimedAt = new Date().toISOString();
  // A claim older than this is treated as abandoned. The run holding it either died or
  // failed to release it, and without a takeover the activation could never be retried:
  // the claim blocks every later delivery and nothing else clears it.
  const staleBefore = new Date(Date.now() - ACTIVATION_CLAIM_STALE_MS).toISOString();
  let claimQuery = db
    .from('public_purchase_intents')
    .update({ activation_claimed_at: claimedAt, activation_claim_key: key, updated_at: claimedAt })
    .eq('id', intent.id)
    .eq('agreement_id', normalizedAgreementId)
    .neq('status', 'canceled')
    .is('canceled_at', null);
  // Only an intent that has not completed may have a stale claim taken over.
  claimQuery = status === 'completed'
    ? claimQuery.is('activation_claimed_at', null)
    : claimQuery.or(`activation_claimed_at.is.null,activation_claimed_at.lt.${staleBefore}`);
  const { data: claimedIntent, error: claimError } = await claimQuery
    .select('id')
    .maybeSingle();
  if (claimError) throw new Error(claimError.message || 'Purchase activation claim failed');
  if (claimedIntent) {
    if (intent.activation_claimed_at) {
      console.warn('activation_claim_reclaimed', {
        purchase_intent_id: intent.id,
        agreement_id: normalizedAgreementId,
        previous_claim_key: intent.activation_claim_key || null,
        previous_claimed_at: intent.activation_claimed_at,
        claim_key: key
      });
    }
    return { proceed: true, claimed: true, intentId: intent.id, key };
  }

  const { data: latest, error: latestError } = await db
    .from('public_purchase_intents')
    .select('id,agreement_id,status,activated_at,canceled_at,activation_claimed_at,activation_claim_key')
    .eq('id', intent.id)
    .maybeSingle();
  if (latestError) throw new Error(latestError.message || 'Purchase activation state lookup failed');
  const latestStatus = String(latest?.status || '').trim().toLowerCase();
  if (latestStatus === 'completed' && latest?.activated_at) return { proceed: true, claimed: false };
  if (latestStatus === 'canceled' || latest?.canceled_at) {
    return {
      proceed: false,
      result: { ok: false, status: 'purchase_canceled', purchase_intent_id: intent.id }
    };
  }
  if (latest?.agreement_id && String(latest.agreement_id).trim() !== normalizedAgreementId) {
    return {
      proceed: false,
      result: { ok: false, status: 'agreement_superseded', purchase_intent_id: intent.id }
    };
  }
  return {
    proceed: false,
    result: { ok: false, status: 'activation_in_progress', purchase_intent_id: intent.id }
  };
}

async function releaseAgreementPurchaseActivationClaim(intentId, claimKey, db = supabaseAdmin) {
  if (!intentId || !claimKey) return;
  const { error } = await db
    .from('public_purchase_intents')
    .update({ activation_claimed_at: null, activation_claim_key: null, updated_at: new Date().toISOString() })
    .eq('id', intentId)
    .eq('activation_claim_key', claimKey)
    .neq('status', 'completed')
    .select('id')
    .maybeSingle();
  if (error) console.error('stripe_webhook_activation_claim_release_failed', {
    purchase_intent_id: intentId,
    error: error.message || String(error)
  });
}

async function shouldApplyGenericSubscriptionUpdate(metadata, db = supabaseAdmin) {
  const source = String(metadata?.source || '').trim().toLowerCase();
  const agreementId = String(metadata?.agreement_id || '').trim();
  if (source !== 'agreement_checkout' || !agreementId) return true;
  const { data: intent, error } = await db
    .from('public_purchase_intents')
    .select('id,status,activated_at,canceled_at')
    .eq('agreement_id', agreementId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Public purchase intent lookup failed');
  if (!intent) return true;
  return String(intent.status || '').trim().toLowerCase() === 'completed' && !!intent.activated_at && !intent.canceled_at;
}

router.post('/', async (req, res) => {
  const request_id = req.request_id || null;
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    // The verification detail stays server-side: it describes the verification path to a
    // caller who by definition could not authenticate.
    console.warn('[stripe-webhook] signature_verification_failed', {
      request_id,
      detail: err?.message || 'invalid signature'
    });
    return res.status(400).json({
      error: 'bad_request',
      code: 'STRIPE_SIGNATURE_VERIFICATION_FAILED',
      detail: 'Signature verification failed.',
      hint: null,
      request_id
    });
  }

  const eventObject = event?.data?.object || null;
  const { error: insertErr } = await supabaseAdmin
    .from('billing_events')
    .insert({
      stripe_event_id: event.id,
      type: event.type,
      payload: eventObject
    });

  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      return res.status(200).json({ ok: true });
    }
    return res.status(500).json({
      error: 'server_error',
      code: 'BILLING_EVENT_INSERT_FAILED',
      detail: insertErr.message,
      hint: insertErr.hint || null,
      request_id
    });
  }

  const markProcessed = async (processed_ok, errorText = null) => {
    await supabaseAdmin
      .from('billing_events')
      .update({
        processed_ok,
        error: errorText
      })
      .eq('stripe_event_id', event.id);
  };

  try {
    if (String(event.type || '').startsWith('invoice.')) {
      await syncBillingInvoiceFromStripeEvent(eventObject, request_id);
    }

    if (event.type === 'invoice.created') {
      await addUsageLinesToInvoice(eventObject, request_id);
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const customerId = pickId(eventObject?.customer);
      const subscriptionMetadata = eventObject?.metadata && typeof eventObject.metadata === 'object'
        ? eventObject.metadata
        : {};
      const allowGenericSubscriptionUpdate = await shouldApplyGenericSubscriptionUpdate(subscriptionMetadata);
      if (customerId) {
        const incomingSubscriptionId = pickId(eventObject?.id) || pickId(eventObject?.subscription) || null;
        const { data: client, error: clientErr } = await supabaseAdmin
          .from('clients')
          .select('id,stripe_subscription_id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
        if (client?.id && allowGenericSubscriptionUpdate && !shouldIgnoreStaleSubscriptionUpdate(client, incomingSubscriptionId, event.type)) {
          await requireParentClientForStripeBilling(client.id, {
            route: 'stripe_webhook_customer_subscription',
            event_type: event.type,
            client_id: client.id,
            customer_id: customerId,
            subscription_id: incomingSubscriptionId
          });
          const updates = buildClientSubscriptionUpdatesFromStripe(eventObject, {
            fallbackCustomerId: customerId,
            fallbackSubscriptionId: incomingSubscriptionId
          });
          const { error: updateErr } = await supabaseAdmin
            .from('clients')
            .update(updates)
            .eq('id', client.id);
          if (updateErr) throw new Error(updateErr.message || 'Client update failed');
          if (event.type !== 'customer.subscription.deleted') {
            await upsertClientPlanSettingsFromSubscription(eventObject, client.id, {
              fallbackPlanTier: updates?.plan_tier || null,
              fallbackBillingInterval: updates?.billing_interval || null
            });
          }
        } else if (client?.id && !allowGenericSubscriptionUpdate) {
          console.warn('[stripe-webhook] agreement_subscription_update_deferred', {
            agreement_id: String(subscriptionMetadata?.agreement_id || '').trim() || null,
            client_id: client.id,
            event_type: event.type
          });
        }
      }
    } else if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded' ||
      event.type === 'checkout.session.async_payment_failed'
    ) {
      const metadata = eventObject?.metadata && typeof eventObject.metadata === 'object' ? eventObject.metadata : {};
      const purchaseType = String(metadata?.purchase_type || '').trim().toLowerCase();
      const metadataSource = String(metadata?.source || '').trim().toLowerCase();
      const metadataClientId = String(metadata?.client_id || '').trim();
      const metadataAgreementId = String(metadata?.agreement_id || '').trim();
      const metadataPlanTier = String(metadata?.plan_tier || '').trim().toLowerCase();
      const metadataBillingInterval = String(metadata?.billing_interval || '').trim().toLowerCase();
      const customerId = pickId(eventObject?.customer);
      // checkout.session.completed can arrive before the money settles for
      // delayed-notification payment methods, so entitlement is granted on the payment
      // status rather than on the session having completed.
      const paymentFailed = event.type === 'checkout.session.async_payment_failed';
      const paymentSettled = !paymentFailed && isSettledPayment(eventObject);

      if (purchaseType === 'additional_interviews') {
        const purchaseId = String(metadata?.role_interview_purchase_id || '').trim();
        const metadataRoleId = String(metadata?.role_id || '').trim();
        const metadataQuantity = Number(metadata?.quantity);
        let purchase = null;

        if (purchaseId) {
          const { data: purchaseById, error: purchaseByIdErr } = await supabaseAdmin
            .from('role_interview_purchases')
            .select('id,client_id,role_id,quantity,status')
            .eq('id', purchaseId)
            .maybeSingle();
          if (purchaseByIdErr) throw new Error(purchaseByIdErr.message || 'Role interview purchase lookup failed');
          purchase = purchaseById || null;
        } else if (metadataClientId && metadataRoleId) {
          const { data: purchaseByMeta, error: purchaseByMetaErr } = await supabaseAdmin
            .from('role_interview_purchases')
            .select('id,client_id,role_id,quantity,status')
            .eq('client_id', metadataClientId)
            .eq('role_id', metadataRoleId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (purchaseByMetaErr) throw new Error(purchaseByMetaErr.message || 'Role interview purchase lookup failed');
          purchase = purchaseByMeta || null;
        }

        if (!purchase) {
          console.warn('[stripe-webhook][additional-interviews] purchase_not_found', {
            role_interview_purchase_id: purchaseId || null,
            client_id: metadataClientId || null,
            role_id: metadataRoleId || null
          });
          throw permanentFailure('Role interview purchase not found');
        }

        console.log('[stripe-webhook][additional-interviews] purchase_found', {
          role_interview_purchase_id: purchase.id,
          client_id: purchase.client_id,
          role_id: purchase.role_id,
          status: purchase.status
        });

        if (metadataClientId && purchase.client_id !== metadataClientId) {
          throw permanentFailure('Role interview purchase client mismatch');
        }
        if (metadataRoleId && purchase.role_id !== metadataRoleId) {
          throw permanentFailure('Role interview purchase role mismatch');
        }
        if (Number.isFinite(metadataQuantity) && Number.isInteger(metadataQuantity) && metadataQuantity > 0) {
          if (Number(purchase.quantity) !== metadataQuantity) {
            throw permanentFailure('Role interview purchase quantity mismatch');
          }
        }

        if (paymentFailed) {
          console.warn('[stripe-webhook][additional-interviews] payment_failed', {
            request_id,
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id
          });
          const { error: markFailedErr } = await supabaseAdmin
            .from('role_interview_purchases')
            .update({ status: 'failed' })
            .eq('id', purchase.id)
            .in('status', ['pending']);
          if (markFailedErr) throw new Error(markFailedErr.message || 'Role interview purchase failed update failed');
        } else if (!paymentSettled) {
          // Delayed payment method: wait for checkout.session.async_payment_succeeded.
          console.log('[stripe-webhook][additional-interviews] payment_not_settled', {
            request_id,
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id,
            payment_status: String(eventObject?.payment_status || '') || null
          });
        } else if (String(purchase.status || '').trim().toLowerCase() === 'paid') {
          console.log('[stripe-webhook][additional-interviews] already_paid', {
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id
          });
        } else {
          const { error: markPaidErr } = await supabaseAdmin
            .from('role_interview_purchases')
            .update({
              status: 'paid',
              stripe_payment_intent_id: pickId(eventObject?.payment_intent) || null,
              stripe_invoice_id: pickId(eventObject?.invoice) || null
            })
            .eq('id', purchase.id)
            .in('status', ['pending', 'paid']);
          if (markPaidErr) throw new Error(markPaidErr.message || 'Role interview purchase paid update failed');

          console.log('[stripe-webhook][additional-interviews] marked_paid', {
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id,
            stripe_payment_intent_id: pickId(eventObject?.payment_intent) || null,
            stripe_invoice_id: pickId(eventObject?.invoice) || null
          });
        }

        const availability = paymentSettled
          ? await getRoleInterviewAvailability({
            db: supabaseAdmin,
            roleId: purchase.role_id,
            clientId: purchase.client_id
          })
          : { remaining_interviews: null };
        if (availability.remaining_interviews != null && availability.remaining_interviews > 0) {
          const { error: resetNotifyErr } = await supabaseAdmin
            .from('roles')
            .update({ interview_limit_notified_at: null })
            .eq('id', purchase.role_id)
            .eq('client_id', purchase.client_id)
            .not('interview_limit_notified_at', 'is', null);
          if (resetNotifyErr) throw new Error(resetNotifyErr.message || 'Role interview limit notify reset failed');

          console.log('[stripe-webhook][additional-interviews] notify_marker_reset', {
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id,
            remaining_interviews: availability.remaining_interviews
          });
        } else {
          console.log('[stripe-webhook][additional-interviews] notify_marker_reset_skipped', {
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id,
            remaining_interviews: availability.remaining_interviews
          });
        }
      } else if (metadataSource === 'client_role_purchase') {
        const pendingRolePurchaseId = String(metadata?.pending_role_purchase_id || '').trim();
        if (!pendingRolePurchaseId) throw permanentFailure('Pending role purchase id missing');
        const { data: pendingRolePurchase, error: pendingRolePurchaseErr } = await supabaseAdmin
          .from('pending_role_purchases')
          .select('id,client_id,status,role_title,interview_type,jd_storage_path,created_at,paid_at,finalized_role_id')
          .eq('id', pendingRolePurchaseId)
          .maybeSingle();
        if (pendingRolePurchaseErr) throw new Error(pendingRolePurchaseErr.message || 'Pending role purchase lookup failed');
        if (!pendingRolePurchase) throw permanentFailure('Pending role purchase not found');

        if (paymentFailed) {
          console.warn('[stripe-webhook][client-role-purchase] payment_failed', {
            request_id,
            pending_role_purchase_id: pendingRolePurchase.id,
            client_id: pendingRolePurchase.client_id
          });
          const { error: markFailedErr } = await supabaseAdmin
            .from('pending_role_purchases')
            .update({ status: 'failed' })
            .eq('id', pendingRolePurchase.id)
            .is('finalized_role_id', null)
            .in('status', ['pending']);
          if (markFailedErr) throw new Error(markFailedErr.message || 'Pending role purchase failed update failed');
        } else if (!paymentSettled) {
          // Delayed payment method: wait for checkout.session.async_payment_succeeded.
          console.log('[stripe-webhook][client-role-purchase] payment_not_settled', {
            request_id,
            pending_role_purchase_id: pendingRolePurchase.id,
            client_id: pendingRolePurchase.client_id,
            payment_status: String(eventObject?.payment_status || '') || null
          });
        } else if (!pendingRolePurchase.finalized_role_id) {
          const amountTotal = Number(eventObject?.amount_total);
          const { error: markPaidErr } = await supabaseAdmin
            .from('pending_role_purchases')
            .update({
              status: 'paid',
              stripe_checkout_session_id: pickId(eventObject?.id) || null,
              stripe_payment_intent_id: pickId(eventObject?.payment_intent) || null,
              stripe_customer_id: customerId || null,
              amount_paid: Number.isFinite(amountTotal) ? (amountTotal / 100) : null,
              paid_at: new Date().toISOString()
            })
            .is('finalized_role_id', null)
            .in('status', ['pending', 'paid'])
            .eq('id', pendingRolePurchase.id);
          if (markPaidErr) throw new Error(markPaidErr.message || 'Pending role purchase paid update failed');

          const { data: initialClaimedPendingRolePurchase, error: claimFinalizeErr } = await supabaseAdmin
            .from('pending_role_purchases')
            .update({ status: 'finalizing' })
            .eq('id', pendingRolePurchase.id)
            .is('finalized_role_id', null)
            .in('status', ['pending', 'paid'])
            .select('id,client_id,role_title,interview_type,jd_storage_path,created_at,paid_at')
            .maybeSingle();
          if (claimFinalizeErr) throw new Error(claimFinalizeErr.message || 'Pending role purchase claim failed');
          let claimedPendingRolePurchase = initialClaimedPendingRolePurchase || null;
          if (!claimedPendingRolePurchase) {
            const { data: inProgressPendingRolePurchase, error: inProgressClaimErr } = await supabaseAdmin
              .from('pending_role_purchases')
              .select('id,client_id,role_title,interview_type,jd_storage_path,created_at,paid_at')
              .eq('id', pendingRolePurchase.id)
              .is('finalized_role_id', null)
              .eq('status', 'finalizing')
              .maybeSingle();
            if (inProgressClaimErr) throw new Error(inProgressClaimErr.message || 'Pending role purchase claim failed');
            claimedPendingRolePurchase = inProgressPendingRolePurchase || null;
          }
          if (claimedPendingRolePurchase) {
            await finalizePendingRolePurchase({
              db: supabaseAdmin,
              pendingRolePurchase: claimedPendingRolePurchase
            });
          }
        }
      } else if (
        (event.type === 'checkout.session.completed'
          || event.type === 'checkout.session.async_payment_succeeded')
        && String(eventObject?.mode || '').toLowerCase() === 'subscription'
      ) {
        // async_payment_succeeded is admitted because a delayed-notification payment
        // settles after the session completes; without it an agreement paid that way
        // would never activate. async_payment_failed is deliberately excluded.
        const subscriptionId = pickId(eventObject?.subscription);
        let targetClientId = null;
        let checkoutSubscription = null;
        const isPaidAgreementCheckout =
          metadataSource === 'agreement_checkout' &&
          !!metadataAgreementId &&
          isSettledPayment(eventObject);

        if (subscriptionId) {
          if (metadataClientId) {
            const { data: metadataClient, error: metadataClientErr } = await supabaseAdmin
              .from('clients')
              .select('id')
              .eq('id', metadataClientId)
              .maybeSingle();
            if (metadataClientErr) throw new Error(metadataClientErr.message || 'Client lookup failed');
            targetClientId = metadataClient?.id || null;
          }
          if (!targetClientId && customerId) {
            const { data: customerClient, error: customerClientErr } = await supabaseAdmin
              .from('clients')
              .select('id')
              .eq('stripe_customer_id', customerId)
              .maybeSingle();
            if (customerClientErr) throw new Error(customerClientErr.message || 'Client lookup failed');
            targetClientId = customerClient?.id || null;
          }
          if (targetClientId) {
            await requireParentClientForStripeBilling(targetClientId, {
              route: 'stripe_webhook_checkout_subscription',
              client_id: targetClientId,
              customer_id: customerId,
              subscription_id: subscriptionId,
              source: metadataSource || null
            });
            checkoutSubscription = await stripe.subscriptions.retrieve(subscriptionId);
            // Same rule the additional-interviews path follows: a completed session
            // whose payment has not settled grants nothing.
            if (!isPaidAgreementCheckout && paymentSettled) {
              const updates = buildClientSubscriptionUpdatesFromStripe(checkoutSubscription, {
                fallbackCustomerId: customerId,
                fallbackSubscriptionId: subscriptionId,
                fallbackBillingInterval: metadataBillingInterval,
                fallbackSource: metadataSource,
                fallbackPlanTier: metadataPlanTier
              });
              const { error: updateErr } = await supabaseAdmin
                .from('clients')
                .update(updates)
                .eq('id', targetClientId);
              if (updateErr) throw new Error(updateErr.message || 'Client update failed');

              if (MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource)) {
                const planTierForSettings = String(updates?.plan_tier || metadataPlanTier || '').trim().toLowerCase();
                const planSettingsUpserted = await upsertClientPlanSettingsFromSubscription(checkoutSubscription, targetClientId, {
                  fallbackSource: metadataSource,
                  fallbackPlanTier: updates?.plan_tier || metadataPlanTier || null,
                  fallbackBillingInterval: updates?.billing_interval || metadataBillingInterval || null,
                  fallbackPlatformFee: metadata?.platform_fee,
                  fallbackPerRoleFee: metadata?.per_role_fee,
                  fallbackIncludedInterviewsPerRole: metadata?.included_interviews_per_role,
                  fallbackAdditionalInterviewFee: metadata?.additional_interview_fee
                });
                if (!planSettingsUpserted && planTierForSettings === 'enterprise') {
                  const err = new Error('Enterprise plan settings upsert skipped');
                  err.code = 'enterprise_plan_settings_upsert_skipped';
                  err.client_id = targetClientId;
                  err.subscription_id = subscriptionId;
                  err.source = metadataSource;
                  throw err;
                }
              }
            }
          }
        }

        if (isPaidAgreementCheckout) {
          const activationResult = await markAgreementCheckoutPaid(metadataAgreementId, {
            checkoutSessionId: pickId(eventObject?.id) || null,
            paidAt: toIsoFromUnixSeconds(event?.created) || new Date().toISOString(),
            subscription: checkoutSubscription || (subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null),
            fallbackCustomerId: customerId,
            fallbackSubscriptionId: subscriptionId,
            fallbackClientId: targetClientId || metadataClientId || null,
            fallbackPlanTier: metadataPlanTier,
            fallbackBillingInterval: metadataBillingInterval,
            requestId: request_id
          });
          warnIfActivationStuck(activationResult, {
            request_id,
            agreement_id: metadataAgreementId,
            event_type: event.type
          });
        }
      }
    } else if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
      const customerId = pickId(eventObject?.customer);
      const subscriptionId = pickId(eventObject?.subscription);
      let invoiceSubscription = null;
      let metadata = eventObject?.metadata && typeof eventObject.metadata === 'object' ? eventObject.metadata : {};
      if (
        subscriptionId &&
        (
          !String(metadata?.source || '').trim() ||
          !String(metadata?.agreement_id || '').trim() ||
          !String(metadata?.client_id || '').trim()
        )
      ) {
        invoiceSubscription = await stripe.subscriptions.retrieve(subscriptionId);
        const subscriptionMetadata = invoiceSubscription?.metadata && typeof invoiceSubscription.metadata === 'object'
          ? invoiceSubscription.metadata
          : {};
        metadata = {
          ...subscriptionMetadata,
          ...metadata
        };
      }
      const metadataSource = String(metadata?.source || '').trim().toLowerCase();
      const metadataClientId = String(metadata?.client_id || '').trim();
      const metadataAgreementId = String(metadata?.agreement_id || '').trim();
      const metadataPlanTier = String(metadata?.plan_tier || '').trim().toLowerCase();
      const metadataBillingInterval = String(metadata?.billing_interval || '').trim().toLowerCase();
      const isAgreementCheckoutInvoice =
        event.type === 'invoice.payment_succeeded' &&
        metadataSource === 'agreement_checkout' &&
        !!metadataAgreementId;
      const isManagedSubscriptionInvoice =
        event.type === 'invoice.payment_succeeded' &&
        MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource) &&
        !isAgreementCheckoutInvoice &&
        !!metadataClientId &&
        ['basic', 'pro', 'enterprise'].includes(metadataPlanTier) &&
        ['monthly', 'annual'].includes(metadataBillingInterval);

      if (isManagedSubscriptionInvoice) {
        const { data: activationClient, error: activationClientErr } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', metadataClientId)
          .maybeSingle();
        if (activationClientErr) throw new Error(activationClientErr.message || 'Client lookup failed');
        if (!activationClient?.id) throw new Error('Client lookup failed');
        await requireParentClientForStripeBilling(activationClient.id, {
          route: 'stripe_webhook_invoice_managed_activation',
          client_id: activationClient.id,
          subscription_id: subscriptionId,
          source: metadataSource || null
        });

        const contractStartAt = new Date().toISOString();
        const contractEndAt = addMonthsToIso(contractStartAt, 12);
        const invoicePeriodEnd = toIsoFromUnixSeconds(eventObject?.lines?.data?.[0]?.period?.end);
        const activationUpdates = {
          plan_tier: metadataPlanTier,
          subscription_status: 'active',
          billing_status: 'active',
          billing_interval: metadataBillingInterval,
          auto_renew: true,
          cancel_at_term_end: false,
          cancel_effective_at: null,
          contract_start_at: contractStartAt,
          contract_end_at: contractEndAt
        };
        if (!subscriptionId || invoicePeriodEnd) {
          activationUpdates.current_term_end = invoicePeriodEnd || contractEndAt;
        }
        const { error: activationErr } = await supabaseAdmin
          .from('clients')
          .update(activationUpdates)
          .eq('id', activationClient.id);
        if (activationErr) throw new Error(activationErr.message || 'Client activation update failed');
      }

      if (isAgreementCheckoutInvoice) {
        const activationResult = await markAgreementCheckoutPaid(metadataAgreementId, {
          paidAt: toIsoFromUnixSeconds(event?.created) || new Date().toISOString(),
          subscription: invoiceSubscription || null,
          fallbackCustomerId: customerId,
          fallbackSubscriptionId: subscriptionId,
          fallbackClientId: metadataClientId,
          fallbackPlanTier: metadataPlanTier,
          fallbackBillingInterval: metadataBillingInterval,
          requestId: request_id
        });
        warnIfActivationStuck(activationResult, {
          request_id,
          agreement_id: metadataAgreementId,
          event_type: event.type
        });
      }

      if (customerId && !isManagedSubscriptionInvoice && !isAgreementCheckoutInvoice) {
        const { data: client, error: clientErr } = await supabaseAdmin
          .from('clients')
          .select('id,stripe_subscription_id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
        if (client?.id) {
          if (subscriptionId && !shouldIgnoreStaleSubscriptionUpdate(client, subscriptionId, event.type)) {
            await requireParentClientForStripeBilling(client.id, {
              route: 'stripe_webhook_invoice_subscription_sync',
              event_type: event.type,
              client_id: client.id,
              customer_id: customerId,
              subscription_id: subscriptionId
            });
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const updates = buildClientSubscriptionUpdatesFromStripe(subscription, {
              fallbackCustomerId: customerId,
              fallbackSubscriptionId: subscriptionId
            });
            const { error: updateErr } = await supabaseAdmin
              .from('clients')
              .update(updates)
              .eq('id', client.id);
            if (updateErr) throw new Error(updateErr.message || 'Client update failed');
          }
        }
      }
    }

    await markProcessed(true, null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    const permanent = err?.permanentFailure === true;
    const detail = String(err?.message || err || 'processing_failed');
    console.error('[stripe-webhook] processing_failed', {
      request_id,
      stripe_event_id: event.id,
      type: event.type,
      permanent,
      detail
    });

    if (permanent) {
      // Redelivery cannot change the outcome, so record why and acknowledge.
      await markProcessed(false, detail);
      return res.status(200).json({ ok: true });
    }

    // Transient. The dedupe row is removed first, otherwise Stripe's retry would be
    // rejected as a replay by the insert above and the event would be lost for good.
    const { error: cleanupErr } = await supabaseAdmin
      .from('billing_events')
      .delete()
      .eq('stripe_event_id', event.id);
    if (cleanupErr) {
      console.error('[stripe-webhook] dedupe_cleanup_failed', {
        request_id,
        stripe_event_id: event.id,
        detail: String(cleanupErr?.message || cleanupErr)
      });
    }

    return res.status(500).json({
      error: 'server_error',
      code: 'STRIPE_EVENT_PROCESSING_FAILED',
      detail: 'Event processing failed.',
      hint: null,
      request_id
    });
  }
});

module.exports = router;
module.exports.shouldApplyGenericSubscriptionUpdate = shouldApplyGenericSubscriptionUpdate;
module.exports.markAgreementCheckoutPaid = markAgreementCheckoutPaid;
module.exports.claimAgreementPurchaseActivation = claimAgreementPurchaseActivation;
module.exports.releaseAgreementPurchaseActivationClaim = releaseAgreementPurchaseActivationClaim;
