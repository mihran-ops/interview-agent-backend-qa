'use strict';

// Automation rule administration and the overview that summarises it. Mounted on the admin router.

const express = require('express');
const { normalizeCriteriaConfig, stableStringify } = require('../../services/candidateAutomationEvaluator');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { cleanAdminUserEmail, normalizeAdminJsonObject, sendAdminError, trimNullableString } = require('../../services/admin/adminHelpers');
const {
  asJsonObject,
  automationRuleStatus,
  automationSchedulerSecretConfigured,
  automationSchedulerSendEnabled,
  collectUniqueIds,
  countRowsByStatus,
  deriveAutomationApprovalStatus,
  loadAutomationLookupMap,
  maskEmail,
  resolveAdminAutomationClientIds,
  sanitizeAutomationSchedulingUrl,
  summarizeAutomationCadence,
  summarizeAutomationRecipients,
  summarizeKeyValues,
} = require('../../services/admin/automationPresentation');

const router = express.Router();

async function loadAdminAutomationRule(ruleId) {
  const id = trimNullableString(ruleId)
  if (!id) return null
  const { data, error } = await supabaseAdmin
    .from('automation_rules')
    .select('id,name,client_id,role_id,enabled,mode,criteria_config,action_config,digest_config,rule_version,archived_at,created_at,updated_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function updateAdminAutomationRule(req, res, ruleId, updates, successCode = 'ok') {
  const request_id = req.request_id || null
  try {
    const rule = await loadAdminAutomationRule(ruleId)
    if (!rule) {
      return sendAdminError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      })
    }

    const payload = {
      ...updates,
      updated_by_user_id: req.user?.id || null,
      updated_by_email: cleanAdminUserEmail(req),
      updated_at: new Date().toISOString()
    }

    const { data, error } = await supabaseAdmin
      .from('automation_rules')
      .update(payload)
      .eq('id', rule.id)
      .select('id,name,client_id,role_id,enabled,mode,criteria_config,action_config,digest_config,rule_version,archived_at,created_at,updated_at')
      .maybeSingle()

    if (error) {
      return sendAdminError(res, 500, {
        error: 'automation_rule_update_failed',
        code: 'automation_rule_update_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      })
    }
    if (!data) {
      return sendAdminError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      })
    }

    return res.json({ ok: true, code: successCode, item: data, request_id })
  } catch (e) {
    console.error('[admin/automation/rules/update] unexpected', { request_id, error: e?.message || e })
    return sendAdminError(res, e?.status || 500, {
      error: e?.code || 'automation_rule_update_failed',
      code: e?.code || 'automation_rule_update_failed',
      detail: e?.message || null,
      request_id
    })
  }
}

