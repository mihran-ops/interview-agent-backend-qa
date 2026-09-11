'use strict';

// Client-facing billing: the summary, the Stripe portal, and interview top-ups.
// Mounted at the application root, so the paths here are absolute.

const express = require('express');
const { buildClientDashboardReturnUrl } = require('../../config/urlConfig');
const { resolveBillingOwnerForScope } = require('../../services/clientBillingScope');
const { canViewLegalBillingForClient } = require('../../services/clientScope');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const {
  hasClientWriteAccess,
  respondWithBillingScopeError,
  sanitizeClientDashboardTab,
  wantsEmbeddedCheckout,
} = require('../../services/clientScope/clientBilling');

const router = express.Router();

router.get('/clients/billing/summary', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    if (ids.length === 0) return res.json({ items: [] })

    const wantedClientId = String(req.query?.client_id || '').trim()
    if (wantedClientId && !ids.includes(wantedClientId)) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true

    let queryIds = ids
    if (wantedClientId) {
      if (!isGlobalAdmin && !canViewLegalBillingForClient(req.clientScope, wantedClientId)) {
        return res.status(403).json({ error: 'forbidden' })
      }
      const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, wantedClientId)
      if (!billingScope.ok) return respondWithBillingScopeError(res, billingScope, 'billing_client_lookup_failed')
      queryIds = [billingScope.billingClientId || wantedClientId]
    } else if (!isGlobalAdmin) {
      queryIds = ids.filter((clientId) => canViewLegalBillingForClient(req.clientScope, clientId))
      if (queryIds.length === 0) return res.status(403).json({ error: 'forbidden' })
    }

    let q = supabaseAdmin
      .from('clients')
      .select('id,name,plan_tier,billing_status,billing_interval,auto_renew,current_term_end,contract_end_at,subscription_status,cancel_at_term_end,access_override_mode,stripe_customer_id')
      .in('id', Array.from(new Set(queryIds)))
      .order('name', { ascending: true })

    const { data, error } = await q
    if (error) return res.status(500).json({ error: 'list_billing_summary_failed', detail: error.message })

    const items = (data || []).map((client) => ({
      id: client.id,
      name: client.name,
      plan_tier: client.plan_tier,
      billing_status: client.billing_status,
      billing_interval: client.billing_interval,
      auto_renew: client.auto_renew,
      current_term_end: client.current_term_end,
      contract_end_at: client.contract_end_at,
      subscription_status: client.subscription_status,
      cancel_at_term_end: client.cancel_at_term_end,
      access_override_mode: client.access_override_mode,
      has_stripe_customer: !!client.stripe_customer_id
    }))
    return res.json({ items })
  } catch (e) {
    return res.status(500).json({ error: 'server_error' })
  }
})

router.post('/clients/billing/portal-session', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'billing')
    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!hasClientWriteAccess(req, clientId)) return res.status(403).json({ error: 'forbidden' })

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,stripe_customer_id')
      .eq('id', clientId)
      .maybeSingle()
    if (clientErr) return res.status(500).json({ error: 'client_lookup_failed', detail: clientErr.message })
    if (!client) return res.status(404).json({ error: 'client_not_found' })

    const stripeCustomerId = String(client.stripe_customer_id || '').trim()
    if (!stripeCustomerId) return res.status(400).json({ error: 'missing_stripe_customer' })

    const stripe = require('../../clients/stripe')
    const returnParams = new URLSearchParams({
      client_id: clientId,
      tab
    })
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: buildClientDashboardReturnUrl(returnParams)
    })
    return res.json({ ok: true, url: session?.url || null })
  } catch (e) {
    return res.status(500).json({ error: 'create_portal_session_failed', detail: e?.message || 'create_portal_session_failed' })
  }
})

