'use strict';

// Presentation and lookup helpers behind the admin automation views.

const { resolveEntityFilter } = require('../../lib/entityScopeFilter');
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { uniqueClientIds } = require('../clientScope/clientScope');
const { trimNullableString } = require('./adminHelpers');

function automationSchedulerSendEnabled() {
  return ['true', '1', 'yes'].includes(String(process.env.AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED || '').trim().toLowerCase())
}

function automationSchedulerSecretConfigured() {
  return Boolean(String(
    process.env.AUTOMATION_DIGEST_RUNNER_SECRET ||
    process.env.AUTOMATION_DIGEST_CRON_SECRET ||
    process.env.CONTRACTS_CRON_SECRET ||
    ''
  ).trim())
}

function asJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function summarizeKeyValues(value, fallback = 'Default criteria') {
  const source = asJsonObject(value)
  const entries = Object.entries(source)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== '')
    .slice(0, 4)
    .map(([key, entryValue]) => {
      const label = key.replace(/_/g, ' ')
      if (Array.isArray(entryValue)) return `${label}: ${entryValue.length}`
      if (typeof entryValue === 'object') return `${label}: configured`
      return `${label}: ${String(entryValue)}`
    })
  return entries.length ? entries.join(' · ') : fallback
}

function summarizeAutomationRecipients(rule) {
  const digestConfig = asJsonObject(rule?.digest_config)
  const pendingDigest = asJsonObject(digestConfig.pending_approval_digest)
  const actionConfig = asJsonObject(rule?.action_config)
  const recipients = Array.isArray(digestConfig.recipients)
    ? digestConfig.recipients
    : Array.isArray(actionConfig.recipients)
      ? actionConfig.recipients
      : Array.isArray(pendingDigest.recipient_emails)
        ? pendingDigest.recipient_emails
      : []
  if (recipients.length > 0) return `${recipients.length} configured recipient${recipients.length === 1 ? '' : 's'}`
  if (digestConfig.recipient_email || actionConfig.recipient_email) return '1 configured recipient'
  return 'No configured recipients'
}

function summarizeAutomationCadence(rule) {
  const digestConfig = asJsonObject(rule?.digest_config)
  const pendingDigest = asJsonObject(digestConfig.pending_approval_digest)
  const frequency = trimNullableString(pendingDigest.frequency) || trimNullableString(digestConfig.frequency) || trimNullableString(digestConfig.cadence)
  const sendTime = trimNullableString(pendingDigest.send_time_local) || trimNullableString(digestConfig.send_time_local)
  if (frequency && sendTime) return `${frequency} at ${sendTime}`
  return frequency || trimNullableString(rule?.mode) || 'Manual review'
}

function sanitizeAutomationSchedulingUrl(value) {
  const raw = trimNullableString(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    const sensitiveKeys = ['token', 'secret', 'key', 'signature', 'sig', 'auth', 'password', 'code']
    for (const key of Array.from(url.searchParams.keys())) {
      const lower = key.toLowerCase()
      if (sensitiveKeys.some((sensitive) => lower.includes(sensitive))) {
        url.searchParams.set(key, 'REDACTED')
      }
    }
    url.hash = ''
    return url.toString()
  } catch (_) {
    return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw
  }
}

function automationRuleStatus(rule) {
  if (trimNullableString(rule?.archived_at)) return 'archived'
  return rule?.enabled === true ? 'active' : 'paused'
}

function maskEmail(value) {
  const email = trimNullableString(value)
  if (!email || !email.includes('@')) return email || null
  const [local, domain] = email.split('@')
  const start = local.slice(0, 1)
  return `${start}${local.length > 1 ? '***' : ''}@${domain}`
}

function deriveAutomationApprovalStatus(action) {
  const state = String(action?.state || '').trim().toLowerCase()
  if (action?.rejected_at || state === 'rejected') return 'rejected'
  if (action?.approved_at || ['approved', 'queued', 'sending', 'sent', 'delivered'].includes(state)) return 'approved'
  if (state === 'pending_approval') return 'pending approval'
  if (state === 'failed') return 'failed'
  if (state === 'canceled') return 'canceled'
  return state || 'unknown'
}

function collectUniqueIds(rows, fields) {
  const ids = new Set()
  for (const row of rows || []) {
    for (const field of fields || []) {
      const id = trimNullableString(row?.[field])
      if (id) ids.add(id)
    }
  }
  return Array.from(ids)
}

async function loadAutomationLookupMap(table, columns, ids) {
  const lookupIds = uniqueClientIds(ids)
  if (!lookupIds.length) return {}
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(columns)
    .in('id', lookupIds)
  if (error) throw error
  return Object.fromEntries((data || []).map((row) => [row.id, row]))
}

async function resolveAdminAutomationClientIds(req, requestId) {
  const clientId = trimNullableString(req.query?.client_id)
  const entityFilter = trimNullableString(req.query?.entity_filter)
  if (!clientId || clientId === 'all') return { ok: true, clientIds: null, entityFilter: null }
  if (!entityFilter) return { ok: true, clientIds: [clientId], entityFilter: null }

  const resolved = await resolveEntityFilter({
    db: supabaseAdmin,
    req: { ...req, isGlobalAdmin: true, isAdmin: true },
    clientId,
    entityFilter,
    requestId
  })
  if (!resolved.ok) return resolved
  return {
    ok: true,
    clientIds: resolved.clientIds || [clientId],
    entityFilter: resolved
  }
}

function countRowsByStatus(rows, field = 'state') {
  const counts = {}
  for (const row of rows || []) {
    const status = String(row?.[field] || 'unknown').trim().toLowerCase() || 'unknown'
    counts[status] = (counts[status] || 0) + 1
  }
  return counts
}


module.exports = {
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
};