// Read-only platform automation visibility. Do not add send/approve/reject controls here.
router.get('/automation/overview', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const scopeResult = await resolveAdminAutomationClientIds(req, request_id)
    if (!scopeResult.ok) return res.status(scopeResult.status).json(scopeResult.body)
    const scopedClientIds = Array.isArray(scopeResult.clientIds) ? scopeResult.clientIds : null
    const ruleStatusFilter = trimNullableString(req.query?.rule_status) || 'active'
    const itemStatusFilter = trimNullableString(req.query?.status)

    if (ruleStatusFilter && !['active', 'paused', 'archived', 'all'].includes(ruleStatusFilter)) {
      return sendAdminError(res, 400, {
        error: 'invalid_rule_status',
        code: 'invalid_rule_status',
        detail: 'rule_status must be active, paused, archived, or all.',
        request_id
      })
    }

    let rulesQuery = supabaseAdmin
      .from('automation_rules')
      .select('id,name,client_id,role_id,enabled,mode,criteria_config,action_config,digest_config,rule_version,archived_at,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(500)
    let actionsQuery = supabaseAdmin
      .from('automation_actions')
      .select('id,evaluation_id,rule_id,rule_version,client_id,role_id,candidate_id,report_id,interview_id,action_type,state,approved_by_email,approved_at,rejected_at,canceled_at,sent_at,failed_at,last_error,send_attempt_count,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(500)
    let digestsQuery = supabaseAdmin
      .from('automation_digest_deliveries')
      .select('id,client_id,role_id,recipient_email,recipient_email_domain,digest_type,delivery_date,timezone,send_time_local,status,action_count,sent_at,failed_at,last_error,created_by_email,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(250)
    let eventsQuery = supabaseAdmin
      .from('automation_action_events')
      .select('id,action_id,client_id,event_type,from_state,to_state,actor_type,actor_email,created_at')
      .order('created_at', { ascending: false })
      .limit(500)

    if (scopedClientIds) {
      if (scopedClientIds.length === 0) {
        return res.json({
          ok: true,
          overview: {
            total_rules: 0,
            enabled_rules: 0,
            disabled_rules: 0,
            pending_approval_count: 0,
            recent_sent_action_count: 0,
            recent_rejected_action_count: 0,
            recent_failed_action_count: 0,
            recent_digest_delivery_count: 0,
            action_state_counts: {},
            digest_status_counts: {},
            scheduler_send_enabled: automationSchedulerSendEnabled(),
            scheduler_secret_configured: automationSchedulerSecretConfigured(),
            scheduler_send_mode: automationSchedulerSendEnabled() ? 'send_enabled' : 'dry_run_guarded',
            digest_frequencies: ['daily', 'weekdays', 'weekly']
          },
          rules: [],
          actions: [],
          digests: [],
          request_id
        })
      }
      rulesQuery = rulesQuery.in('client_id', scopedClientIds)
      actionsQuery = actionsQuery.in('client_id', scopedClientIds)
      digestsQuery = digestsQuery.in('client_id', scopedClientIds)
      eventsQuery = eventsQuery.in('client_id', scopedClientIds)
    }
    if (itemStatusFilter && itemStatusFilter !== 'all') {
      actionsQuery = actionsQuery.eq('state', itemStatusFilter)
      digestsQuery = digestsQuery.eq('status', itemStatusFilter)
    }

    const [
      rulesResult,
      actionsResult,
      digestsResult,
      eventsResult
    ] = await Promise.all([
      rulesQuery,
      actionsQuery,
      digestsQuery,
      eventsQuery
    ])

    const firstError = rulesResult.error || actionsResult.error || digestsResult.error || eventsResult.error
    if (firstError) {
      return sendAdminError(res, 500, {
        error: 'admin_automation_overview_failed',
        code: 'ADMIN_AUTOMATION_OVERVIEW_FAILED',
        detail: firstError.message,
        hint: firstError.hint || null,
        request_id
      })
    }

    const allRules = rulesResult.data || []
    const rules = allRules.filter((rule) => {
      const status = automationRuleStatus(rule)
      if (ruleStatusFilter === 'all') return true
      return status === ruleStatusFilter
    })
    const actions = actionsResult.data || []
    const digests = digestsResult.data || []
    const events = eventsResult.data || []

    const clientIds = collectUniqueIds([...rules, ...actions, ...digests, ...events], ['client_id'])
    const roleIds = collectUniqueIds([...rules, ...actions, ...digests], ['role_id'])
    const candidateIds = collectUniqueIds(actions, ['candidate_id'])

    const [clientMap, roleMap, candidateMap] = await Promise.all([
      loadAutomationLookupMap('clients', 'id,name,parent_client_id,entity_label,archived_at', clientIds),
      loadAutomationLookupMap('roles', 'id,title,client_id,status', roleIds),
      loadAutomationLookupMap('candidates', 'id,name,email,client_id', candidateIds)
    ])

    const latestEventByActionId = {}
    for (const event of events) {
      const actionId = trimNullableString(event?.action_id)
      if (!actionId || latestEventByActionId[actionId]) continue
      latestEventByActionId[actionId] = event
    }

    const activeRules = allRules.filter((rule) => !trimNullableString(rule.archived_at))
    const digestStatusCounts = countRowsByStatus(digests, 'status')
    const actionStateCounts = countRowsByStatus(actions, 'state')
    const overview = {
      total_rules: activeRules.length,
      enabled_rules: activeRules.filter((rule) => rule.enabled === true).length,
      disabled_rules: activeRules.filter((rule) => rule.enabled !== true).length,
      pending_approval_count: actions.filter((action) => String(action.state || '').toLowerCase() === 'pending_approval').length,
      recent_sent_action_count: actions.filter((action) => ['sent', 'delivered'].includes(String(action.state || '').toLowerCase())).length,
      recent_rejected_action_count: actions.filter((action) => String(action.state || '').toLowerCase() === 'rejected' || action.rejected_at).length,
      recent_failed_action_count: actions.filter((action) => String(action.state || '').toLowerCase() === 'failed' || action.failed_at).length,
      recent_digest_delivery_count: digests.length,
      action_state_counts: actionStateCounts,
      digest_status_counts: digestStatusCounts,
      scheduler_send_enabled: automationSchedulerSendEnabled(),
      scheduler_secret_configured: automationSchedulerSecretConfigured(),
      scheduler_send_mode: automationSchedulerSendEnabled() ? 'send_enabled' : 'dry_run_guarded',
      digest_frequencies: ['daily', 'weekdays', 'weekly']
    }

    const safeRules = rules.map((rule) => {
      const client = clientMap[rule.client_id] || null
      const role = roleMap[rule.role_id] || null
      const actionConfig = asJsonObject(rule.action_config)
      const schedulingUrl = sanitizeAutomationSchedulingUrl(actionConfig.second_round_scheduling_url || actionConfig.scheduling_url)
      return {
        id: rule.id,
        name: trimNullableString(rule.name) || 'Automation rule',
        client_id: rule.client_id || null,
        client_name: client?.name || rule.client_id || null,
        entity_id: rule.client_id || null,
        entity_name: client?.name || rule.client_id || null,
        entity_parent_client_id: client?.parent_client_id || null,
        entity_label: client?.entity_label || null,
        role_id: rule.role_id || null,
        role_title: role?.title || rule.role_id || null,
        enabled: rule.enabled === true,
        archived_at: rule.archived_at || null,
        status: automationRuleStatus(rule),
        mode: rule.mode || null,
        criteria_summary: summarizeKeyValues(rule.criteria_config),
        recipients_summary: summarizeAutomationRecipients(rule),
        cadence_summary: summarizeAutomationCadence(rule),
        scheduling_url_configured: Boolean(schedulingUrl),
        scheduling_url_display: schedulingUrl || null,
        criteria_config: asJsonObject(rule.criteria_config),
        rule_version: rule.rule_version || null,
        created_at: rule.created_at || null,
        updated_at: rule.updated_at || null,
      }
    })

    const safeActions = actions.map((action) => {
      const client = clientMap[action.client_id] || null
      const role = roleMap[action.role_id] || null
      const candidate = candidateMap[action.candidate_id] || null
      const event = latestEventByActionId[action.id] || null
      const eventSummary = event
        ? `${event.event_type || 'event'}${event.to_state ? ` to ${event.to_state}` : ''}`
        : 'No recent event'
      return {
        id: action.id,
        client_id: action.client_id || null,
        client_name: client?.name || action.client_id || null,
        role_id: action.role_id || null,
        role_title: role?.title || action.role_id || null,
        candidate_id: action.candidate_id || null,
        candidate_name: candidate?.name || maskEmail(candidate?.email) || action.candidate_id || null,
        action_type: action.action_type || null,
        state: action.state || null,
        approval_status: deriveAutomationApprovalStatus(action),
        send_attempt_count: action.send_attempt_count || 0,
        last_error: action.last_error ? 'Error recorded' : null,
        event_summary: eventSummary,
        event_at: event?.created_at || null,
        created_at: action.created_at || null,
        updated_at: action.updated_at || null,
      }
    })

    const safeDigests = digests.map((digest) => {
      const client = clientMap[digest.client_id] || null
      const role = roleMap[digest.role_id] || null
      return {
        id: digest.id,
        client_id: digest.client_id || null,
        client_name: client?.name || digest.client_id || null,
        role_id: digest.role_id || null,
        role_title: role?.title || digest.role_id || null,
        recipient_summary: maskEmail(digest.recipient_email) || digest.recipient_email_domain || 'Configured recipient',
        recipient_domain: digest.recipient_email_domain || null,
        digest_type: digest.digest_type || null,
        delivery_date: digest.delivery_date || null,
        timezone: digest.timezone || null,
        send_time_local: digest.send_time_local || null,
        status: digest.status || null,
        pending_count: digest.action_count || 0,
        sent_at: digest.sent_at || null,
        failed_at: digest.failed_at || null,
        last_error: digest.last_error ? 'Error recorded' : null,
        created_at: digest.created_at || null,
        updated_at: digest.updated_at || null,
      }
    })

    return res.json({
      ok: true,
      overview,
      rules: safeRules,
      actions: safeActions,
      digests: safeDigests,
      request_id
    })
  } catch (e) {
    console.error('[admin/automation/overview] unexpected', { request_id, error: e?.message || e })
    return sendAdminError(res, 500, {
      error: 'admin_automation_overview_failed',
      code: 'ADMIN_AUTOMATION_OVERVIEW_FAILED',
      detail: e?.message || null,
      request_id
    })
  }
})

router.patch('/automation/rules/:ruleId/pause', requireAuth, requireAdmin, async (req, res) => {
  return updateAdminAutomationRule(req, res, req.params?.ruleId, { enabled: false }, 'automation_rule_paused')
})

router.patch('/automation/rules/:ruleId/resume', requireAuth, requireAdmin, async (req, res) => {
  return updateAdminAutomationRule(req, res, req.params?.ruleId, { enabled: true }, 'automation_rule_resumed')
})

router.patch('/automation/rules/:ruleId/archive', requireAuth, requireAdmin, async (req, res) => {
  return updateAdminAutomationRule(
    req,
    res,
    req.params?.ruleId,
    {
      enabled: false,
      archived_at: new Date().toISOString()
    },
    'automation_rule_archived'
  )
})

router.patch('/automation/rules/:ruleId', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const rule = await loadAdminAutomationRule(req.params?.ruleId)
    if (!rule) {
      return sendAdminError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      })
    }

    const updates = {}
    let configChanged = false
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'criteria_config')) {
      const nextCriteria = normalizeCriteriaConfig(normalizeAdminJsonObject(req.body.criteria_config, 'criteria_config'))
      updates.criteria_config = nextCriteria
      if (stableStringify(nextCriteria) !== stableStringify(rule.criteria_config || {})) configChanged = true
    }

    if (!Object.keys(updates).length) {
      return sendAdminError(res, 400, {
        error: 'no_update_fields',
        code: 'no_update_fields',
        detail: 'Provide criteria_config.',
        request_id
      })
    }
    if (configChanged) {
      updates.rule_version = Math.max(1, Number(rule.rule_version || 1)) + 1
    }

    return updateAdminAutomationRule(req, res, rule.id, updates, 'automation_rule_criteria_updated')
  } catch (e) {
    console.error('[admin/automation/rules/criteria] unexpected', { request_id, error: e?.message || e })
    return sendAdminError(res, e?.status || 500, {
      error: e?.code || 'automation_rule_update_failed',
      code: e?.code || 'automation_rule_update_failed',
      detail: e?.message || null,
      request_id
    })
  }
})


module.exports = router;
