'use strict';

// Client records: listing, creation, contract controls and deletion. Mounted on the admin router.

const express = require('express');
const { buildClientDashboardReturnUrl } = require('../../config/urlConfig');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const {
  applyAdminListRange,
  buildAdminClientHierarchyMaps,
  countClientDeleteBlockers,
  parseAdminListRange,
  rejectChildClientForAdminBilling,
  withAdminClientHierarchyMetadata,
} = require('../../services/admin/adminHelpers');
const { ensureUserIdAndInvite } = require('../../services/users/userProvisioning');

const router = express.Router();

// List all clients
router.get('/clients', requireAuth, requireAdmin, async (req, res) => {
  // Unpaginated by default so existing callers are unaffected; ?limit= and ?offset=
  // bound the response for callers that want it.
  const range = parseAdminListRange(req.query)
  if (range.invalid) return res.status(400).json({ error: `invalid_${range.invalid}` })
  const { data, error } = await applyAdminListRange(supabaseAdmin
    .from('clients')
    .select('id,name,email,client_admin_name,created_at,plan_tier,billing_status,manual_active_override,access_override_mode,candidate_assistance_contact,stripe_customer_id,stripe_subscription_id,subscription_status,current_term_end,cancel_at_term_end,billing_interval,contract_start_at,contract_end_at,auto_renew,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
    .order('created_at', { ascending: false }), range)
  if (error) return res.status(500).json({ error: 'list_clients_failed', detail: error.message })
  const items = data || []
  const hierarchyMaps = buildAdminClientHierarchyMaps(items)
  const clientIds = items.map((item) => item?.id).filter(Boolean)
  if (!clientIds.length) return res.json({ items })

  const { data: planSettingsRows, error: planSettingsError } = await supabaseAdmin
    .from('client_plan_settings')
    .select('client_id,plan_tier,billing_interval,platform_fee,per_role_fee,included_interviews_per_role,additional_interview_fee,updated_at')
    .in('client_id', clientIds)
    .order('updated_at', { ascending: false })
  if (planSettingsError) return res.status(500).json({ error: 'list_clients_failed', detail: planSettingsError.message })

  const planSettingsByClientId = {}
  for (const row of planSettingsRows || []) {
    const key = row?.client_id
    if (!key || planSettingsByClientId[key]) continue
    planSettingsByClientId[key] = row
  }

  const enrichedItems = items.map((item) => {
    const settings = planSettingsByClientId[item.id] || null
    return {
      ...withAdminClientHierarchyMetadata(item, hierarchyMaps),
      plan_settings_plan_tier: settings?.plan_tier || null,
      plan_settings_billing_interval: settings?.billing_interval || null,
      plan_settings_platform_fee: settings?.platform_fee ?? null,
      plan_settings_per_role_fee: settings?.per_role_fee ?? null,
      plan_settings_included_interviews_per_role: settings?.included_interviews_per_role ?? null,
      plan_settings_additional_interview_fee: settings?.additional_interview_fee ?? null
    }
  })
  res.json({ items: enrichedItems })
})

// Create client (writes email to satisfy NOT NULL)
router.post('/clients', requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim()
  const adminName  = (req.body?.admin_name  || '').trim()
  const adminEmail = (req.body?.admin_email || '').trim()
  const candidateAssistanceContact = (req.body?.candidate_assistance_contact || '').trim()
  const requestedInitialRole = String(req.body?.admin_role || '').trim().toLowerCase()
  const seededMemberRole = ['admin', 'tester', 'member', 'super_admin'].includes(requestedInitialRole)
    ? requestedInitialRole
    : (requestedInitialRole === 'manager' ? 'admin' : 'super_admin')
  const explicitClientEmail = (req.body?.email || '').trim()
  if (!name) return res.status(400).json({ error: 'name_required' })
  if (!candidateAssistanceContact) return res.status(400).json({ error: 'candidate_assistance_contact_required' })

  const emailForClient = explicitClientEmail || adminEmail
  if (!emailForClient) {
    return res.status(400).json({ error: 'email_required_for_client' })
  }

  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients')
    .insert({
      name,
      email: emailForClient,
      client_admin_name: adminName || null,
      candidate_assistance_contact: candidateAssistanceContact,
      plan_tier: null,
      billing_interval: null
    })
    .select('id,name,created_at')
    .single()
  if (cErr) {
    console.error('create_client_failed:', cErr.message)
    return res.status(500).json({ error: 'create_client_failed', detail: cErr.message, hint: cErr.hint })
  }

  // Optionally seed an admin member
  let seeded_member = null
  if (adminEmail) {
    const redirectTo = buildClientDashboardReturnUrl({ auth_callback: '1' })
    const { userId, actionLink, method } = await ensureUserIdAndInvite(adminEmail, redirectTo, { suppressInvite: true })

    if (!userId) {
      console.error('seed_member_no_user_id', { email: adminEmail, method })
      return res.json({ item: client, seeded_member: null, note: 'client_created_invite_failed' })
    }

    const payload = {
      client_id: client.id,
      email: adminEmail,
      name: adminName || adminEmail,
      role: seededMemberRole,
      user_id: userId
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('client_members')
      .insert(payload)
      .select('client_id,user_id,email,name,role,created_at')
      .single()

    if (insErr) {
      console.error('seed_member_insert_failed:', insErr.message)
    } else {
      seeded_member = { ...inserted, id: inserted.user_id || inserted.email }
    }
  }

  res.json({ item: client, seeded_member })
})

router.patch('/clients/:id/auto-renew', requireAuth, requireAdmin, async (req, res) => {
  const autoRenew = req.body?.auto_renew
  if (typeof autoRenew !== 'boolean') {
    return res.status(400).json({ error: 'invalid_auto_renew' })
  }
  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_auto_renew' })
  if (!parentGuard) return
  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,stripe_subscription_id,subscription_status,auto_renew,cancel_at_term_end,billing_interval')
    .eq('id', req.params.id)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'update_client_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })
  if (!client.stripe_subscription_id) return res.status(400).json({ error: 'missing_stripe_subscription' })
  const subscriptionStatus = String(client.subscription_status || '').toLowerCase()
  if (subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing') {
    return res.status(400).json({ error: 'subscription_not_mutable' })
  }

  const billingInterval = String(client.billing_interval || '').toLowerCase()
  const isMonthly = billingInterval === 'monthly'
  const isAnnual = billingInterval === 'annual'
  if (isAnnual || !isMonthly) {
    try {
      const stripe = require('../../clients/stripe')
      await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: autoRenew !== true })
    } catch (e) {
      return res.status(500).json({ error: 'update_client_failed', detail: e?.message || 'stripe_update_failed' })
    }
  }

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({
      auto_renew: autoRenew,
      cancel_at_term_end: isMonthly ? false : (autoRenew ? false : true)
    })
    .eq('id', req.params.id)
    .select('id,auto_renew,cancel_at_term_end')
    .maybeSingle()
  if (error) return res.status(500).json({ error: 'update_client_failed', detail: error.message })
  return res.json({ ok: true, item: data || null })
})

