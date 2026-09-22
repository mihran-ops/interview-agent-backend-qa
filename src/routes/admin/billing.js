'use strict';

// Stripe checkout, subscription and invoice actions for a client. Mounted on the admin router.

const express = require('express');
const { buildAdminDashboardUrl, buildClientDashboardReturnUrl } = require('../../config/urlConfig');
const { sendSubscriptionCheckoutEmail } = require('../../clients/sendgrid');
const { createSubscriptionCheckoutSession } = require('../../services/subscriptionCheckout');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { rejectChildClientForAdminBilling } = require('../../services/admin/adminHelpers');
const { BILLING_MODELS } = require('../../services/billingModel');
const { createImmediateUsageInvoice } = require('../../services/usageBilling');

const router = express.Router();

router.post('/clients/:id/billing/checkout-session', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const clientId = req.params?.id
  const billingCycle = String(req.body?.billing_cycle || '')
  const returnTarget = String(req.body?.return_target || '').trim().toLowerCase()
  const returnTab = String(req.body?.tab || '').trim().toLowerCase()
  if (!clientId) {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'CLIENT_ID_REQUIRED',
      detail: 'Client id is required.',
      hint: null,
      request_id
    })
  }
  if (billingCycle !== 'monthly' && billingCycle !== 'annual') {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'INVALID_BILLING_CYCLE',
      detail: 'billing_cycle must be monthly or annual.',
      hint: null,
      request_id
    })
  }
  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_billing_checkout_session' })
  if (!parentGuard) return

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,plan_tier,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle()

  if (clientError) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'CLIENT_LOOKUP_FAILED',
      detail: clientError.message || 'Failed to load client.',
      hint: clientError.hint || null,
      request_id
    })
  }
  if (!client) {
    return res.status(404).json({
      error: 'not_found',
      code: 'CLIENT_NOT_FOUND',
      detail: 'Client not found.',
      hint: null,
      request_id
    })
  }

  const planTier = String(client.plan_tier || 'basic').toLowerCase()
  if (planTier === 'enterprise') {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'ENTERPRISE_CHECKOUT_NOT_CONFIGURED',
      detail: 'Enterprise checkout is not configured.',
      hint: null,
      request_id
    })
  }

  let resolvedPriceId = ''
  if (planTier === 'basic') {
    resolvedPriceId = billingCycle === 'annual'
      ? String(process.env.STRIPE_PRICE_BASIC_ANNUAL || '')
      : String(process.env.STRIPE_PRICE_BASIC_MONTHLY || '')
  } else if (planTier === 'pro') {
    resolvedPriceId = billingCycle === 'annual'
      ? String(process.env.STRIPE_PRICE_PRO_ANNUAL || '')
      : String(process.env.STRIPE_PRICE_PRO_MONTHLY || '')
  }
  if (!resolvedPriceId) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'STRIPE_PRICE_NOT_CONFIGURED',
      detail: `Missing Stripe price configuration for plan_tier=${planTier} billing_cycle=${billingCycle}.`,
      hint: null,
      request_id
    })
  }

  try {
    const stripe = require('../../clients/stripe')
    let stripeCustomerId = client.stripe_customer_id || null

    if (!stripeCustomerId) {
      const createdCustomer = await stripe.customers.create({
        name: client.name || undefined,
        email: client.email || undefined,
        metadata: { client_id: client.id }
      })
      stripeCustomerId = createdCustomer?.id || null
      if (!stripeCustomerId) {
        return res.status(500).json({
          error: 'internal_error',
          code: 'STRIPE_CUSTOMER_CREATE_FAILED',
          detail: 'Failed to create Stripe customer.',
          hint: null,
          request_id
        })
      }

      const { error: saveCustomerError } = await supabaseAdmin
        .from('clients')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', client.id)
      if (saveCustomerError) {
        return res.status(500).json({
          error: 'internal_error',
          code: 'CLIENT_UPDATE_FAILED',
          detail: saveCustomerError.message || 'Failed to persist Stripe customer.',
          hint: saveCustomerError.hint || null,
          request_id
        })
      }
    }

    const successParams = new URLSearchParams({
      checkout: 'success',
      client_id: String(client.id)
    })
    const cancelParams = new URLSearchParams({
      checkout: 'cancel',
      client_id: String(client.id)
    })
    if (returnTab) {
      successParams.set('tab', returnTab)
      cancelParams.set('tab', returnTab)
    }
    const successUrl =
      returnTarget === 'client'
        ? buildClientDashboardReturnUrl(successParams)
        : buildAdminDashboardUrl(successParams)
    const cancelUrl =
      returnTarget === 'client'
        ? buildClientDashboardReturnUrl(cancelParams)
        : buildAdminDashboardUrl(cancelParams)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: {
        client_id: client.id,
        billing_cycle: billingCycle,
        plan_tier: client.plan_tier || 'basic'
      }
    })

    return res.json({ ok: true, url: session.url, session_id: session.id })
  } catch (e) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'STRIPE_CHECKOUT_SESSION_FAILED',
      detail: e?.message || 'Failed to create Stripe checkout session.',
      hint: null,
      request_id
    })
  }
})

