'use strict';

// Shared admin helpers, moved out of app.js unchanged.

const { requireParentClient } = require('../clientBillingScope');
const { supabaseAdmin } = require('../../clients/supabase');

function trimNullableString(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function buildAdminClientHierarchyMaps(clients) {
  const parentNameById = {}
  const childCountByParentId = {}

  for (const client of clients || []) {
    if (client?.id) parentNameById[client.id] = client.name || null
    const parentId = trimNullableString(client?.parent_client_id)
    if (parentId) childCountByParentId[parentId] = (childCountByParentId[parentId] || 0) + 1
  }

  return { parentNameById, childCountByParentId }
}

function withAdminClientHierarchyMetadata(client, maps = {}) {
  const parentClientId = trimNullableString(client?.parent_client_id)
  const archivedAt = trimNullableString(client?.archived_at)
  return {
    ...client,
    parent_client_id: parentClientId,
    entity_label: trimNullableString(client?.entity_label),
    archived_at: archivedAt,
    archived_reason: trimNullableString(client?.archived_reason),
    archived_by_user_id: trimNullableString(client?.archived_by_user_id),
    archived: !!archivedAt,
    billing_client_id: parentClientId || client?.id || null,
    is_parent_client: !parentClientId,
    is_child_client: !!parentClientId,
    parent_client_name: parentClientId ? (maps.parentNameById?.[parentClientId] || null) : null,
    child_count: client?.id ? (maps.childCountByParentId?.[client.id] || 0) : 0
  }
}

async function loadTopLevelParentClient(parentClientId) {
  const id = trimNullableString(parentClientId)
  if (!id) {
    return {
      ok: false,
      status: 400,
      body: { error: 'parent_client_id_required' }
    }
  }

  const { data: parent, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,parent_client_id,entity_label,candidate_assistance_contact,archived_at')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'parent_client_lookup_failed', detail: error.message }
    }
  }
  if (!parent) {
    return {
      ok: false,
      status: 404,
      body: { error: 'parent_client_not_found' }
    }
  }
  if (trimNullableString(parent.parent_client_id)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_parent_client',
        detail: 'Child entities can only be created under top-level parent clients.'
      }
    }
  }

  return { ok: true, client: parent }
}

function isUnavailableRelationError(error) {
  const code = String(error?.code || '').trim()
  const message = String(error?.message || '').toLowerCase()
  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST200' ||
    code === 'PGRST204' ||
    code === 'PGRST205' ||
    message.includes('does not exist') ||
    message.includes('could not find')
  )
}

async function countClientDeleteBlockers(clientId) {
  const blockers = {}
  const warnings = []
  const checkErrors = []
  const checks = [
    { key: 'child_clients', table: 'clients', column: 'parent_client_id' },
    { key: 'roles', table: 'roles', column: 'client_id' },
    { key: 'candidates', table: 'candidates', column: 'client_id' },
    { key: 'interviews', table: 'interviews', column: 'client_id' },
    { key: 'reports', table: 'reports', column: 'client_id' },
    { key: 'client_members', table: 'client_members', column: 'client_id' },
    { key: 'membership_agreements', table: 'membership_agreements', column: 'client_id' },
    { key: 'client_plan_settings', table: 'client_plan_settings', column: 'client_id' }
  ]

  for (const check of checks) {
    const { count, error } = await supabaseAdmin
      .from(check.table)
      .select('*', { count: 'exact', head: true })
      .eq(check.column, clientId)

    if (error) {
      const checkResult = {
        key: check.key,
        table: check.table,
        column: check.column,
        code: error.code || null,
        detail: error.message || 'delete_blocker_check_failed'
      }
      if (isUnavailableRelationError(error)) {
        warnings.push({ ...checkResult, skipped: true })
      } else {
        checkErrors.push(checkResult)
      }
      continue
    }

    if (Number(count) > 0) blockers[check.key] = Number(count)
  }

  return { blockers, warnings, checkErrors }
}

async function rejectChildClientForAdminBilling(req, res, context) {
  const result = await requireParentClient(supabaseAdmin, req.params?.id, context)
  if (!result.ok) {
    res.status(result.status || 500).json(result.body || { error: 'client_lookup_failed' })
    return null
  }
  return result
}

function sendAdminError(res, status, payload = {}) {
  return res.status(status).json({
    error: payload.error || payload.code || 'server_error',
    code: payload.code || payload.error || 'server_error',
    detail: payload.detail || null,
    hint: payload.hint || null,
    request_id: payload.request_id || null
  })
}

function cleanAdminUserEmail(req) {
  return String(req?.user?.email || '').trim().toLowerCase() || null
}

function normalizeAdminJsonObject(value, fieldName, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    const err = new Error(`${fieldName} must be a JSON object.`)
    err.status = 400
    err.code = `invalid_${fieldName}`
    throw err
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  const err = new Error(`${fieldName} must be a JSON object.`)
  err.status = 400
  err.code = `invalid_${fieldName}`
  throw err
}


module.exports = {
  buildAdminClientHierarchyMaps,
  cleanAdminUserEmail,
  countClientDeleteBlockers,
  isUnavailableRelationError,
  loadTopLevelParentClient,
  normalizeAdminJsonObject,
  rejectChildClientForAdminBilling,
  sendAdminError,
  trimNullableString,
  withAdminClientHierarchyMetadata,
};
