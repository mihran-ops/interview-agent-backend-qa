'use strict';

// Tenancy resolution: memberships, effective roles, and child entity access.

const { buildClientScopeContext } = require('../../lib/clientScope');
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { uniqueClientIds } = require('./clientScope');

async function loadClientScopeContextForResponse(req, knownClients) {
  const effectiveIds = uniqueClientIds(req.effectiveClientIds || req.clientIds || [])
  let clients = Array.isArray(knownClients) ? knownClients.slice() : []
  const knownClientIds = new Set(clients.map(c => String(c?.id || '').trim()).filter(Boolean))
  const missingClientIds = effectiveIds.filter(id => !knownClientIds.has(id))

  if (missingClientIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('id, name, parent_client_id, entity_label, archived_at')
      .in('id', missingClientIds)
    if (!error && Array.isArray(data)) clients = clients.concat(data)
  }

  return buildClientScopeContext({
    memberships: req.effectiveMemberships || req.memberships || [],
    clients,
  })
}

function clientScopeMetadata(scopeContext, clientId) {
  const id = String(clientId || '').trim()
  const client = scopeContext?.clientById?.[id] || { id }
  const permissions = scopeContext?.permissionsByClientId?.[id] || {
    can_create_roles: false,
    can_purchase_interviews: false,
    can_view_legal_billing: false,
    can_manage_members: false,
  }

  return {
    parent_client_id: client.parent_client_id || null,
    entity_label: client.entity_label || null,
    archived_at: client.archived_at || null,
    billing_client_id: client.billing_client_id || id || null,
    is_parent_client: client.is_parent_client !== false,
    is_child_client: client.is_child_client === true,
    permissions,
  }
}

function normalizeTenantRole(role) {
  const normalized = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return normalized === 'superadmin' ? 'super_admin' : normalized
}

const TENANT_ENTITY_MANAGER_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin'])

function findEffectiveClientMembership(req, clientId) {
  const targetClientId = String(clientId || '').trim()
  if (!targetClientId) return null
  const memberships = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships
    : Array.isArray(req?.effectiveMemberships)
      ? req.effectiveMemberships
      : Array.isArray(req?.memberships)
        ? req.memberships
        : []
  return memberships.find(m => String(m?.client_id || '').trim() === targetClientId) || null
}

function hasTenantEntityManagementAccess(req, parentClientId) {
  const parentId = String(parentClientId || '').trim()
  if (!parentId) return false
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return true

  const parentMembership = findEffectiveClientMembership(req, parentId)
  if (TENANT_ENTITY_MANAGER_ROLES.has(normalizeTenantRole(parentMembership?.role))) return true

  const memberships = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships
    : Array.isArray(req?.effectiveMemberships)
      ? req.effectiveMemberships
      : Array.isArray(req?.memberships)
        ? req.memberships
        : []
  return memberships.some(m => (
    TENANT_ENTITY_MANAGER_ROLES.has(normalizeTenantRole(m?.role)) &&
    m?.inherited === true &&
    String(m?.inherited_from_client_id || '').trim() === parentId
  ))
}

function formatTenantClientEntity(client) {
  const parentClientId = String(client?.parent_client_id || '').trim() || null
  return {
    id: client?.id || null,
    name: client?.name || null,
    parent_client_id: parentClientId,
    entity_label: String(client?.entity_label || '').trim() || null,
    archived_at: String(client?.archived_at || '').trim() || null,
    archived_reason: String(client?.archived_reason || '').trim() || null,
    archived_by_user_id: String(client?.archived_by_user_id || '').trim() || null,
    archived: Boolean(String(client?.archived_at || '').trim()),
    billing_client_id: parentClientId || client?.id || null,
    is_parent_client: !parentClientId,
    is_child_client: !!parentClientId,
  }
}

async function resolveTenantEntityParent(req, selectedClientId) {
  const clientId = String(selectedClientId || '').trim()
  if (!clientId) {
    return { ok: false, status: 400, body: { error: 'client_id_required' } }
  }

  const { data: selected, error: selectedError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,parent_client_id,entity_label,candidate_assistance_contact,archived_at')
    .eq('id', clientId)
    .maybeSingle()

  if (selectedError) {
    return { ok: false, status: 500, body: { error: 'client_lookup_failed', detail: selectedError.message } }
  }
  if (!selected) {
    return { ok: false, status: 404, body: { error: 'client_not_found' } }
  }

  const selectedParentId = String(selected.parent_client_id || '').trim()
  if (!selectedParentId) {
    if (!hasTenantEntityManagementAccess(req, selected.id)) {
      return { ok: false, status: 403, body: { error: 'forbidden' } }
    }
    return { ok: true, parent: selected, selected }
  }

  const { data: parent, error: parentError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,parent_client_id,entity_label,candidate_assistance_contact,archived_at')
    .eq('id', selectedParentId)
    .maybeSingle()

  if (parentError) {
    return { ok: false, status: 500, body: { error: 'parent_client_lookup_failed', detail: parentError.message } }
  }
  if (!parent || String(parent.parent_client_id || '').trim()) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid_parent_client', detail: 'Client hierarchy could not be resolved safely.' }
    }
  }
  if (!hasTenantEntityManagementAccess(req, parent.id)) {
    return { ok: false, status: 403, body: { error: 'forbidden' } }
  }

  return { ok: true, parent, selected }
}


module.exports = {
  TENANT_ENTITY_MANAGER_ROLES,
  clientScopeMetadata,
  findEffectiveClientMembership,
  formatTenantClientEntity,
  hasTenantEntityManagementAccess,
  loadClientScopeContextForResponse,
  normalizeTenantRole,
  resolveTenantEntityParent,
};