router.post('/clients/:id/subscription-checkout', requireAuth, requireAdmin, async (req, res) => {
  const clientId = req.params?.id
  const requestedPlanTier = String(req.body?.plan_tier || '').trim().toLowerCase()
  const planTier = requestedPlanTier === 'essential' ? 'basic' : requestedPlanTier
  const billingInterval = String(req.body?.billing_interval || '').trim().toLowerCase()
  const returnTab = String(req.body?.tab || '').trim().toLowerCase()

  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_subscription_checkout' })
  if (!parentGuard) return

  try {
    const enterpriseFees = planTier === 'enterprise'
      ? {
          platform_fee: req.body?.platform_fee,
          per_role_fee: req.body?.per_role_fee,
          included_interviews_per_role: req.body?.included_interviews_per_role,
          additional_interview_fee: req.body?.additional_interview_fee,
          usage_interview_fee_cents: req.body?.usage_interview_fee_cents
        }
      : null

    const { session, client, clientEmail } = await createSubscriptionCheckoutSession({
      clientId,
      planTier,
      billingInterval,
      returnTab,
      metadataSource: 'admin_subscription_checkout',
      enterpriseFees,
      requestContext: {
        forwardedProto: req.headers?.['x-forwarded-proto'],
        forwardedHost: req.headers?.['x-forwarded-host'],
        protocol: req.protocol,
        host: req.get('host')
      }
    })

    let email_sent = false
    let email_error = null
    try {
      const emailResult = await sendSubscriptionCheckoutEmail(
        clientEmail,
        session?.url || '',
        client.client_admin_name || client.name || ''
      )
      email_sent = emailResult?.statusCode === 202
      if (!email_sent && emailResult?.skipped) email_error = 'email_skipped'
    } catch (e) {
      email_error = e?.message || 'email_send_failed'
    }

    return res.json({
      ok: true,
      url: session?.url || null,
      session_id: session?.id || null,
      client_email: clientEmail,
      email_sent,
      email_error
    })
  } catch (e) {
    const status = Number(e?.status) || 500
    const code = String(e?.code || '').trim()
    if (status >= 500 && !code) {
      return res.status(500).json({ error: 'create_subscription_checkout_failed', detail: e?.message || 'create_subscription_checkout_failed' })
    }
    return res.status(status).json({ error: code || 'create_subscription_checkout_failed', detail: e?.message || 'create_subscription_checkout_failed' })
  }
})

