'use strict';

// Package listing, checkout status and purchase intent creation.

const express = require('express');
const {
  DUPLICATE_WINDOW_MS,
  INTENT_EXPIRATION_MS,
  RETAIL_CHECKOUT_STATUS_RATE_MAX,
  RETAIL_PURCHASE_INTENT_IP_RATE_MAX,
  RETAIL_PURCHASE_INTENT_RATE_MAX,
  buildAlphaScreenPackageSnapshot,
  buildPurchaseIntentResponse,
  cleanLookupId,
  duplicateSignupResponse,
  enforceRetailRateLimit,
  findSignupConflictByEmail,
  getRequestSubjectKey,
  listPublicAlphaScreenPackages,
  normalizePurchaseIntentInput,
  purchaseIntentPrepayColumns,
  resolvePublicCheckoutReturnState,
  supabaseAdmin,
  trimText,
  validatePurchaseIntentInput,
  validationError,
} = require('../../../services/alphaScreen/index');

const router = express.Router();

router.get('/packages', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  return res.json({
    packages: listPublicAlphaScreenPackages(),
    request_id: req.request_id || null
  })
})

router.get('/checkout-status', async (req, res) => {
  const request_id = req.request_id || null
  const sessionId = cleanLookupId(req.query?.session_id)
  const agreementId = cleanLookupId(req.query?.agreement_id)
  const fallbackClientId = cleanLookupId(req.query?.client_id)

  if (!sessionId && !agreementId && !fallbackClientId) {
    return res.status(400).json({
      error: 'checkout_lookup_required',
      code: 'checkout_lookup_required',
      detail: 'Checkout session, agreement, or client reference is required.',
      request_id
    })
  }

  const allowed = await enforceRetailRateLimit(req, res, {
    routeName: 'retail_checkout_status',
    subjectParts: ['checkout_status', sessionId || agreementId || fallbackClientId],
    maxCount: RETAIL_CHECKOUT_STATUS_RATE_MAX
  })
  if (!allowed) return

  try {
    const state = await resolvePublicCheckoutReturnState({
      sessionId,
      agreementId,
      fallbackClientId
    })

    return res.json({
      ok: true,
      status: state?.status || 'payment_pending',
      client_id: state?.client_id || null,
      password_setup_required: state?.password_setup_required === true,
      direct_setup_available: state?.direct_setup_available === true,
      set_password_url: state?.set_password_url || null,
      setup_email_sent: state?.setup_email_sent === true,
      request_id
    })
  } catch (e) {
    console.error('[alphascreen/checkout-status] unexpected:', e?.message || e)
    return res.status(500).json({
      error: 'checkout_status_failed',
      code: 'checkout_status_failed',
      detail: 'Checkout status could not be loaded.',
      request_id
    })
  }
})

