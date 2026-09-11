'use strict';

// Read-only audit views over processing runs, deliveries and agreements. Mounted on the admin router.

const express = require('express');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router = express.Router();

router.get('/audit/contract-processing-runs', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('contract_processing_runs')
    .select('id,trigger_source,started_at,completed_at,processed_ok,summary,error,request_id,triggered_by_email,created_at')
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) return res.status(500).json({ error: 'list_contract_processing_runs_failed', detail: error.message })
  return res.json({ items: data || [] })
})

router.get('/audit/email-delivery-events', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('email_delivery_events')
    .select('id,event_at,event_type,email,email_category,category,sg_event_id,sg_message_id,reason,status,response,attempt,is_time_sensitive,alert_sent_at,alert_error,sg_template_id,subject,from_email,created_at')
    .eq('is_problem', true)
    .order('event_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return res.status(500).json({ error: 'list_email_delivery_events_failed', detail: error.message })
  return res.json({ items: data || [] })
})

router.get('/audit/contract-cancellation-runs', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('contract_cancellation_runs')
    .select('id,client_id,client_name,triggered_by_email,started_at,completed_at,status,final_invoice_amount,stripe_invoice_id,stripe_subscription_id,note,request_id,error,created_at')
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) return res.status(500).json({ error: 'list_contract_cancellation_runs_failed', detail: error.message })
  return res.json({ items: data || [] })
})

router.get('/audit/billing-reconciliation', requireAuth, requireAdmin, async (_req, res) => {
  const nowMs = Date.now()
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,billing_status,manual_active_override,access_override_mode,contract_end_at,auto_renew,subscription_status,cancel_at_term_end,current_term_end')
  if (error) return res.status(500).json({ error: 'list_billing_reconciliation_failed', detail: error.message })

  const items = (data || []).map((client) => {
    const billingStatus = String(client?.billing_status || '').toLowerCase()
    const accessOverrideMode = String(client?.access_override_mode || 'inherit').toLowerCase()
    const subscriptionStatus = String(client?.subscription_status || '').toLowerCase()
    const liveSubscription = subscriptionStatus === 'active' || subscriptionStatus === 'trialing'
    const contractEndMs = client?.contract_end_at ? new Date(client.contract_end_at).getTime() : NaN

    let reason = null
    if (accessOverrideMode === 'force_active' && billingStatus !== 'active') {
      reason = 'force_active_on_inactive_account'
    } else if (accessOverrideMode === 'force_inactive' && billingStatus === 'active') {
      reason = 'force_inactive_on_active_account'
    } else if (accessOverrideMode === 'force_active' && Number.isFinite(contractEndMs) && contractEndMs < nowMs) {
      reason = 'force_active_on_expired_contract'
    } else if (billingStatus === 'inactive' && liveSubscription && client?.cancel_at_term_end !== true) {
      reason = 'inactive_without_stripe_cancel'
    } else if (billingStatus === 'active' && client?.manual_active_override !== true && !liveSubscription) {
      reason = 'active_without_live_subscription'
    } else if (client?.cancel_at_term_end === true && !liveSubscription) {
      reason = 'stripe_cancel_flag_without_live_subscription'
    } else if (client?.manual_active_override === true && Number.isFinite(contractEndMs) && contractEndMs < nowMs) {
      reason = 'manual_override_on_expired_contract'
    }

    if (!reason) return null
    return {
      id: client.id,
      name: client.name,
      billing_status: client.billing_status,
      manual_active_override: client.manual_active_override,
      access_override_mode: client.access_override_mode,
      contract_end_at: client.contract_end_at,
      auto_renew: client.auto_renew,
      subscription_status: client.subscription_status,
      cancel_at_term_end: client.cancel_at_term_end,
      current_term_end: client.current_term_end,
      reason
    }
  }).filter(Boolean)

  return res.json({ items })
})

router.get('/audit/agreements', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,client_id,client_legal_name,status,created_by_user_id,created_by_email,admin_email,sent_at,opened_at,signed_at,signer_ip,created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return res.status(500).json({ error: 'list_agreement_audit_failed', detail: error.message })

  const toTs = (value) => {
    const raw = String(value || '').trim()
    if (!raw) return 0
    const ts = new Date(raw).getTime()
    return Number.isFinite(ts) ? ts : 0
  }

  const items = []
  for (const row of data || []) {
    const base = {
      agreement_id: row?.id || null,
      client_id: row?.client_id || null,
      client_name: row?.client_legal_name || null,
      sent_by_user_id: row?.created_by_user_id || null,
      sent_by_email: row?.created_by_email || null,
      sent_to_email: row?.admin_email || null,
      signer_ip: row?.signer_ip || null,
      status: row?.status || null
    }

    if (row?.sent_at) {
      items.push({
        ...base,
        id: `${row.id}-sent`,
        event_type: 'agreement_sent',
        event_at: row.sent_at
      })
    }
    if (row?.opened_at) {
      items.push({
        ...base,
        id: `${row.id}-opened`,
        event_type: 'agreement_opened',
        event_at: row.opened_at
      })
    }
    if (row?.signed_at) {
      items.push({
        ...base,
        id: `${row.id}-signed`,
        event_type: 'agreement_signed',
        event_at: row.signed_at
      })
    }
  }

  items.sort((a, b) => toTs(b.event_at) - toTs(a.event_at))
  return res.json({ items })
})


module.exports = router;