router.post('/clients/:id/subscription-invoice', requireAuth, requireAdmin, async (req, res) => {
  const clientId = req.params?.id
  const requestedPlanTier = String(req.body?.plan_tier || '').trim().toLowerCase()
  const planTier = requestedPlanTier === 'essential' ? 'basic' : requestedPlanTier
  const billingInterval = String(req.body?.billing_interval || '').trim().toLowerCase()

  if (!['basic', 'pro', 'enterprise'].includes(planTier)) {
    return res.status(400).json({ error: 'invalid_plan_tier' })
  }
  if (!['monthly', 'annual'].includes(billingInterval)) {
    return res.status(400).json({ error: 'invalid_billing_interval' })
  }
  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_subscription_invoice' })
  if (!parentGuard) return

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'client_lookup_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })

  const { data: billingCustomerRows, error: billingCustomerError } = await supabaseAdmin
    .from('billing_customers')
    .select('id,name,primary_contact_email,stripe_customer_id')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
  if (billingCustomerError) return res.status(500).json({ error: 'customer_lookup_failed', detail: billingCustomerError.message })
  const billingCustomerList = Array.isArray(billingCustomerRows) ? billingCustomerRows : []
  const billingCustomer = billingCustomerList[0] || null
  if (!billingCustomer) return res.status(400).json({ error: 'missing_billing_customer' })

  try {
    const stripe = require('../../clients/stripe')
    const candidateStripeCustomerIds = []
    for (const row of billingCustomerList) {
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
    if (!resolvedStripeCustomerId) return res.status(400).json({ error: 'missing_billing_customer' })
    if (billingCustomer?.id && String(billingCustomer?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
      try {
        await supabaseAdmin
          .from('billing_customers')
          .update({ stripe_customer_id: resolvedStripeCustomerId })
          .eq('id', billingCustomer.id)
      } catch (_) {}
    }

    const lineItems = []
    let invoiceTitle = ''
    const invoiceDescription = null
    const daysUntilDue = 7

    if (planTier === 'enterprise') {
      const platformFee = Number(req.body?.platform_fee)
      const perRoleFee = Number(req.body?.per_role_fee)
      if (!Number.isFinite(platformFee) || platformFee < 0 || !Number.isFinite(perRoleFee) || perRoleFee < 0) {
        return res.status(400).json({ error: 'invalid_enterprise_fees' })
      }
      const platformCents = Math.round(platformFee * 100)
      const perRoleCents = Math.round(perRoleFee * 100)
      invoiceTitle = `Enterprise membership (${billingInterval})`
      if (platformCents > 0) lineItems.push({ description: 'Enterprise membership fee', quantity: 1, unit_amount_cents: platformCents })
      if (perRoleCents > 0) lineItems.push({ description: 'Enterprise per-role fee', quantity: 1, unit_amount_cents: perRoleCents })
      if (!lineItems.length) return res.status(400).json({ error: 'invalid_enterprise_fees' })
    } else {
      let priceId = ''
      if (planTier === 'basic') {
        priceId = billingInterval === 'annual'
          ? String(process.env.STRIPE_PRICE_BASIC_ANNUAL || '')
          : String(process.env.STRIPE_PRICE_BASIC_MONTHLY || '')
      } else if (planTier === 'pro') {
        priceId = billingInterval === 'annual'
          ? String(process.env.STRIPE_PRICE_PRO_ANNUAL || '')
          : String(process.env.STRIPE_PRICE_PRO_MONTHLY || '')
      }
      if (!priceId) return res.status(500).json({ error: 'stripe_price_not_configured' })

      const price = await stripe.prices.retrieve(priceId)
      const unitAmount = Number(price?.unit_amount)
      if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
        return res.status(500).json({ error: 'invalid_price_configuration' })
      }
      const planLabel = planTier === 'basic' ? 'Essential' : 'Pro'
      const intervalLabel = billingInterval === 'annual' ? 'annual' : 'monthly'
      invoiceTitle = `${planLabel} membership (${intervalLabel})`
      lineItems.push({
        description: `${planLabel} membership (${intervalLabel})`,
        quantity: 1,
        unit_amount_cents: unitAmount
      })
    }

    const normalizedItems = lineItems.map((item) => {
      const quantity = Number.isFinite(Number(item?.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 1
      const unitAmountCents = Number(item?.unit_amount_cents)
      return {
        description: String(item?.description || '').trim(),
        quantity,
        unit_amount_cents: unitAmountCents,
        line_total_cents: Number.isFinite(unitAmountCents) ? unitAmountCents * quantity : NaN
      }
    })
    if (!normalizedItems.length || normalizedItems.some((item) => !item.description || !Number.isFinite(item.line_total_cents) || item.line_total_cents <= 0)) {
      return res.status(400).json({ error: 'invalid_line_items' })
    }
    const computedSumCents = normalizedItems.reduce((sum, item) => sum + item.line_total_cents, 0)

    const draftInvoice = await stripe.invoices.create({
      customer: resolvedStripeCustomerId,
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue,
      auto_advance: false,
      description: invoiceDescription || undefined,
      metadata: {
        billing_customer_id: billingCustomer.id,
        client_id: client.id,
        invoice_title: invoiceTitle,
        plan_tier: planTier,
        billing_interval: billingInterval
      }
    })

    for (const item of normalizedItems) {
      await stripe.invoiceItems.create({
        customer: resolvedStripeCustomerId,
        invoice: draftInvoice.id,
        description: item.description,
        amount: item.line_total_cents,
        currency: 'usd'
      })
    }

    const finalized = await stripe.invoices.finalizeInvoice(draftInvoice.id)
    const sent = await stripe.invoices.sendInvoice(finalized.id)
    const invoice = sent || finalized
    let amountTotalCents = computedSumCents
    try {
      const afterSend = await stripe.invoices.retrieve(finalized.id)
      amountTotalCents = Number.isFinite(afterSend?.amount_due)
        ? afterSend.amount_due
        : Number.isFinite(afterSend?.total)
          ? afterSend.total
          : computedSumCents
    } catch (_) {}

    const { data: inserted, error: persistError } = await supabaseAdmin
      .from('billing_invoices')
      .insert({
        billing_customer_id: billingCustomer.id,
        title: invoiceTitle,
        invoice_title: invoiceTitle,
        invoice_description: invoiceDescription,
        amount_total_cents: amountTotalCents,
        currency: 'usd',
        status: invoice?.status || null,
        hosted_invoice_url: invoice?.hosted_invoice_url || null,
        stripe_invoice_id: invoice?.id || null,
        customer_name: billingCustomer.name || null,
        customer_email: billingCustomer.primary_contact_email || null
      })
      .select('id,stripe_invoice_id,status,hosted_invoice_url,invoice_description,amount_total_cents,customer_name,customer_email')
      .single()
    if (persistError) return res.status(500).json({ error: 'persist_failed', detail: persistError.message })

    return res.json({
      ok: true,
      invoice: inserted
    })
  } catch (e) {
    return res.status(500).json({ error: 'send_subscription_invoice_failed', detail: e?.message || 'send_subscription_invoice_failed' })
  }
})

// Plan settings a client is billed under. Every field is optional; only the ones
// supplied are written, so a caller can move a client between billing models
// without restating its pricing. Money fields are in dollars, matching the rest
// of client_plan_settings; usage_interview_fee_cents is the one exception and is
// named for its unit.
const PLAN_SETTINGS_FIELD_VALIDATORS = {
  billing_model: (value) => (BILLING_MODELS.includes(String(value).trim().toLowerCase())
    ? String(value).trim().toLowerCase()
    : undefined),
  per_role_fee: (value) => asMoney(value),
  included_interviews_per_role: (value) => asWholeNumber(value),
  additional_interview_fee: (value) => asMoney(value),
  usage_interview_fee_cents: (value) => asWholeNumber(value),
  rollover_days: (value) => {
    const parsed = asWholeNumber(value)
    return parsed != null && parsed > 0 ? parsed : undefined
  }
}

function isSupplied(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

function asMoney(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.round(parsed * 100) / 100
}

function asWholeNumber(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return undefined
  return parsed
}

router.patch('/clients/:id/plan-settings', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const clientId = String(req.params?.id || '').trim()
  if (!clientId) {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'CLIENT_ID_REQUIRED',
      detail: 'Client id is required.',
      hint: null,
      request_id
    })
  }

  const patch = {}
  const invalidFields = []
  for (const [field, validate] of Object.entries(PLAN_SETTINGS_FIELD_VALIDATORS)) {
    const raw = req.body?.[field]
    if (!isSupplied(raw)) continue
    const parsed = validate(raw)
    if (parsed === undefined) invalidFields.push(field)
    else patch[field] = parsed
  }

  if (invalidFields.length) {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'INVALID_PLAN_SETTINGS',
      detail: `Invalid plan settings values: ${invalidFields.join(', ')}.`,
      hint: null,
      request_id
    })
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'NO_PLAN_SETTINGS_SUPPLIED',
      detail: 'At least one plan setting must be supplied.',
      hint: null,
      request_id
    })
  }

  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_plan_settings' })
  if (!parentGuard) return

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('client_plan_settings')
    .update(patch)
    .eq('client_id', clientId)
    .select('client_id,plan_tier,billing_model,billing_interval,platform_fee,per_role_fee,included_interviews_per_role,additional_interview_fee,usage_interview_fee_cents,rollover_days')
    .maybeSingle()

  if (updateError) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'PLAN_SETTINGS_UPDATE_FAILED',
      detail: updateError.message || 'Failed to update plan settings.',
      hint: updateError.hint || null,
      request_id
    })
  }
  if (!updated) {
    return res.status(404).json({
      error: 'not_found',
      code: 'PLAN_SETTINGS_NOT_FOUND',
      detail: 'This client has no plan settings row to update.',
      hint: null,
      request_id
    })
  }

  // There is no generic admin audit table in this codebase, so the change is
  // recorded the way the other admin routes record theirs.
  console.log('admin_plan_settings_updated', {
    client_id: clientId,
    actor_user_id: req.user?.id || null,
    changed_fields: Object.keys(patch),
    request_id
  })

  return res.json({ ok: true, plan_settings: updated })
})