router.post('/clients/billing/additional-interviews/checkout-session', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const roleId = String(req.body?.role_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'billing')
    const embeddedCheckoutRequested = wantsEmbeddedCheckout(req.body?.embedded)
    const parsedQuantity = Number(req.body?.quantity)
    const quantity = Number.isInteger(parsedQuantity) ? parsedQuantity : NaN

    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!hasClientWriteAccess(req, clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!roleId) return res.status(400).json({ error: 'role_id_required' })
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'invalid_quantity' })
    }
    const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, clientId)
    if (!billingScope.ok) return respondWithBillingScopeError(res, billingScope, 'billing_client_lookup_failed')
    const billingClient = billingScope.billingClient || {}
    const billingClientId = billingScope.billingClientId || clientId

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title')
      .eq('id', roleId)
      .eq('client_id', clientId)
      .maybeSingle()
    if (roleErr) return res.status(500).json({ error: 'role_lookup_failed', detail: roleErr.message })
    if (!role) return res.status(404).json({ error: 'role_not_found' })

    const { data: planSettings, error: planSettingsErr } = await supabaseAdmin
      .from('client_plan_settings')
      .select('additional_interview_fee')
      .eq('client_id', billingClientId)
      .maybeSingle()
    if (planSettingsErr) return res.status(500).json({ error: 'plan_settings_lookup_failed', detail: planSettingsErr.message })

    const additionalInterviewFee = Number(planSettings?.additional_interview_fee)
    if (!Number.isFinite(additionalInterviewFee) || additionalInterviewFee <= 0) {
      return res.status(400).json({ error: 'invalid_additional_interview_fee' })
    }
    const additionalInterviewCents = Math.round(additionalInterviewFee * 100)
    if (!Number.isFinite(additionalInterviewCents) || additionalInterviewCents <= 0) {
      return res.status(400).json({ error: 'invalid_additional_interview_fee' })
    }

    const { data: pendingPurchase, error: pendingPurchaseErr } = await supabaseAdmin
      .from('role_interview_purchases')
      .insert({
        client_id: clientId,
        role_id: roleId,
        quantity,
        status: 'pending'
      })
      .select('id')
      .single()
    if (pendingPurchaseErr) {
      return res.status(500).json({ error: 'create_role_interview_purchase_failed', detail: pendingPurchaseErr.message })
    }

    const stripe = require('../../clients/stripe')

    let stripeCustomerId = String(billingClient.stripe_customer_id || '').trim()
    if (stripeCustomerId) {
      try {
        await stripe.customers.retrieve(stripeCustomerId)
      } catch (e) {
        const code = String(e?.code || '').toLowerCase()
        const message = String(e?.message || '').toLowerCase()
        if (code === 'resource_missing' || message.includes('no such customer')) {
          stripeCustomerId = ''
        } else {
          throw e
        }
      }
    }
    if (!stripeCustomerId) {
      const email = String(billingClient.email || '').trim()
      if (email) {
        const found = await stripe.customers.list({ email, limit: 1 })
        stripeCustomerId = String(found?.data?.[0]?.id || '').trim()
      }
      if (!stripeCustomerId) {
        const createdCustomer = await stripe.customers.create({
          name: billingClient.name || undefined,
          email: String(billingClient.email || '').trim() || undefined,
          metadata: {
            client_id: billingClientId,
            billing_client_id: billingClientId,
            scope_client_id: clientId
          }
        })
        stripeCustomerId = String(createdCustomer?.id || '').trim()
      }
      if (!stripeCustomerId) return res.status(500).json({ error: 'stripe_customer_create_failed' })

      if (stripeCustomerId !== String(billingClient.stripe_customer_id || '').trim()) {
        const { error: saveCustomerError } = await supabaseAdmin
          .from('clients')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', billingClientId)
        if (saveCustomerError) {
          return res.status(500).json({ error: 'client_update_failed', detail: saveCustomerError.message })
        }
      }
    }

    const sessionMetadata = {
      purchase_type: 'additional_interviews',
      role_interview_purchase_id: String(pendingPurchase.id || ''),
      client_id: clientId,
      role_id: roleId,
      quantity: String(quantity)
    }
    const successParams = new URLSearchParams({
      tab,
      intent: 'role_capacity',
      purchase: 'success',
      client_id: clientId,
      role_id: roleId
    })
    const cancelParams = new URLSearchParams({
      tab,
      intent: 'role_capacity',
      purchase: 'cancel',
      client_id: clientId,
      role_id: roleId
    })
    const checkoutBasePayload = {
      mode: 'payment',
      customer: stripeCustomerId || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: additionalInterviewCents,
          product_data: {
            name: 'Additional interviews'
          }
        },
        quantity
      }],
      allow_promotion_codes: true,
      metadata: sessionMetadata
    }

    let checkoutClientSecret = null
    let primaryCheckoutSession = null
    let hostedFallbackSession = null

    if (embeddedCheckoutRequested) {
      try {
        primaryCheckoutSession = await stripe.checkout.sessions.create({
          ...checkoutBasePayload,
          ui_mode: 'embedded',
          return_url: buildClientDashboardReturnUrl(successParams)
        })
        const resolvedClientSecret = String(primaryCheckoutSession?.client_secret || '').trim()
        if (resolvedClientSecret) {
          checkoutClientSecret = resolvedClientSecret
        } else {
          primaryCheckoutSession = null
        }
      } catch (embeddedErr) {
        console.error('create_additional_interviews_embedded_checkout_session_failed:', embeddedErr?.message || embeddedErr)
      }
    }

    if (!primaryCheckoutSession) {
      primaryCheckoutSession = await stripe.checkout.sessions.create({
        ...checkoutBasePayload,
        success_url: buildClientDashboardReturnUrl(successParams),
        cancel_url: buildClientDashboardReturnUrl(cancelParams)
      })
    } else {
      try {
        hostedFallbackSession = await stripe.checkout.sessions.create({
          ...checkoutBasePayload,
          success_url: buildClientDashboardReturnUrl(successParams),
          cancel_url: buildClientDashboardReturnUrl(cancelParams)
        })
      } catch (hostedFallbackErr) {
        console.error('create_additional_interviews_hosted_fallback_checkout_session_failed:', hostedFallbackErr?.message || hostedFallbackErr)
      }
    }

    const checkoutUrl = String(hostedFallbackSession?.url || primaryCheckoutSession?.url || '').trim() || null
    const checkoutSessionId = String(primaryCheckoutSession?.id || hostedFallbackSession?.id || '').trim() || null

    const { error: updatePurchaseErr } = await supabaseAdmin
      .from('role_interview_purchases')
      .update({
        stripe_checkout_session_id: checkoutSessionId
      })
      .eq('id', pendingPurchase.id)
    if (updatePurchaseErr) {
      return res.status(500).json({ error: 'update_role_interview_purchase_failed', detail: updatePurchaseErr.message })
    }

    return res.json({
      ok: true,
      url: checkoutUrl,
      role_interview_purchase_id: pendingPurchase.id,
      checkout_client_secret: checkoutClientSecret,
      embedded_checkout: !!checkoutClientSecret
    })
  } catch (e) {
    return res.status(500).json({ error: 'create_additional_interviews_checkout_session_failed', detail: e?.message || 'create_additional_interviews_checkout_session_failed' })
  }
})


module.exports = router;
