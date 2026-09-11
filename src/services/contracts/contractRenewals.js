'use strict';

// Contract renewal processing, moved out of app.js unchanged. Two callers share it:
// the admin route and the internal cron route, which is why it is a service rather
// than living with either router.

const { supabaseAdmin } = require('../../clients/supabase');

function addMonthsToIso(isoString, monthsToAdd = 12) {
  const base = new Date(isoString)
  if (Number.isNaN(base.getTime())) return null
  const next = new Date(base.getTime())
  next.setUTCMonth(next.getUTCMonth() + monthsToAdd)
  return next.toISOString()
}

async function processContractRenewals(context = {}) {
  const triggerSource = String(context?.triggerSource || 'admin')
  const requestId = context?.requestId || null
  const triggeredByUserId = context?.triggeredByUserId || null
  const triggeredByEmail = context?.triggeredByEmail || null
  const now = new Date()
  const nowMs = now.getTime()
  const startedAt = now.toISOString()
  let runId = null

  try {
    const { data: startedRun, error: startedRunError } = await supabaseAdmin
      .from('contract_processing_runs')
      .insert({
        trigger_source: triggerSource,
        started_at: startedAt,
        request_id: requestId,
        triggered_by_user_id: triggeredByUserId,
        triggered_by_email: triggeredByEmail
      })
      .select('id')
      .maybeSingle()
    if (!startedRunError) {
      runId = startedRun?.id || null
    }
  } catch (_) {}

  try {
    let stripe = null
    try {
      const stripeKey = String(process.env.STRIPE_SECRET_KEY || '')
      if (stripeKey) {
        stripe = require('../../clients/stripe')
      }
    } catch (_) {}

    const { data: clients, error } = await supabaseAdmin
      .from('clients')
      .select('id,name,billing_status,manual_active_override,contract_start_at,contract_end_at,auto_renew,cancel_effective_at,stripe_subscription_id,subscription_status,cancel_at_term_end')

    if (error) {
      const e = new Error(error.message || 'process_contracts_failed')
      e.detail = error.message || 'process_contracts_failed'
      throw e
    }

    const summary = {
      scanned: (clients || []).length,
      due: 0,
      renewed: 0,
      deactivated: 0,
      skipped_manual_override: 0,
      skipped_no_action: 0,
      errors: 0
    }
    const items = []

    for (const client of (clients || [])) {
      const oldContractEnd = client?.contract_end_at || null
      if (!oldContractEnd) continue

      const oldEndDate = new Date(oldContractEnd)
      if (Number.isNaN(oldEndDate.getTime())) continue
      if (oldEndDate.getTime() > nowMs) continue

      summary.due += 1

      if (client?.manual_active_override === true) {
        summary.skipped_manual_override += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'skipped_manual_override',
          contract_end_at_before: oldContractEnd
        })
        continue
      }

      if (client?.auto_renew === true) {
        const newContractStart = oldEndDate.toISOString()
        const newContractEnd = addMonthsToIso(newContractStart, 12)
        if (!newContractEnd) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: 'invalid_contract_end_at'
          })
          continue
        }

        const { error: renewError } = await supabaseAdmin
          .from('clients')
          .update({
            contract_start_at: newContractStart,
            contract_end_at: newContractEnd
          })
          .eq('id', client.id)

        if (renewError) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: renewError.message || 'renew_update_failed'
          })
          continue
        }

        summary.renewed += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'renewed',
          contract_end_at_before: oldContractEnd,
          contract_end_at_after: newContractEnd
        })
        continue
      }

      const localSubStatus = String(client?.subscription_status || '').toLowerCase()
      const stripeAlignmentNeeded =
        !!client?.stripe_subscription_id &&
        (localSubStatus === 'active' || localSubStatus === 'trialing') &&
        client?.cancel_at_term_end !== true
      const alreadyInactiveProcessed =
        String(client?.billing_status || '').toLowerCase() === 'inactive' &&
        !!client?.cancel_effective_at

      if (alreadyInactiveProcessed && !stripeAlignmentNeeded) {
        summary.skipped_no_action += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'skipped_no_action',
          contract_end_at_before: oldContractEnd,
          detail: 'already_inactive'
        })
        continue
      }

      if (!alreadyInactiveProcessed) {
        const cancelEffectiveAt = oldEndDate.toISOString()
        const { error: deactivateError } = await supabaseAdmin
          .from('clients')
          .update({
            billing_status: 'inactive',
            cancel_effective_at: cancelEffectiveAt
          })
          .eq('id', client.id)

        if (deactivateError) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: deactivateError.message || 'deactivate_update_failed'
          })
          continue
        }
      }

      let stripeAlignmentError = null
      let stripeCancelAtTermEnd = false
      if (stripeAlignmentNeeded) {
        if (!stripe) {
          stripeAlignmentError = 'stripe_client_unavailable'
          summary.errors += 1
        } else {
          try {
            await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: true })
            const { error: localStripeFlagError } = await supabaseAdmin
              .from('clients')
              .update({ cancel_at_term_end: true })
              .eq('id', client.id)
            if (localStripeFlagError) {
              stripeAlignmentError = localStripeFlagError.message || 'cancel_at_term_end_update_failed'
              summary.errors += 1
            } else {
              stripeCancelAtTermEnd = true
            }
          } catch (e) {
            stripeAlignmentError = e?.message || 'stripe_cancel_at_period_end_failed'
            summary.errors += 1
          }
        }
      }

      if (alreadyInactiveProcessed) {
        const alignedItem = {
          id: client.id,
          name: client.name || null,
          action: 'aligned_stripe_cancel',
          contract_end_at_before: oldContractEnd
        }
        if (stripeAlignmentError) alignedItem.stripe_alignment_error = stripeAlignmentError
        if (stripeCancelAtTermEnd) alignedItem.stripe_cancel_at_term_end = true
        items.push(alignedItem)
        continue
      }

      summary.deactivated += 1
      const deactivatedItem = {
        id: client.id,
        name: client.name || null,
        action: 'deactivated',
        contract_end_at_before: oldContractEnd,
        billing_status_after: 'inactive'
      }
      if (stripeAlignmentError) deactivatedItem.stripe_alignment_error = stripeAlignmentError
      if (stripeCancelAtTermEnd) deactivatedItem.stripe_cancel_at_term_end = true
      items.push(deactivatedItem)
    }

    const result = { ok: true, summary, items }
    const completedAt = new Date().toISOString()
    try {
      if (runId) {
        await supabaseAdmin
          .from('contract_processing_runs')
          .update({
            completed_at: completedAt,
            processed_ok: true,
            summary,
            items
          })
          .eq('id', runId)
      } else {
        await supabaseAdmin
          .from('contract_processing_runs')
          .insert({
            trigger_source: triggerSource,
            started_at: startedAt,
            completed_at: completedAt,
            processed_ok: true,
            summary,
            items,
            request_id: requestId,
            triggered_by_user_id: triggeredByUserId,
            triggered_by_email: triggeredByEmail
          })
      }
    } catch (_) {}

    return result
  } catch (e) {
    const completedAt = new Date().toISOString()
    const detail = e?.detail || e?.message || 'process_contracts_failed'
    try {
      if (runId) {
        await supabaseAdmin
          .from('contract_processing_runs')
          .update({
            completed_at: completedAt,
            processed_ok: false,
            error: detail
          })
          .eq('id', runId)
      } else {
        await supabaseAdmin
          .from('contract_processing_runs')
          .insert({
            trigger_source: triggerSource,
            started_at: startedAt,
            completed_at: completedAt,
            processed_ok: false,
            error: detail,
            request_id: requestId,
            triggered_by_user_id: triggeredByUserId,
            triggered_by_email: triggeredByEmail
          })
      }
    } catch (_) {}
    throw e
  }
}

module.exports = { addMonthsToIso, processContractRenewals };
