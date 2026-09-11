'use strict';

// Role purchase checkout, including the job description upload it accepts.
// Mounted at the application root, so the paths here are absolute.

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');
const { buildClientDashboardReturnUrl } = require('../../config/urlConfig');
const { generateRubricAndKBForRole } = require('../../services/generateRubric');
const { resolveBillingOwnerForScope } = require('../../services/clientBillingScope');
const { normalizeInterviewType } = require('../../services/interviewTypes');
const { finalizePrepaidRoleCredit, findUnusedFirstRolePrepayCredit } = require('../../services/rolePurchaseFinalizer');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const {
  hasClientWriteAccess,
  respondWithBillingScopeError,
  sanitizeClientDashboardTab,
  wantsEmbeddedCheckout,
} = require('../../services/clientScope/clientBilling');

const ROLE_CHECKOUT_JD_BUCKET = (process.env.SUPABASE_JOB_DESCRIPTIONS_BUCKET || process.env.SUPABASE_JD_BUCKET || 'job-descriptions').trim()
const roleCheckoutUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
})

const router = express.Router();

router.post('/clients/roles/checkout-session', requireAuth, withClientScope, roleCheckoutUpload.single('file'), async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const roleId = String(req.body?.role_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'roles')
    const embeddedCheckoutRequested = wantsEmbeddedCheckout(req.body?.embedded)
    const roleTitle = String(req.body?.role_title || '').trim()
    const interviewType = normalizeInterviewType(req.body?.interview_type)
    const jdFile = req.file || null

    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!hasClientWriteAccess(req, clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!roleTitle) return res.status(400).json({ error: 'role_title_required' })
    if (!interviewType) {
      return res.status(400).json({ error: 'invalid_interview_type' })
    }
    if (!jdFile) return res.status(400).json({ error: 'file_required' })

    const originalFilename = String(jdFile.originalname || '').trim()
    const ext = path.extname(originalFilename).toLowerCase()
    if (!['.pdf', '.docx'].includes(ext)) {
      return res.status(400).json({ error: 'invalid_file_type' })
    }
    if (!jdFile.buffer || !jdFile.buffer.length) {
      return res.status(400).json({ error: 'invalid_file' })
    }
    const rawName = path.basename(originalFilename, ext)
    const safeBase = rawName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || `jd-${Date.now()}`
    const safeFilename = `${safeBase}${ext}`
    const contentType =
      ext === '.pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

    const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, clientId)
    if (!billingScope.ok) return respondWithBillingScopeError(res, billingScope, 'billing_client_lookup_failed')
    const billingClientId = billingScope.billingClientId || clientId

    const { data: billingClient, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,name,email,billing_status,access_override_mode,stripe_customer_id')
      .eq('id', billingClientId)
      .maybeSingle()
    if (clientErr) return res.status(500).json({ error: 'client_lookup_failed', detail: clientErr.message })
    if (!billingClient) return res.status(404).json({ error: 'client_not_found' })

    const accessOverrideMode = String(billingClient.access_override_mode || '').toLowerCase()
    const billingStatus = String(billingClient.billing_status || '').toLowerCase()
    const allowedByBilling =
      accessOverrideMode === 'force_active' ||
      (accessOverrideMode !== 'force_inactive' && billingStatus === 'active')
    if (!allowedByBilling) return res.status(403).json({ error: 'client_inactive' })

    const { data: planSettings, error: planSettingsErr } = await supabaseAdmin
      .from('client_plan_settings')
      .select('plan_tier,billing_interval,per_role_fee')
      .eq('client_id', billingClientId)
      .maybeSingle()
    if (planSettingsErr) return res.status(500).json({ error: 'plan_settings_lookup_failed', detail: planSettingsErr.message })
    if (!planSettings) return res.status(400).json({ error: 'missing_plan_settings' })

    const perRoleFee = Number(planSettings.per_role_fee)
    if (!Number.isFinite(perRoleFee) || perRoleFee <= 0) {
      return res.status(400).json({ error: 'invalid_per_role_fee' })
    }
    const perRoleCents = Math.round(perRoleFee * 100)
    if (!Number.isFinite(perRoleCents) || perRoleCents <= 0) {
      return res.status(400).json({ error: 'invalid_per_role_fee' })
    }

    let prepayAttemptJdStoragePath = ''
    const unusedFirstRoleCredit = await findUnusedFirstRolePrepayCredit({
      db: supabaseAdmin,
      billingClientId
    })
    if (unusedFirstRoleCredit?.id) {
      const prepayUploadObjectKey = `pending/${clientId}/first-role-credit-${crypto.randomUUID()}/${safeFilename}`
      const prepayJdUpload = await supabaseAdmin.storage
        .from(ROLE_CHECKOUT_JD_BUCKET)
        .upload(prepayUploadObjectKey, jdFile.buffer, { contentType, upsert: true })
      if (prepayJdUpload.error) {
        return res.status(500).json({ error: 'prepaid_role_jd_upload_failed', detail: prepayJdUpload.error.message })
      }
      prepayAttemptJdStoragePath = `${ROLE_CHECKOUT_JD_BUCKET}/${prepayUploadObjectKey}`

      const prepaidFinalization = await finalizePrepaidRoleCredit({
        db: supabaseAdmin,
        billingClientId,
        clientId,
        roleTitle,
        interviewType,
        jdStoragePath: prepayAttemptJdStoragePath,
        generateRubricAndKBForRole,
        throwOnEnrichmentError: false,
        logger: console
      })
      if (prepaidFinalization.applied) {
        return res.json({
          ok: true,
          credit_applied: true,
          role_id: prepaidFinalization.role_id,
          message: 'First-role prepay credit applied.'
        })
      }
      console.warn('[role-checkout] first_role_prepay_credit_unavailable_after_lookup', {
        billing_client_id: billingClientId,
        client_id: clientId,
        status: prepaidFinalization.status || 'credit_not_available'
      })
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

    const { data: pendingRolePurchase, error: pendingRolePurchaseErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .insert({
        client_id: clientId,
        stripe_customer_id: stripeCustomerId || null,
        status: 'pending',
        role_title: roleTitle,
        interview_type: interviewType,
        plan_tier: String(planSettings.plan_tier || '').trim() || null,
        billing_interval: String(planSettings.billing_interval || '').trim() || null
      })
      .select('id')
      .single()
    if (pendingRolePurchaseErr) {
      return res.status(500).json({ error: 'create_pending_role_purchase_failed', detail: pendingRolePurchaseErr.message })
    }

    let pendingJdStoragePath = prepayAttemptJdStoragePath
    if (!pendingJdStoragePath) {
      const pendingJdObjectKey = `pending/${clientId}/${pendingRolePurchase.id}/${safeFilename}`
      const pendingJdUpload = await supabaseAdmin.storage
        .from(ROLE_CHECKOUT_JD_BUCKET)
        .upload(pendingJdObjectKey, jdFile.buffer, { contentType, upsert: true })
      if (pendingJdUpload.error) {
        return res.status(500).json({ error: 'pending_jd_upload_failed', detail: pendingJdUpload.error.message })
      }
      pendingJdStoragePath = `${ROLE_CHECKOUT_JD_BUCKET}/${pendingJdObjectKey}`
    }

    const { error: pendingRolePurchaseJdUpdateErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .update({
        jd_storage_path: pendingJdStoragePath
      })
      .eq('id', pendingRolePurchase.id)
    if (pendingRolePurchaseJdUpdateErr) {
      return res.status(500).json({ error: 'update_pending_role_purchase_failed', detail: pendingRolePurchaseJdUpdateErr.message })
    }

    const sessionMetadata = {
      source: 'client_role_purchase',
      client_id: clientId,
      pending_role_purchase_id: pendingRolePurchase.id,
      role_title: roleTitle,
      interview_type: interviewType,
      plan_tier: String(planSettings.plan_tier || ''),
      billing_interval: String(planSettings.billing_interval || '')
    }
    const rolePrice = await stripe.prices.create({
      currency: 'usd',
      unit_amount: perRoleCents,
      product_data: { name: 'Role creation fee' },
      metadata: sessionMetadata
    })

    const successParams = new URLSearchParams({
      role_checkout: 'success',
      client_id: String(clientId),
      tab
    })
    const cancelParams = new URLSearchParams({
      role_checkout: 'cancel',
      client_id: String(clientId),
      tab
    })
    if (roleId) {
      successParams.set('role_id', roleId)
      cancelParams.set('role_id', roleId)
    }
    const checkoutBasePayload = {
      mode: 'payment',
      customer: stripeCustomerId,
      line_items: [{ price: rolePrice.id, quantity: 1 }],
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
        console.error('create_role_embedded_checkout_session_failed:', embeddedErr?.message || embeddedErr)
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
        console.error('create_role_hosted_fallback_checkout_session_failed:', hostedFallbackErr?.message || hostedFallbackErr)
      }
    }

    const checkoutUrl = String(hostedFallbackSession?.url || primaryCheckoutSession?.url || '').trim() || null
    const checkoutSessionId = String(primaryCheckoutSession?.id || hostedFallbackSession?.id || '').trim() || null

    const { error: pendingRolePurchaseUpdateErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .update({
        stripe_checkout_session_id: checkoutSessionId,
        stripe_customer_id: stripeCustomerId || null
      })
      .eq('id', pendingRolePurchase.id)
    if (pendingRolePurchaseUpdateErr) {
      return res.status(500).json({ error: 'update_pending_role_purchase_failed', detail: pendingRolePurchaseUpdateErr.message })
    }

    return res.json({
      ok: true,
      url: checkoutUrl,
      session_id: checkoutSessionId,
      checkout_client_secret: checkoutClientSecret,
      embedded_checkout: !!checkoutClientSecret
    })
  } catch (e) {
    return res.status(500).json({ error: 'create_role_checkout_session_failed', detail: e?.message || 'create_role_checkout_session_failed' })
  }
})

module.exports = router;