// Raises a usage invoice now rather than waiting for the next cycle — the
// one-time order at signup, and any ad-hoc catch-up.
//
// This spends money, so it takes an Idempotency-Key on the same contract as the
// sales routes: the same key with the same body replays the first answer, the
// same key with a different body is refused, and a key seen while the first call
// is still running is refused rather than run twice.
const USAGE_INVOICE_ROUTE_KEY = 'POST:/admin/clients/:id/usage-invoice'
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,255}$/

function fingerprintOf(value) {
  return require('node:crypto').createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
}

router.post('/clients/:id/usage-invoice', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const clientId = String(req.params?.id || '').trim()
  const actorUserId = req.user?.id || null
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim()

  if (!clientId) {
    return res.status(400).json({
      error: 'invalid_request', code: 'CLIENT_ID_REQUIRED',
      detail: 'Client id is required.', hint: null, request_id
    })
  }
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return res.status(400).json({
      error: 'invalid_request', code: 'IDEMPOTENCY_KEY_REQUIRED',
      detail: 'A valid Idempotency-Key header is required.', hint: null, request_id
    })
  }
  if (!actorUserId) {
    return res.status(401).json({
      error: 'unauthorized', code: 'ACTOR_REQUIRED',
      detail: 'An authenticated administrator is required.', hint: null, request_id
    })
  }

  const requestFingerprint = fingerprintOf({ client_id: clientId, period_end: req.body?.period_end ?? null })

  const { data: seen, error: seenError } = await supabaseAdmin
    .from('billing_idempotency_keys')
    .select('request_fingerprint,response_status,response_body')
    .eq('actor_user_id', actorUserId)
    .eq('route_key', USAGE_INVOICE_ROUTE_KEY)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (seenError) {
    return res.status(503).json({
      error: 'unavailable', code: 'IDEMPOTENCY_LOOKUP_FAILED',
      detail: 'The request could not be safely checked for duplicates.', hint: null, request_id
    })
  }
  if (seen) {
    if (seen.request_fingerprint !== requestFingerprint) {
      return res.status(409).json({
        error: 'conflict', code: 'IDEMPOTENCY_KEY_REUSED',
        detail: 'This Idempotency-Key was already used for different request data.', hint: null, request_id
      })
    }
    if (seen.response_status && seen.response_body) {
      return res.status(seen.response_status).json(seen.response_body)
    }
    return res.status(409).json({
      error: 'conflict', code: 'REQUEST_IN_PROGRESS',
      detail: 'This request is already being processed.', hint: null, request_id
    })
  }

  const { error: reserveError } = await supabaseAdmin
    .from('billing_idempotency_keys')
    .insert({
      actor_user_id: actorUserId,
      route_key: USAGE_INVOICE_ROUTE_KEY,
      idempotency_key: idempotencyKey,
      request_fingerprint: requestFingerprint
    })
  if (reserveError) {
    const status = String(reserveError.code || '') === '23505' ? 409 : 503
    return res.status(status).json({
      error: status === 409 ? 'conflict' : 'unavailable',
      code: status === 409 ? 'REQUEST_IN_PROGRESS' : 'IDEMPOTENCY_RESERVATION_FAILED',
      detail: status === 409
        ? 'This request is already being processed.'
        : 'The request could not be safely started.',
      hint: null,
      request_id
    })
  }

  const finish = async (status, body) => {
    const { error } = await supabaseAdmin
      .from('billing_idempotency_keys')
      .update({ response_status: status, response_body: body })
      .eq('actor_user_id', actorUserId)
      .eq('route_key', USAGE_INVOICE_ROUTE_KEY)
      .eq('idempotency_key', idempotencyKey)
    if (error) {
      console.error('[admin/usage-invoice] idempotency_persist_failed', {
        client_id: clientId, code: error.code || null, request_id
      })
    }
    return res.status(status).json(body)
  }

  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_usage_invoice' })
  if (!parentGuard) return

  try {
    const stripe = require('../../clients/stripe')
    const result = await createImmediateUsageInvoice({
      db: supabaseAdmin,
      stripe,
      clientId,
      periodEnd: req.body?.period_end || null,
      requestId: request_id,
      reason: 'admin_request'
    })

    console.log('admin_usage_invoice_created', {
      client_id: clientId,
      actor_user_id: actorUserId,
      skipped: result.skipped === true,
      reason: result.reason || null,
      invoice_id: result.invoice_id || null,
      total_cents: result.total_cents ?? 0,
      request_id
    })

    return finish(200, { ok: true, ...result })
  } catch (e) {
    return finish(500, {
      error: 'internal_error', code: 'USAGE_INVOICE_FAILED',
      detail: e?.message || 'usage_invoice_failed', hint: null, request_id
    })
  }
})

module.exports = router;
