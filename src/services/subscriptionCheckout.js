'use strict'

const Stripe = require('stripe')
const { supabaseAdmin } = require('../clients/supabase')
const { requireParentClient } = require('./clientBillingScope')
const {
  getAlphaScreenStripePriceId,
  getAlphaScreenFirstRolePrepayStripePriceId
} = require('./alphaScreenPackages')
const { resolvePublicBackendBase, buildClientDashboardReturnUrl } = require('../config/urlConfig')

function makeError(status, code, detail) {
  const err = new Error(detail || code || 'checkout_failed')
  err.status = Number(status) || 500
  err.code = String(code || 'checkout_failed')
  return err
}

function normalizePlanTier(value) {
  const normalized = String(value || '').trim().toLowerCase()
  const canonical = normalized === 'essential' ? 'basic' : normalized
  return ['basic', 'pro', 'enterprise'].includes(canonical) ? canonical : ''
}

function normalizeBillingInterval(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['monthly', 'annual'].includes(normalized) ? normalized : ''
}

function normalizeMetadataObject(value) {
  const output = {}
  const source = value && typeof value === 'object' ? value : {}
  for (const [key, raw] of Object.entries(source)) {
    const keyText = String(key || '').trim()
    if (!keyText) continue
    if (raw == null) continue
    const text = String(raw).trim()
    if (!text) continue
    output[keyText] = text
  }
  return output
}

function asMoneyOrNull(value, { allowZero = true } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n * 100) / 100
  if (allowZero ? rounded < 0 : rounded <= 0) return null
  return rounded
}

function asWholeNumberOrNull(value, { allowZero = true } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (allowZero ? n < 0 : n <= 0) return null
  return n
}

function wantsEmbeddedCheckout(value) {
  if (value === true) return true
  const raw = String(value || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'embedded'
}

function normalizeIdempotencyKey(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 255)
}

function normalizeFirstRolePrepayCheckout(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source || source.selected !== true) return null
  const amountCents = Number(source.amount_cents ?? source.discounted_credit_amount_cents)
  const normalRoleFeeCents = Number(source.normal_role_fee_cents)
  const discountPercent = Number(source.discount_percent)
  const creditType = String(source.credit_type || 'first_role_prepay').trim()
  if (
    creditType !== 'first_role_prepay' ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    !Number.isInteger(normalRoleFeeCents) ||
    normalRoleFeeCents <= 0 ||
    !Number.isInteger(discountPercent) ||
    discountPercent <= 0
  ) {
    throw makeError(400, 'invalid_first_role_prepay', 'Invalid first-role prepay checkout values.')
  }
  return {
    selected: true,
    credit_type: creditType,
    amount_cents: amountCents,
    normal_role_fee_cents: normalRoleFeeCents,
    discount_percent: discountPercent
  }
}

async function resolveStripeCustomerId({
  stripe,
  client,
  billingCustomerList
}) {
  const candidateStripeCustomerIds = []
  const customerRows = Array.isArray(billingCustomerList) ? billingCustomerList : []
  for (const row of customerRows) {
    const id = String(row?.stripe_customer_id || '').trim()
    if (!id) continue
    if (!candidateStripeCustomerIds.includes(id)) candidateStripeCustomerIds.push(id)
  }
  const fallbackCustomerId = String(client?.stripe_customer_id || '').trim()
  if (fallbackCustomerId && !candidateStripeCustomerIds.includes(fallbackCustomerId)) {
    candidateStripeCustomerIds.push(fallbackCustomerId)
  }

  let resolvedStripeCustomerId = null
  for (const candidateId of candidateStripeCustomerIds) {
    try {
      await stripe.customers.retrieve(candidateId)
      resolvedStripeCustomerId = candidateId
      break
    } catch (e) {
      const message = String(e?.message || '').toLowerCase()
      const code = String(e?.code || '').toLowerCase()
      if (code === 'resource_missing' || message.includes('no such customer')) continue
      throw e
    }
  }

  const clientEmail = String(client?.email || '').trim()
  if (!resolvedStripeCustomerId) {
    const createdCustomer = await stripe.customers.create({
      name: client?.name || undefined,
      email: clientEmail || undefined,
      metadata: { client_id: client.id }
    })
    resolvedStripeCustomerId = createdCustomer?.id || null
  } else {
    try {
      await stripe.customers.update(resolvedStripeCustomerId, {
        name: client?.name || undefined,
        email: clientEmail || undefined,
        metadata: { client_id: client.id }
      })
    } catch (_) {}
  }

  return resolvedStripeCustomerId || null
}

