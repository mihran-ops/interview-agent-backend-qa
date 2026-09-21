'use strict';

// Checkout for a signed agreement.

const express = require('express');
const { requireAuth, withClientScope } = require('../../../middleware/auth');
const {
  appendQueryParam,
  buildAgreementInputFromRow,
  buildFirstRolePrepayCheckout,
  buildMembershipAgreementSignUrl,
  buildPublicAgreementCheckoutMetadata,
  createSubscriptionCheckoutSession,
  ensurePublicAgreementCheckoutClient,
  extractErrorMessage,
  hashToken,
  isExpired,
  isPublicPurchaseIntentAgreement,
  loadAgreementByTokenHash,
  loadPublicPurchaseIntentForAgreement,
  publicAgreementTokenRateLimit,
  readToken,
  requireParentAgreementClient,
  respondWithAgreementClientGuard,
  supabaseAdmin,
  validatePublicPurchaseIntentForCheckout,
  wantsEmbeddedCheckout,
} = require('../../../services/membershipAgreements/index');

const router = express.Router();

router.post('/checkout-session', publicAgreementTokenRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(400).json({
        error: 'token_required',
        code: 'token_required',
        detail: 'Signing token is required.',
        request_id
      });
    }

    const tokenHash = hashToken(token);
    const agreement = await loadAgreementByTokenHash(tokenHash);
    if (!agreement) {
      return res.status(404).json({
        error: 'token_invalid',
        code: 'token_invalid',
        detail: 'This signing link is invalid.',
        request_id
      });
    }

    const publicAgreement = isPublicPurchaseIntentAgreement(agreement);
    const embeddedCheckoutRequested = wantsEmbeddedCheckout(req.body?.embedded, !publicAgreement);
    if (String(agreement.status || '').trim().toLowerCase() !== 'signed' || agreement.is_current !== true) {
      return res.status(409).json({
        error: 'agreement_not_checkout_eligible',
        code: 'agreement_not_checkout_eligible',
        detail: 'This agreement is not eligible for checkout.',
        request_id
      });
    }
    if (String(agreement.checkout_status || '').trim().toLowerCase() === 'paid') {
      return res.status(409).json({
        error: 'agreement_checkout_already_paid',
        code: 'agreement_checkout_already_paid',
        detail: 'Checkout is already completed for this agreement.',
        request_id
      });
    }
    const explicitAgreementDeadline = String(agreement.agreement_expires_at || '').trim();
    if (explicitAgreementDeadline && isExpired(explicitAgreementDeadline)) {
      return res.status(410).json({
        error: 'agreement_expired',
        code: 'agreement_expired',
        detail: 'This agreement expired before payment. Request a newly dated agreement.',
        request_id
      });
    }

    const agreementInput = buildAgreementInputFromRow(agreement);
    const planTier = String(agreementInput.membership_tier || '').trim().toLowerCase();
    const billingInterval = String(agreementInput.billing_option || '').trim().toLowerCase();
    if (!['basic', 'pro', 'enterprise'].includes(planTier)) {
      return res.status(409).json({
        error: 'invalid_agreement_plan',
        code: 'invalid_agreement_plan',
        detail: 'Agreement plan tier is invalid for checkout.',
        request_id
      });
    }
    if (!['monthly', 'annual'].includes(billingInterval)) {
      return res.status(409).json({
        error: 'invalid_agreement_billing_interval',
        code: 'invalid_agreement_billing_interval',
        detail: 'Agreement billing interval is invalid for checkout.',
        request_id
      });
    }

    let purchaseIntent = null;
    let publicPackageSnapshot = null;
    let clientId = String(agreement.client_id || '').trim();
    if (publicAgreement) {
      purchaseIntent = await loadPublicPurchaseIntentForAgreement(agreement);
      const publicCheckout = validatePublicPurchaseIntentForCheckout({ agreement, agreementInput, intent: purchaseIntent });
      publicPackageSnapshot = publicCheckout.packageSnapshot;
      clientId = await ensurePublicAgreementCheckoutClient({
        agreement,
        agreementInput,
        intent: purchaseIntent,
        planTier: publicCheckout.planTier,
        billingInterval: publicCheckout.billingInterval
      });
    }

    if (!clientId) {
      return res.status(400).json({
        error: 'missing_client_id',
        code: 'missing_client_id',
        detail: 'Agreement is not linked to a client.',
        request_id
      });
    }
    const parentGuard = await requireParentAgreementClient(agreement, { route: 'membership_agreements_checkout_session', agreement_id: agreement.id });
    if (!parentGuard.ok) return respondWithAgreementClientGuard(res, parentGuard, request_id);

    const enterpriseFees = planTier === 'enterprise'
      ? {
          platform_fee: agreementInput.platform_fee,
          per_role_fee: agreementInput.per_role_fee,
          included_interviews_per_role: agreementInput.included_interviews_per_role,
          additional_interview_fee: agreementInput.additional_interview_fee
        }
      : null;

    if (
      planTier === 'enterprise' &&
      (
        !String(enterpriseFees?.platform_fee || '').trim() ||
        !String(enterpriseFees?.per_role_fee || '').trim() ||
        !String(enterpriseFees?.included_interviews_per_role || '').trim() ||
        !String(enterpriseFees?.additional_interview_fee || '').trim()
      )
    ) {
      return res.status(409).json({
        error: 'invalid_enterprise_checkout_fields',
        code: 'invalid_enterprise_checkout_fields',
        detail: 'Enterprise checkout values are missing from this agreement.',
        request_id
      });
    }

    const checkoutMetadata = publicAgreement
      ? buildPublicAgreementCheckoutMetadata({
          agreement,
          agreementInput,
          intent: purchaseIntent,
          packageSnapshot: publicPackageSnapshot
        })
      : {
          agreement_id: agreement.id
        };
    const firstRolePrepay = publicAgreement
      ? buildFirstRolePrepayCheckout(publicPackageSnapshot)
      : null;
    const idempotencyKey = publicAgreement
      ? `agreement_checkout:${agreement.id}:${planTier}:${billingInterval}`
      : '';
    const cancelUrl = publicAgreement
      ? appendQueryParam(buildMembershipAgreementSignUrl(token), 'checkout', 'cancel')
      : buildMembershipAgreementSignUrl(token);

    const {
      session,
      fallbackSession,
      checkoutClientSecret,
      replacesStripeSubscriptionId,
      replacementPolicy
    } = await createSubscriptionCheckoutSession({
      clientId,
      planTier,
      billingInterval,
      metadataSource: 'agreement_checkout',
      metadata: checkoutMetadata,
      firstRolePrepay,
      promotionCodeId: purchaseIntent?.promotion_code_id || '',
      enterpriseFees,
      embedded: embeddedCheckoutRequested,
      cancelUrl,
      idempotencyKey,
      checkoutExpiresAt: explicitAgreementDeadline || null,
      requestContext: {
        forwardedProto: req.headers?.['x-forwarded-proto'],
        forwardedHost: req.headers?.['x-forwarded-host'],
        protocol: req.protocol,
        host: req.get('host')
      }
    });

    const checkoutSessionId = String(session?.id || fallbackSession?.id || '').trim();
    const checkoutUrl = String(fallbackSession?.url || session?.url || '').trim();
    const resolvedCheckoutClientSecret = String(checkoutClientSecret || '').trim();
    if (!checkoutSessionId || (!checkoutUrl && !resolvedCheckoutClientSecret)) {
      return res.status(500).json({
        error: 'checkout_session_missing',
        code: 'checkout_session_missing',
        detail: 'Checkout session was created without a valid URL.',
        request_id
      });
    }

    const nowIso = new Date().toISOString();
    const checkoutUpdate = {
      checkout_status: 'pending_payment',
      checkout_session_id: checkoutSessionId,
      checkout_created_at: nowIso,
      updated_at: nowIso
    };
    if (replacesStripeSubscriptionId) {
      checkoutUpdate.replaces_stripe_subscription_id = replacesStripeSubscriptionId;
      checkoutUpdate.replacement_policy = replacementPolicy || 'immediate_cancel';
      checkoutUpdate.replacement_error = null;
    }
    const { error: checkoutStateErr } = await supabaseAdmin
      .from('membership_agreements')
      .update(checkoutUpdate)
      .eq('id', agreement.id)
      .eq('status', 'signed')
      .eq('is_current', true);

    if (checkoutStateErr) {
      console.error('[membership-agreements/checkout-session] checkout_state_update_failed', {
        request_id,
        agreement_id: agreement.id,
        error: checkoutStateErr.message,
        code: checkoutStateErr.code,
        hint: checkoutStateErr.hint
      });
      return res.status(500).json({
        error: 'checkout_state_update_failed',
        code: checkoutStateErr.code || 'checkout_state_update_failed',
        detail: checkoutStateErr.message,
        hint: checkoutStateErr.hint,
        request_id
      });
    }

    if (purchaseIntent?.id) {
      const { error: intentCheckoutErr } = await supabaseAdmin
        .from('public_purchase_intents')
        .update({
          status: 'checkout_pending',
          stripe_checkout_session_id: checkoutSessionId,
          client_id: clientId,
          updated_at: nowIso
        })
        .eq('id', purchaseIntent.id);

      if (intentCheckoutErr) {
        console.error('[membership-agreements/checkout-session] purchase_intent_checkout_update_failed', {
          request_id,
          agreement_id: agreement.id,
          purchase_intent_id: purchaseIntent.id,
          error: intentCheckoutErr.message,
          code: intentCheckoutErr.code,
          hint: intentCheckoutErr.hint
        });
        return res.status(500).json({
          error: 'purchase_intent_checkout_update_failed',
          code: intentCheckoutErr.code || 'purchase_intent_checkout_update_failed',
          detail: intentCheckoutErr.message,
          hint: intentCheckoutErr.hint,
          request_id
        });
      }
    }

    return res.json({
      ok: true,
      url: checkoutUrl || null,
      session_id: checkoutSessionId,
      checkout_client_secret: resolvedCheckoutClientSecret || null,
      embedded_checkout: !!resolvedCheckoutClientSecret,
      request_id
    });
  } catch (e) {
    return res.status(Number(e?.status) || 500).json({
      error: e?.code || 'create_subscription_checkout_failed',
      code: e?.code || 'create_subscription_checkout_failed',
      detail: extractErrorMessage(e?.message || '', 'Could not create checkout session.'),
      request_id
    });
  }
});


module.exports = router;
