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
          additional_interview_fee: req.body?.additional_interview_fee
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


module.exports = router;