async function createSubscriptionCheckoutSession({
  clientId,
  planTier,
  billingInterval,
  returnTab = '',
  cancelUrl = '',
  embedded = false,
  metadataSource = 'admin_subscription_checkout',
  metadata = {},
  firstRolePrepay = null,
  enterpriseFees = null,
  requestContext = null,
  idempotencyKey = ''
}) {
  const normalizedClientId = String(clientId || '').trim()
  const normalizedPlanTier = normalizePlanTier(planTier)
  const normalizedBillingInterval = normalizeBillingInterval(billingInterval)
  const normalizedMetadataSource = String(metadataSource || '').trim().toLowerCase()
  const normalizedReturnTab = String(returnTab || '').trim().toLowerCase()
  const embeddedCheckoutRequested = wantsEmbeddedCheckout(embedded)
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey)
  const firstRolePrepayCheckout = normalizeFirstRolePrepayCheckout(firstRolePrepay)

  if (!normalizedClientId) throw makeError(400, 'client_id_required', 'Client id is required.')
  if (!normalizedPlanTier) throw makeError(400, 'invalid_plan_tier', 'Invalid plan tier.')
  if (!normalizedBillingInterval) throw makeError(400, 'invalid_billing_interval', 'Invalid billing interval.')
  if (!normalizedMetadataSource) throw makeError(400, 'invalid_metadata_source', 'Checkout source is required.')

  const parentGuard = await requireParentClient(supabaseAdmin, normalizedClientId, {
    source: normalizedMetadataSource
  })
  if (!parentGuard.ok) {
    const body = parentGuard.body || {}
    throw makeError(
      parentGuard.status || 500,
      body.code || body.error || 'client_lookup_failed',
      body.detail || 'Client lookup failed.'
    )
  }

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,client_admin_name,stripe_customer_id')
    .eq('id', normalizedClientId)
    .maybeSingle()
  if (clientError) throw makeError(500, 'client_lookup_failed', clientError.message || 'Client lookup failed.')
  if (!client) throw makeError(404, 'client_not_found', 'Client not found.')

  const clientEmail = String(client.email || '').trim()
  if (!clientEmail) throw makeError(400, 'missing_client_email', 'Client email is required.')

  const { data: billingCustomerRows, error: billingCustomerError } = await supabaseAdmin
    .from('billing_customers')
    .select('id,stripe_customer_id')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
  if (billingCustomerError) throw makeError(500, 'customer_lookup_failed', billingCustomerError.message || 'Billing customer lookup failed.')
  const billingCustomerList = Array.isArray(billingCustomerRows) ? billingCustomerRows : []
  const billingCustomer = billingCustomerList[0] || null

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

  let resolvedStripeCustomerId = null
  try {
    resolvedStripeCustomerId = await resolveStripeCustomerId({
      stripe,
      client,
      billingCustomerList
    })
  } catch (e) {
    throw makeError(500, 'stripe_customer_failed', e?.message || 'Stripe customer resolution failed.')
  }
  if (!resolvedStripeCustomerId) throw makeError(400, 'missing_billing_customer', 'Missing billing customer.')

  if (String(client?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
    try {
      await supabaseAdmin
        .from('clients')
        .update({ stripe_customer_id: resolvedStripeCustomerId })
        .eq('id', client.id)
    } catch (_) {}
  }
  if (billingCustomer?.id && String(billingCustomer?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
    try {
      await supabaseAdmin
        .from('billing_customers')
        .update({ stripe_customer_id: resolvedStripeCustomerId })
        .eq('id', billingCustomer.id)
    } catch (_) {}
  }

  let replacesStripeSubscriptionId = null
  let replacementMetadata = null
  if (['admin_subscription_checkout', 'agreement_checkout'].includes(normalizedMetadataSource)) {
    const existingSubscriptions = await stripe.subscriptions.list({
      customer: resolvedStripeCustomerId,
      status: 'all',
      limit: 100
    })
    const blockingSubscription = (existingSubscriptions?.data || []).find((subscription) => {
      return ['active', 'trialing', 'past_due', 'incomplete'].includes(String(subscription?.status || '').trim().toLowerCase())
    })
    if (blockingSubscription) {
      if (normalizedMetadataSource === 'admin_subscription_checkout') {
        throw makeError(409, 'client_subscription_already_exists', 'Client already has an active or pending Stripe subscription.')
      }
      replacesStripeSubscriptionId = String(blockingSubscription?.id || '').trim() || null
      if (replacesStripeSubscriptionId) {
        replacementMetadata = {
          replaces_stripe_subscription_id: replacesStripeSubscriptionId,
          replacement_policy: 'immediate_cancel'
        }
      }
    }
  }

  const lineItems = []
  let enterpriseCheckoutMetadata = null
  if (normalizedPlanTier === 'enterprise') {
    const platformFee = asMoneyOrNull(enterpriseFees?.platform_fee, { allowZero: false })
    const perRoleFee = asMoneyOrNull(enterpriseFees?.per_role_fee, { allowZero: true })
    const includedInterviewsPerRole = asWholeNumberOrNull(enterpriseFees?.included_interviews_per_role, { allowZero: true })
    const additionalInterviewFee = asMoneyOrNull(enterpriseFees?.additional_interview_fee, { allowZero: true })
    if (
      platformFee === null ||
      perRoleFee === null ||
      includedInterviewsPerRole === null ||
      additionalInterviewFee === null
    ) {
      throw makeError(400, 'invalid_enterprise_fees', 'Invalid enterprise pricing fields.')
    }
    const platformCents = Math.round(platformFee * 100)
    if (!Number.isFinite(platformCents) || platformCents <= 0) {
      throw makeError(400, 'invalid_enterprise_fees', 'Invalid enterprise pricing fields.')
    }
    enterpriseCheckoutMetadata = {
      platform_fee: String(Math.round(platformFee * 100) / 100),
      per_role_fee: String(Math.round(perRoleFee * 100) / 100),
      included_interviews_per_role: String(includedInterviewsPerRole),
      additional_interview_fee: String(Math.round(additionalInterviewFee * 100) / 100)
    }
    const enterprisePrice = await stripe.prices.create({
      currency: 'usd',
      unit_amount: platformCents,
      recurring: { interval: normalizedBillingInterval === 'annual' ? 'year' : 'month' },
      product_data: { name: 'Enterprise membership' },
      metadata: {
        source: normalizedMetadataSource,
        client_id: client.id,
        plan_tier: 'enterprise',
        billing_interval: normalizedBillingInterval,
        ...enterpriseCheckoutMetadata,
        ...normalizeMetadataObject(metadata),
        ...normalizeMetadataObject(replacementMetadata || {})
      }
    })
    lineItems.push({ price: enterprisePrice.id, quantity: 1 })
  } else {
    const priceId = getAlphaScreenStripePriceId(normalizedPlanTier, normalizedBillingInterval)
    if (!priceId) throw makeError(500, 'stripe_price_not_configured', 'Stripe price is not configured.')
    lineItems.push({ price: priceId, quantity: 1 })
  }
  let firstRolePrepayMetadata = null
  if (firstRolePrepayCheckout) {
    const firstRolePrepayPriceId = getAlphaScreenFirstRolePrepayStripePriceId(normalizedPlanTier)
    if (!firstRolePrepayPriceId) {
      throw makeError(500, 'first_role_prepay_price_not_configured', 'First-role prepay Stripe price is not configured.')
    }
    lineItems.push({ price: firstRolePrepayPriceId, quantity: 1 })
    firstRolePrepayMetadata = {
      first_role_prepay_selected: 'true',
      first_role_prepay_credit_type: firstRolePrepayCheckout.credit_type,
      first_role_prepay_amount_cents: String(firstRolePrepayCheckout.amount_cents),
      first_role_prepay_normal_role_fee_cents: String(firstRolePrepayCheckout.normal_role_fee_cents),
      first_role_prepay_discount_percent: String(firstRolePrepayCheckout.discount_percent)
    }
  }

  const forwardedProto = String(requestContext?.forwardedProto || requestContext?.protocol || 'https').split(',')[0].trim()
  const forwardedHost = String(requestContext?.forwardedHost || requestContext?.host || '').split(',')[0].trim()
  const computedBackendBase = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : ''
  const publicBackendBase = resolvePublicBackendBase(computedBackendBase || '')

  const successParams = normalizedReturnTab
    ? { checkout: 'success', client_id: client.id, tab: normalizedReturnTab }
    : { checkout: 'success', client_id: client.id }
  const cancelParams = normalizedReturnTab
    ? { checkout: 'cancel', client_id: client.id, tab: normalizedReturnTab }
    : { checkout: 'cancel', client_id: client.id }
  const normalizedCancelUrl = String(cancelUrl || '').trim()

  const checkoutSuccessUrl = publicBackendBase
    ? `${publicBackendBase}/checkout/subscription-success?session_id={CHECKOUT_SESSION_ID}&client_id=${encodeURIComponent(client.id)}${normalizedReturnTab ? `&tab=${encodeURIComponent(normalizedReturnTab)}` : ''}`
    : buildClientDashboardReturnUrl(successParams)

  const checkoutMetadata = {
    source: normalizedMetadataSource,
    client_id: client.id,
    plan_tier: normalizedPlanTier,
    billing_interval: normalizedBillingInterval,
    ...normalizeMetadataObject(enterpriseCheckoutMetadata || {}),
    ...normalizeMetadataObject(firstRolePrepayMetadata || {}),
    ...normalizeMetadataObject(metadata),
    ...normalizeMetadataObject(replacementMetadata || {})
  }

  const checkoutBasePayload = {
    mode: 'subscription',
    customer: resolvedStripeCustomerId,
    line_items: lineItems,
    allow_promotion_codes: true,
    metadata: checkoutMetadata,
    subscription_data: {
      metadata: checkoutMetadata
    }
  }

  let checkoutClientSecret = null
  let primaryCheckoutSession = null
  let hostedFallbackSession = null
  const createOptions = (suffix = '') => {
    if (!normalizedIdempotencyKey) return undefined
    const key = suffix ? `${normalizedIdempotencyKey}:${suffix}` : normalizedIdempotencyKey
    return { idempotencyKey: key.slice(0, 255) }
  }

  if (embeddedCheckoutRequested) {
    try {
      primaryCheckoutSession = await stripe.checkout.sessions.create({
        ...checkoutBasePayload,
        ui_mode: 'embedded',
        return_url: checkoutSuccessUrl
      }, createOptions('embedded'))
      const resolvedClientSecret = String(primaryCheckoutSession?.client_secret || '').trim()
      if (resolvedClientSecret) {
        checkoutClientSecret = resolvedClientSecret
      } else {
        primaryCheckoutSession = null
      }
    } catch (embeddedErr) {
      console.error('create_subscription_embedded_checkout_session_failed:', embeddedErr?.message || embeddedErr)
    }
  }

  if (!primaryCheckoutSession) {
    primaryCheckoutSession = await stripe.checkout.sessions.create({
      ...checkoutBasePayload,
      success_url: checkoutSuccessUrl,
      cancel_url: normalizedCancelUrl || buildClientDashboardReturnUrl(cancelParams)
    }, createOptions())
  } else {
    try {
      hostedFallbackSession = await stripe.checkout.sessions.create({
        ...checkoutBasePayload,
        success_url: checkoutSuccessUrl,
        cancel_url: normalizedCancelUrl || buildClientDashboardReturnUrl(cancelParams)
      }, createOptions('hosted'))
    } catch (hostedFallbackErr) {
      console.error('create_subscription_hosted_fallback_checkout_session_failed:', hostedFallbackErr?.message || hostedFallbackErr)
    }
  }

  return {
    session: primaryCheckoutSession,
    fallbackSession: hostedFallbackSession,
    checkoutClientSecret,
    client,
    clientEmail,
    checkoutMetadata,
    replacesStripeSubscriptionId,
    replacementPolicy: replacesStripeSubscriptionId ? 'immediate_cancel' : null
  }
}

module.exports = {
  createSubscriptionCheckoutSession
}