router.patch('/clients/:id/access-override', requireAuth, requireAdmin, async (req, res) => {
  const accessOverrideMode = String(req.body?.access_override_mode || '').trim().toLowerCase()
  if (accessOverrideMode !== 'inherit' && accessOverrideMode !== 'force_active' && accessOverrideMode !== 'force_inactive') {
    return res.status(400).json({ error: 'invalid_access_override_mode' })
  }

  const { data: existingClient, error: existingClientError } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('id', req.params.id)
    .maybeSingle()
  if (existingClientError) return res.status(500).json({ error: 'update_client_failed', detail: existingClientError.message })
  if (!existingClient) return res.status(404).json({ error: 'client_not_found' })

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({ access_override_mode: accessOverrideMode })
    .eq('id', req.params.id)
    .select('id,access_override_mode')
    .maybeSingle()
  if (error) return res.status(500).json({ error: 'update_client_failed', detail: error.message })
  return res.json({ ok: true, item: data || null })
})

router.post('/clients/:id/cancel-contract', requireAuth, requireAdmin, async (req, res) => {
  const requestId = req.request_id || null
  const clientId = req.params?.id
  const note = String(req.body?.note || '').trim() || null
  const rawFinalInvoiceAmount = req.body?.final_invoice_amount
  const parsedFinalInvoiceAmount = Number(rawFinalInvoiceAmount)
  const finalInvoiceAmount = Number.isFinite(parsedFinalInvoiceAmount) && parsedFinalInvoiceAmount > 0
    ? parsedFinalInvoiceAmount
    : null
  const nowIso = new Date().toISOString()
  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_cancel_contract' })
  if (!parentGuard) return

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,stripe_customer_id,stripe_subscription_id,subscription_status,billing_status,auto_renew,cancel_at_term_end,cancel_effective_at')
    .eq('id', clientId)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'cancel_contract_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })
  if (!client.stripe_subscription_id) return res.status(400).json({ error: 'missing_stripe_subscription' })
  const subscriptionStatus = String(client.subscription_status || '').toLowerCase()
  if (subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing') {
    return res.status(400).json({ error: 'subscription_not_cancelable' })
  }

  const { data: startedRun, error: startedRunError } = await supabaseAdmin
    .from('contract_cancellation_runs')
    .insert({
      client_id: client.id,
      client_name: client.name || null,
      triggered_by_user_id: req.user?.id || null,
      triggered_by_email: req.user?.email || null,
      started_at: nowIso,
      status: 'started',
      final_invoice_amount: finalInvoiceAmount,
      stripe_subscription_id: client.stripe_subscription_id,
      note,
      request_id: requestId
    })
    .select('id')
    .maybeSingle()
  if (startedRunError || !startedRun?.id) {
    return res.status(500).json({ error: 'cancel_contract_failed', detail: startedRunError?.message || 'audit_start_failed' })
  }
  const runId = startedRun.id

  const completeRunWithFailure = async (status, detail, extra = {}) => {
    try {
      await supabaseAdmin
        .from('contract_cancellation_runs')
        .update({
          completed_at: new Date().toISOString(),
          status,
          error: detail,
          ...extra
        })
        .eq('id', runId)
    } catch (_) {}
  }

  try {
    const stripe = require('../../clients/stripe')
    let stripeInvoiceId = null

    if (finalInvoiceAmount && finalInvoiceAmount > 0) {
      try {
        let stripeCustomerId = client.stripe_customer_id || null
        if (!stripeCustomerId) {
          const sub = await stripe.subscriptions.retrieve(client.stripe_subscription_id)
          stripeCustomerId = sub?.customer || null
        }
        if (!stripeCustomerId) throw new Error('missing_stripe_customer')

        const amountCents = Math.round(finalInvoiceAmount * 100)
        const createdInvoice = await stripe.invoices.create({
          customer: stripeCustomerId,
          collection_method: 'send_invoice',
          days_until_due: 0,
          auto_advance: false,
          description: 'Final contract cancellation invoice'
        })
        await stripe.invoiceItems.create({
          customer: stripeCustomerId,
          invoice: createdInvoice.id,
          amount: amountCents,
          currency: 'usd',
          description: 'Final contract cancellation invoice'
        })
        await stripe.invoices.finalizeInvoice(createdInvoice.id)
        const sentInvoice = await stripe.invoices.sendInvoice(createdInvoice.id)
        stripeInvoiceId = sentInvoice?.id || createdInvoice?.id || null
      } catch (e) {
        const detail = e?.message || 'invoice_creation_failed'
        await completeRunWithFailure('invoice_failed', detail)
        return res.status(500).json({ error: 'cancel_contract_failed', detail })
      }
    }

    try {
      await stripe.subscriptions.cancel(client.stripe_subscription_id)
    } catch (e) {
      const detail = e?.message || 'stripe_cancel_failed'
      await completeRunWithFailure('stripe_cancel_failed', detail, { stripe_invoice_id: stripeInvoiceId })
      return res.status(500).json({ error: 'cancel_contract_failed', detail })
    }

    const cancelEffectiveAt = new Date().toISOString()
    const { data: updatedClient, error: updateError } = await supabaseAdmin
      .from('clients')
      .update({
        billing_status: 'inactive',
        auto_renew: false,
        cancel_at_term_end: false,
        cancel_effective_at: cancelEffectiveAt
      })
      .eq('id', client.id)
      .select('id,billing_status,auto_renew,cancel_at_term_end,cancel_effective_at')
      .maybeSingle()
    if (updateError || !updatedClient) {
      const detail = updateError?.message || 'local_update_failed'
      await completeRunWithFailure('local_update_failed', detail, { stripe_invoice_id: stripeInvoiceId })
      return res.status(500).json({ error: 'cancel_contract_failed', detail })
    }

    try {
      await supabaseAdmin
        .from('contract_cancellation_runs')
        .update({
          completed_at: new Date().toISOString(),
          status: 'completed',
          stripe_invoice_id: stripeInvoiceId,
          error: null
        })
        .eq('id', runId)
    } catch (_) {}

    return res.json({ ok: true, item: updatedClient })
  } catch (e) {
    const detail = e?.message || 'cancel_contract_failed'
    await completeRunWithFailure('failed', detail)
    return res.status(500).json({ error: 'cancel_contract_failed', detail })
  }
})

// Delete client
router.delete('/clients/:id', requireAuth, requireAdmin, async (req, res) => {
  const { blockers, warnings, checkErrors } = await countClientDeleteBlockers(req.params.id)
  if (checkErrors.length > 0) {
    return res.status(500).json({
      error: 'Failed to verify client delete blockers',
      code: 'CLIENT_DELETE_CHECK_FAILED',
      detail: 'One or more related-record checks could not be completed.',
      hint: 'Client was not deleted because related-record checks could not be completed safely.',
      checks: checkErrors
    })
  }

  if (Object.keys(blockers).length > 0) {
    const body = {
      error: 'Cannot delete client with related records',
      code: 'CLIENT_DELETE_BLOCKED',
      detail: 'Delete blocked because this client has related records.',
      hint: 'Remove or reassign related records before deleting this client.',
      blockers
    }
    if (warnings.length) body.warnings = warnings
    return res.status(409).json(body)
  }

  const { error } = await supabaseAdmin.from('clients').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: 'delete_client_failed', detail: error.message })
  res.json({ ok: true })
})


module.exports = router;
