'use strict';

// The Stripe checkout return handler. One route, mounted at /checkout, that decides
// where to send the buyer once the session completes: it reconciles the session
// against the pending purchase, provisions the account where one is owed, and picks
// a redirect target per branch. Moved out of app.js unchanged.

const express = require('express');

const { supabaseAdmin } = require('../../clients/supabase');
const { ensureUserIdAndRecoveryLink } = require('../../services/users/userProvisioning');
const { resolvePublicCheckoutReturnState } = require('../../services/publicPurchaseActivation');
const {
  buildClientDashboardReturnUrl,
  buildClientPwResetUrl,
  buildPublicCheckoutSuccessUrl,
  buildPublicPwResetUrl,
} = require('../../config/urlConfig');

const router = express.Router();

router.get('/subscription-success', async (req, res) => {
  const makeAccountSuccessUrl = (clientId, tab) => {
    const params = new URLSearchParams({ checkout: 'success' })
    if (clientId) params.set('client_id', clientId)
    if (tab) params.set('tab', tab)
    return buildClientDashboardReturnUrl(params)
  }
  const makePublicCheckoutStatusUrl = (status, clientId = '', extra = {}) => {
    const params = { checkout: 'success', status: status || 'setup_pending' }
    if (clientId) params.client_id = clientId
    if (extra.session_id) params.session_id = extra.session_id
    if (extra.agreement_id) params.agreement_id = extra.agreement_id
    return buildPublicCheckoutSuccessUrl(params)
  }
  const request_id = req.request_id || null
  const fallbackClientId = String(req.query?.client_id || '').trim()
  const fallbackTab = String(req.query?.tab || '').trim().toLowerCase()
  const sessionId = String(req.query?.session_id || '').trim()
  const fallbackUrl = makeAccountSuccessUrl(fallbackClientId, fallbackTab)
  let parsedMetadataSource = ''
  if (!sessionId) {
    console.log('subscription_checkout_success_redirect:', {
      branch: 'missing_session_id',
      target: 'fallback_url'
    })
    return res.redirect(302, fallbackUrl)
  }

  try {
    const stripe = require('../../clients/stripe')
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] })
    const pickStripeId = (value) => {
      if (!value) return null
      if (typeof value === 'string') return value
      if (typeof value === 'object' && typeof value.id === 'string') return value.id
      return null
    }
    const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {}
    const metadataSource = String(metadata?.source || '').trim().toLowerCase()
    parsedMetadataSource = metadataSource
    const metadataClientId = String(metadata?.client_id || '').trim()
    const metadataAgreementId = String(metadata?.agreement_id || '').trim()
    const metadataPlanTier = String(metadata?.plan_tier || '').trim().toLowerCase()
    const metadataBillingInterval = String(metadata?.billing_interval || '').trim().toLowerCase()
    const clientId = metadataClientId || fallbackClientId
    const successUrl = makeAccountSuccessUrl(clientId, fallbackTab)
    const agreementStatusUrl = (status) => makePublicCheckoutStatusUrl(status, clientId, {
      session_id: sessionId,
      agreement_id: metadataAgreementId
    })
    const paymentStatus = String(session?.payment_status || '').toLowerCase()
    const subscriptionObj = session?.subscription && typeof session.subscription === 'object' ? session.subscription : null
    const subscriptionMetadata = subscriptionObj?.metadata && typeof subscriptionObj.metadata === 'object' ? subscriptionObj.metadata : {}
    const subscriptionStatus = String(subscriptionObj?.status || '').toLowerCase()
    const replacesStripeSubscriptionId = String(
      metadata?.replaces_stripe_subscription_id ||
      subscriptionMetadata?.replaces_stripe_subscription_id ||
      ''
    ).trim()

    console.log('subscription_checkout_success_entry:', {
      client_id: clientId || null,
      fallback_tab: fallbackTab || null,
      metadata_source: metadataSource || null,
      session_status: String(session?.status || '').toLowerCase() || null,
      session_payment_status: paymentStatus || null,
      subscription_status: subscriptionStatus || null
    })

    if (!['admin_subscription_checkout', 'agreement_checkout'].includes(metadataSource)) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'metadata_source_mismatch',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }
    if (String(session?.status || '').toLowerCase() !== 'complete') {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'session_incomplete',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('payment_pending') : successUrl)
    }
    if (paymentStatus && !['paid', 'no_payment_required'].includes(paymentStatus)) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'payment_not_paid',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('payment_pending') : successUrl)
    }
    if (subscriptionStatus && !['active', 'trialing'].includes(subscriptionStatus)) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'subscription_not_active',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('activation_pending') : successUrl)
    }

    if (metadataSource === 'agreement_checkout') {
      const returnState = await resolvePublicCheckoutReturnState({
        sessionId,
        fallbackClientId: clientId,
        agreementId: metadataAgreementId
      })
      console.log('subscription_checkout_success_redirect:', {
        branch: 'agreement_checkout_webhook_state',
        status: returnState?.status || 'setup_pending',
        target: 'public_checkout_status'
      })
      return res.redirect(302, agreementStatusUrl(returnState?.status || 'setup_pending'))
    }

    if (metadataSource === 'agreement_checkout' && metadataAgreementId) {
      try {
        await supabaseAdmin
          .from('membership_agreements')
          .update({
            checkout_status: 'paid',
            checkout_session_id: sessionId,
            checkout_paid_at: new Date().toISOString()
          })
          .eq('id', metadataAgreementId)
      } catch (agreementCheckoutUpdateErr) {
        console.error('subscription_checkout_success_agreement_checkout_state_update_failed:', agreementCheckoutUpdateErr?.message || agreementCheckoutUpdateErr)
      }
    }

    let client = null
    if (clientId) {
      const { data: clientRow, error: clientErr } = await supabaseAdmin
        .from('clients')
        .select('id,name,email,client_admin_name')
        .eq('id', clientId)
        .maybeSingle()
      if (clientErr) throw new Error(clientErr.message || 'client_lookup_failed')
      client = clientRow || null
    }
    console.log('subscription_checkout_success_client_lookup:', {
      client_id: clientId || null,
      found: !!client?.id,
      has_email: !!String(client?.email || '').trim()
    })
    if (!client?.id) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'client_not_found',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('setup_pending') : successUrl)
    }

    if (subscriptionObj && ['active', 'trialing'].includes(subscriptionStatus)) {
      try {
        const toIsoFromUnixSeconds = (value) => {
          const n = Number(value)
          if (!Number.isFinite(n) || n <= 0) return null
          return new Date(n * 1000).toISOString()
        }
        const normalizeStripeInterval = (value) => {
          const raw = String(value || '').trim().toLowerCase()
          if (raw === 'month') return 'monthly'
          if (raw === 'year') return 'annual'
          if (raw === 'monthly' || raw === 'annual') return raw
          return null
        }
        const cancelAtTermEnd = subscriptionObj?.cancel_at_period_end === true
        let autoRenewForClient = !cancelAtTermEnd
        if (metadataSource === 'agreement_checkout' && metadataAgreementId) {
          try {
            const { data: agreementRenewal, error: agreementRenewalErr } = await supabaseAdmin
              .from('membership_agreements')
              .select('auto_renew')
              .eq('id', metadataAgreementId)
              .maybeSingle()
            if (agreementRenewalErr) {
              console.error('subscription_checkout_success_agreement_auto_renew_lookup_failed:', {
                request_id,
                agreement_id: metadataAgreementId,
                error: agreementRenewalErr.message,
                code: agreementRenewalErr.code || null,
                hint: agreementRenewalErr.hint || null
              })
            } else if (typeof agreementRenewal?.auto_renew === 'boolean') {
              autoRenewForClient = agreementRenewal.auto_renew
            }
          } catch (agreementRenewalErr) {
            console.error('subscription_checkout_success_agreement_auto_renew_lookup_failed:', {
              request_id,
              agreement_id: metadataAgreementId,
              error: agreementRenewalErr?.message || agreementRenewalErr
            })
          }
        }
        const intervalRaw =
          subscriptionObj?.items?.data?.[0]?.price?.recurring?.interval ||
          subscriptionObj?.plan?.interval ||
          ''
        const clientBillingUpdates = {
          stripe_customer_id: pickStripeId(subscriptionObj?.customer) || pickStripeId(session?.customer) || null,
          stripe_subscription_id: pickStripeId(subscriptionObj?.id) || null,
          subscription_status: subscriptionStatus,
          current_term_end: toIsoFromUnixSeconds(
            subscriptionObj?.current_period_end ??
            subscriptionObj?.items?.data?.[0]?.current_period_end ??
            null
          ),
          cancel_at_term_end: cancelAtTermEnd,
          billing_interval: normalizeStripeInterval(intervalRaw) || normalizeStripeInterval(metadataBillingInterval),
          billing_status: 'active',
          auto_renew: autoRenewForClient,
          cancel_effective_at: null
        }
        if (['basic', 'pro', 'enterprise'].includes(metadataPlanTier)) {
          clientBillingUpdates.plan_tier = metadataPlanTier
        }
        const { error: clientBillingUpdateErr } = await supabaseAdmin
          .from('clients')
          .update(clientBillingUpdates)
          .eq('id', client.id)
        if (clientBillingUpdateErr) {
          console.error('subscription_checkout_success_client_billing_update_failed:', {
            request_id,
            client_id: client.id,
            session_id: sessionId,
            error: clientBillingUpdateErr.message,
            code: clientBillingUpdateErr.code || null,
            hint: clientBillingUpdateErr.hint || null
          })
        }
      } catch (clientBillingUpdateErr) {
        console.error('subscription_checkout_success_client_billing_update_failed:', {
          request_id,
          client_id: client.id,
          session_id: sessionId,
          error: clientBillingUpdateErr?.message || clientBillingUpdateErr
        })
      }
    }

    if (metadataSource === 'agreement_checkout' && metadataAgreementId && replacesStripeSubscriptionId) {
      const newSubscriptionId = pickStripeId(subscriptionObj?.id)
      const currentCustomerId = pickStripeId(subscriptionObj?.customer) || pickStripeId(session?.customer)
      try {
        if (!newSubscriptionId) throw new Error('replacement_new_subscription_missing')
        if (!['active', 'trialing'].includes(subscriptionStatus)) throw new Error('replacement_new_subscription_not_active')
        if (replacesStripeSubscriptionId === newSubscriptionId) throw new Error('replacement_subscription_matches_new_subscription')
        if (!currentCustomerId) throw new Error('replacement_customer_missing')

        const oldSubscription = await stripe.subscriptions.retrieve(replacesStripeSubscriptionId)
        const oldCustomerId = pickStripeId(oldSubscription?.customer)
        if (!oldCustomerId) throw new Error('replacement_old_customer_missing')
        if (oldCustomerId !== currentCustomerId) throw new Error('replacement_customer_mismatch')

        if (String(oldSubscription?.status || '').trim().toLowerCase() !== 'canceled') {
          await stripe.subscriptions.cancel(replacesStripeSubscriptionId, {
            invoice_now: false,
            prorate: false
          })
        }

        const { error: replacementUpdateErr } = await supabaseAdmin
          .from('membership_agreements')
          .update({
            replaced_stripe_subscription_canceled_at: new Date().toISOString(),
            replacement_error: null
          })
          .eq('id', metadataAgreementId)
        if (replacementUpdateErr) throw new Error(replacementUpdateErr.message || 'replacement_state_update_failed')
      } catch (replacementErr) {
        const replacementError = String(replacementErr?.message || replacementErr || 'replacement_cancel_failed').slice(0, 500)
        console.error('subscription_checkout_success_replacement_cancel_failed:', {
          request_id,
          agreement_id: metadataAgreementId,
          client_id: client.id,
          old_subscription_id: replacesStripeSubscriptionId,
          new_subscription_id: newSubscriptionId || null,
          error: replacementError
        })
        try {
          await supabaseAdmin
            .from('membership_agreements')
            .update({ replacement_error: replacementError })
            .eq('id', metadataAgreementId)
        } catch (_) {}
      }
    }

    const clientEmail = String(client.email || '').trim()
    if (!clientEmail) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'client_email_missing',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('setup_pending') : successUrl)
    }
    const clientEmailLower = clientEmail.toLowerCase()
    const membershipName = String(client.client_admin_name || client.name || clientEmail).trim() || clientEmail

    const upsertClientManagerMembership = async (targetUserId, opts = {}) => {
      const requireUserId = opts?.requireUserId === true
      const normalizedUserId = String(targetUserId || '').trim() || null
      if (requireUserId && !normalizedUserId) throw new Error('membership_user_id_required')
      const { data: existingRows, error: existingErr } = await supabaseAdmin
        .from('client_members')
        .select('client_id,user_id,email,name,role')
        .eq('client_id', client.id)
      if (existingErr) throw new Error(existingErr.message || 'membership_lookup_failed')

      const existingMembership = (existingRows || []).find((row) => {
        return String(row?.email || '').trim().toLowerCase() === clientEmailLower
      }) || null

      if (!existingMembership) {
        const insertPayload = {
          client_id: client.id,
          email: clientEmail,
          name: membershipName,
          role: 'manager'
        }
        if (normalizedUserId) insertPayload.user_id = normalizedUserId

        const { error: insertErr } = await supabaseAdmin
          .from('client_members')
          .insert(insertPayload)
        if (insertErr) throw new Error(insertErr.message || 'membership_insert_failed')
        return
      }

      const updatePayload = {}
      const existingRole = String(existingMembership.role || '').trim().toLowerCase()
      const existingName = String(existingMembership.name || '').trim()
      const existingUserId = String(existingMembership.user_id || '').trim()

      if (existingRole !== 'manager') updatePayload.role = 'manager'
      if (!existingName) updatePayload.name = membershipName
      if (normalizedUserId && existingUserId !== normalizedUserId) updatePayload.user_id = normalizedUserId

      if (!Object.keys(updatePayload).length) return

      const membershipEmail = String(existingMembership.email || '').trim() || clientEmail
      const { error: updateErr } = await supabaseAdmin
        .from('client_members')
        .update(updatePayload)
        .eq('client_id', client.id)
        .eq('email', membershipEmail)
      if (updateErr) throw new Error(updateErr.message || 'membership_update_failed')
    }

    const findAuthUserByClientEmail = async () => {
      try {
        const { data: authUsersData, error: authUsersError } = await supabaseAdmin.auth.admin.listUsers({ email: clientEmail })
        if (authUsersError) {
          console.error('subscription_checkout_list_users_failed:', authUsersError?.message || authUsersError)
          return null
        }
        return (authUsersData?.users || []).find((user) => {
          return String(user?.email || '').trim().toLowerCase() === clientEmailLower
        }) || null
      } catch (listUsersErr) {
        console.error('subscription_checkout_list_users_exception:', listUsersErr?.message || listUsersErr)
        return null
      }
    }

    const findAuthUserById = async (userId) => {
      const normalizedUserId = String(userId || '').trim()
      if (!normalizedUserId) return null
      try {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(normalizedUserId)
        if (error) {
          console.error('subscription_checkout_get_user_by_id_failed:', error?.message || error)
          return null
        }
        return data?.user || null
      } catch (getUserErr) {
        console.error('subscription_checkout_get_user_by_id_exception:', getUserErr?.message || getUserErr)
        return null
      }
    }

    const recoveryRedirectUrl = buildClientPwResetUrl({
      origin: 'client',
      checkout: 'success',
      client_id: client.id
    })

    let existingAuthUser = await findAuthUserByClientEmail()
    let authUserId = String(existingAuthUser?.id || '').trim() || null

    if (metadataSource === 'agreement_checkout' && !authUserId) {
      const ensured = await ensureUserIdAndRecoveryLink(clientEmail, recoveryRedirectUrl, {
        requireActionLink: false
      })
      authUserId = String(ensured?.userId || '').trim() || null
      existingAuthUser = await findAuthUserById(authUserId)
    }

    if (!existingAuthUser && authUserId) {
      existingAuthUser = await findAuthUserById(authUserId)
    }

    await upsertClientManagerMembership(authUserId, {
      requireUserId: metadataSource === 'agreement_checkout'
    })

    const hasSignedIn = !!String(existingAuthUser?.last_sign_in_at || '').trim()
    console.log('subscription_checkout_success_auth_user_lookup:', {
      matching_user_found: !!existingAuthUser,
      has_last_sign_in_at: hasSignedIn
    })
    if (existingAuthUser && hasSignedIn) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'existing_user_signed_in',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('ready') : successUrl)
    }

    const generateRecoveryActionLink = async () => {
      const link = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: clientEmail,
        options: { redirectTo: recoveryRedirectUrl }
      })
      return link?.data?.action_link || link?.data?.properties?.action_link || null
    }

    let recoveryActionLink = null
    let createUserAttempted = false
    let retryProducedActionLink = false
    try {
      recoveryActionLink = await generateRecoveryActionLink()
    } catch (recoveryErr) {
      console.error('subscription_checkout_generate_recovery_link_failed:', recoveryErr?.message || recoveryErr)
    }
    console.log('subscription_checkout_success_recovery_first_result:', {
      has_action_link: !!recoveryActionLink
    })

    if (!recoveryActionLink) {
      createUserAttempted = true
      try {
        const createdUser = await supabaseAdmin.auth.admin.createUser({
          email: clientEmail,
          email_confirm: true
        })
        const createdUserId = String(createdUser?.data?.user?.id || '').trim()
        if (createdUserId) authUserId = createdUserId
      } catch (createErr) {
        const msg = String(createErr?.message || '').toLowerCase()
        if (!msg.includes('already') && !msg.includes('exists')) {
          console.error('subscription_checkout_create_user_failed:', createErr?.message || createErr)
        }
      }
      try {
        recoveryActionLink = await generateRecoveryActionLink()
        retryProducedActionLink = !!recoveryActionLink
      } catch (recoveryRetryErr) {
        console.error('subscription_checkout_generate_recovery_link_retry_failed:', recoveryRetryErr?.message || recoveryRetryErr)
      }
    }

    if (!authUserId) {
      const refreshedAuthUser = await findAuthUserByClientEmail()
      if (refreshedAuthUser) {
        existingAuthUser = refreshedAuthUser
        authUserId = String(refreshedAuthUser.id || '').trim() || null
      }
    }

    if (!authUserId && metadataSource === 'agreement_checkout') {
      throw new Error('agreement_checkout_auth_user_missing_after_bootstrap')
    }

    if (!existingAuthUser && authUserId) {
      existingAuthUser = await findAuthUserById(authUserId)
    }

    await upsertClientManagerMembership(authUserId, {
      requireUserId: metadataSource === 'agreement_checkout'
    })

    console.log('subscription_checkout_success_create_user_attempt:', {
      attempted: createUserAttempted
    })
    if (createUserAttempted) {
      console.log('subscription_checkout_success_recovery_retry_result:', {
        has_action_link: retryProducedActionLink
      })
    }

    if (recoveryActionLink) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'recovery_action_link',
        target: 'recovery_action_link'
      })
      return res.redirect(302, recoveryActionLink)
    }

    if (metadataSource === 'agreement_checkout') {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'agreement_checkout_onboarding_pending_no_recovery_link',
        target: 'public_checkout_status'
      })
      return res.redirect(302, agreementStatusUrl('setup_pending'))
    }

    const pendingOnboardingUrl = buildPublicPwResetUrl({
      origin: 'client',
      checkout: 'success',
      client_id: client.id,
      onboarding: 'pending'
    })
    console.log('subscription_checkout_success_onboarding_pending_fallback:', {
      client_id: client.id,
      target: 'pending_onboarding_pwreset'
    })
    console.log('subscription_checkout_success_redirect:', {
      branch: 'onboarding_pending_no_recovery_link',
      target: 'pending_onboarding_pwreset'
    })
    return res.redirect(302, pendingOnboardingUrl)
  } catch (e) {
    console.error('subscription_checkout_success_handoff_failed:', e?.message || e)
    if (parsedMetadataSource === 'agreement_checkout') {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'agreement_checkout_handler_exception',
        target: 'public_checkout_status'
      })
      return res.redirect(302, makePublicCheckoutStatusUrl('setup_pending', fallbackClientId))
    }
    console.log('subscription_checkout_success_redirect:', {
      branch: 'handler_exception',
      target: 'fallback_url'
    })
    return res.redirect(302, fallbackUrl)
  }
})

module.exports = router;