router.post('/purchase-intents', async (req, res) => {
  const request_id = req.request_id || null
  try {
    const input = normalizePurchaseIntentInput(req.body || {})
    const validation = validatePurchaseIntentInput(input)
    if (!validation.ok) {
      return validationError(res, req, validation.code, validation.detail, validation.fields)
    }

    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_purchase_intent_create',
      subjectParts: ['purchase_intent', getRequestSubjectKey(req), input.buyer_email],
      maxCount: RETAIL_PURCHASE_INTENT_RATE_MAX,
      ipSafetyMax: RETAIL_PURCHASE_INTENT_IP_RATE_MAX,
      code: 'RETAIL_SIGNUP_RATE_LIMITED',
      detail: 'Too many signup attempts were made from this browser or network. Try again later.'
    })
    if (!allowed) return

    const packageSnapshot = buildAlphaScreenPackageSnapshot(input.selected_plan_key, input.selected_billing_cadence, {
      firstRolePrepaySelected: input.first_role_prepay_selected
    })
    if (!packageSnapshot) {
      return validationError(
        res,
        req,
        'package_snapshot_unavailable',
        'Package configuration is not available for this selection.',
        ['plan_key', 'billing_cadence']
      )
    }

    const duplicateCutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()
    const { data: existingIntent, error: duplicateErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,buyer_phone,email_verified_at,email_verified_address,email_verification_method,email_verification_version,phone_verified_at,phone_verified_destination_fingerprint,phone_verification_method,phone_verification_version,created_at')
      .eq('buyer_email', input.buyer_email)
      .eq('company_legal_name', input.company_legal_name)
      .eq('selected_plan_key', input.selected_plan_key)
      .eq('selected_billing_cadence', input.selected_billing_cadence)
      .eq('first_role_prepay_selected', input.first_role_prepay_selected === true)
      .in('status', ['pending'])
      .gte('created_at', duplicateCutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (duplicateErr) {
      console.error('[alphascreen/purchase-intents] duplicate_lookup_failed:', duplicateErr.message || duplicateErr)
      return res.status(503).json({
        error: 'purchase_intent_lookup_failed',
        code: 'PURCHASE_INTENT_LOOKUP_FAILED',
        request_id
      })
    }

    if (existingIntent?.id) {
      let reusableIntent = existingIntent
      if (trimText(existingIntent.buyer_phone, 40) !== input.buyer_phone) {
        const { data: updatedIntent, error: updateErr } = await supabaseAdmin
          .from('public_purchase_intents')
          .update({
            buyer_phone: input.buyer_phone,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingIntent.id)
          .eq('status', 'pending')
          .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,buyer_phone,email_verified_at,email_verified_address,email_verification_method,email_verification_version,phone_verified_at,phone_verified_destination_fingerprint,phone_verification_method,phone_verification_version,created_at')
          .maybeSingle()

        if (updateErr || !updatedIntent?.id) {
          console.error('[alphascreen/purchase-intents] duplicate_phone_sync_failed:', updateErr?.message || 'intent_not_pending')
          return res.status(409).json({
            error: 'purchase_intent_not_reusable',
            code: 'PURCHASE_INTENT_NOT_REUSABLE',
            detail: 'This signup request changed while it was being updated. Start again to continue safely.',
            request_id
          })
        }
        reusableIntent = updatedIntent
      }

      const body = buildPurchaseIntentResponse(reusableIntent, { duplicate: true })
      body.request_id = request_id
      return res.status(200).json(body)
    }

    const signupConflict = await findSignupConflictByEmail(input.buyer_email)
    if (signupConflict.error) {
      console.error('[alphascreen/purchase-intents] signup_conflict_lookup_failed:', signupConflict.error.message || signupConflict.error)
      return res.status(503).json({
        error: 'purchase_intent_lookup_failed',
        code: 'PURCHASE_INTENT_LOOKUP_FAILED',
        request_id
      })
    }
    if (signupConflict.conflict) {
      return duplicateSignupResponse(res, req, signupConflict.conflict.reason)
    }

    const nowIso = new Date().toISOString()
    const prepayColumns = purchaseIntentPrepayColumns(packageSnapshot)
    const insertPayload = {
      status: 'pending',
      selected_plan_key: input.selected_plan_key,
      selected_billing_cadence: input.selected_billing_cadence,
      package_snapshot: packageSnapshot,
      ...prepayColumns,
      company_legal_name: input.company_legal_name,
      company_dba: input.company_dba || null,
      buyer_first_name: input.buyer_first_name,
      buyer_last_name: input.buyer_last_name,
      buyer_email: input.buyer_email,
      buyer_phone: input.buyer_phone || null,
      buyer_title: input.buyer_title || null,
      source_path: input.source_path || null,
      agreement_id: null,
      stripe_checkout_session_id: null,
      client_id: null,
      expires_at: new Date(Date.now() + INTENT_EXPIRATION_MS).toISOString(),
      created_at: nowIso,
      updated_at: nowIso
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .insert(insertPayload)
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,buyer_phone,email_verified_at,email_verified_address,email_verification_method,email_verification_version,phone_verified_at,phone_verified_destination_fingerprint,phone_verification_method,phone_verification_version,created_at')
      .single()

    if (insertErr) {
      console.error('[alphascreen/purchase-intents] insert_failed:', insertErr.message || insertErr)
      return res.status(503).json({
        error: 'purchase_intent_create_failed',
        code: 'PURCHASE_INTENT_CREATE_FAILED',
        request_id
      })
    }

    const body = buildPurchaseIntentResponse(inserted, { duplicate: false })
    body.request_id = request_id
    return res.status(201).json(body)
  } catch (e) {
    console.error('[alphascreen/purchase-intents] unexpected:', e?.message || e)
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      request_id
    })
  }
})


module.exports = router;
