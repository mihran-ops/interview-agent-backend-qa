'use strict';

const MANAGE_SCOPE_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);
const MANAGE_MEMBER_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);
const LEGAL_BILLING_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);
const CHILD_EXPANSION_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);
const ROLE_RANK = {
  tester: 0,
  member: 1,
  manager: 2,
  admin: 3,
  owner: 4,
  super_admin: 5,
};

function normalizeClientRole(role) {
  const normalized = String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (normalized === 'superadmin') return 'super_admin';
  if (normalized === 'test') return 'tester';
  if (ROLE_RANK[normalized] !== undefined) return normalized;
  return 'member';
}

function toClientId(value) {
  const id = value == null ? '' : String(value).trim();
  return id || null;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function pickRelatedClient(value) {
  if (!value) return null;
  return Array.isArray(value) ? value[0] || null : value;
}

function getBillingClientId(client) {
  if (!client || typeof client !== 'object') return null;
  return toClientId(client.parent_client_id) || toClientId(client.id);
}

function mergeClient(clientById, client, fallbackClientId) {
  const source = pickRelatedClient(client) || {};
  const id = toClientId(source.id) || toClientId(fallbackClientId);
  if (!id) return null;

  const existing = clientById[id] || {};
  const merged = { ...existing, id };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) merged[key] = value;
  }

  merged.parent_client_id = toClientId(merged.parent_client_id);
  merged.billing_client_id = getBillingClientId(merged);
  merged.is_child_client = !!merged.parent_client_id;
  merged.is_parent_client = !merged.parent_client_id;
  clientById[id] = merged;
  return merged;
}

function strongerRole(currentRole, nextRole) {
  const current = normalizeClientRole(currentRole);
  const next = normalizeClientRole(nextRole);
  return ROLE_RANK[next] > ROLE_RANK[current] ? next : current;
}

function addRole(roleMap, clientId, role) {
  const id = toClientId(clientId);
  if (!id) return;
  const normalizedRole = normalizeClientRole(role);
  if (!roleMap[id]) roleMap[id] = [];
  if (!roleMap[id].includes(normalizedRole)) roleMap[id].push(normalizedRole);
}

function hasAnyRole(scopeContext, clientId, allowedRoles) {
  const id = toClientId(clientId);
  if (!id || !scopeContext) return false;
  const roles = asArray(scopeContext.effectiveRolesByClientId?.[id]).map(normalizeClientRole);
  return roles.some(role => allowedRoles.has(role));
}

function buildClientScopeContext({ memberships, clients } = {}) {
  const clientById = {};
  for (const client of asArray(clients)) {
    mergeClient(clientById, client);
  }

  const assignedRoleByClientId = {};
  const normalizedMemberships = asArray(memberships)
    .map((membership) => {
      const relatedClient = pickRelatedClient(membership?.client || membership?.clients);
      const clientId = toClientId(membership?.client_id || membership?.clientId || relatedClient?.id);
      if (!clientId) return null;

      const client = mergeClient(clientById, relatedClient, clientId);
      const role = normalizeClientRole(membership?.role);
      assignedRoleByClientId[clientId] = assignedRoleByClientId[clientId]
        ? strongerRole(assignedRoleByClientId[clientId], role)
        : role;

      return {
        ...membership,
        client_id: clientId,
        role,
        name: membership?.name || client?.name || null,
        client: client || null,
      };
    })
    .filter(Boolean);

  const childrenByParentId = {};
  for (const client of Object.values(clientById)) {
    const parentId = toClientId(client.parent_client_id);
    if (!parentId) continue;
    if (!childrenByParentId[parentId]) childrenByParentId[parentId] = [];
    childrenByParentId[parentId].push(client);
  }

  const assignedClientIds = Object.keys(assignedRoleByClientId);
  const accessibleClientIds = new Set();
  const effectiveRolesByClientId = {};

  for (const membership of normalizedMemberships) {
    const clientId = membership.client_id;
    const role = membership.role;
    accessibleClientIds.add(clientId);
    addRole(effectiveRolesByClientId, clientId, role);

    if (CHILD_EXPANSION_ROLES.has(role)) {
      for (const child of childrenByParentId[clientId] || []) {
        accessibleClientIds.add(child.id);
        addRole(effectiveRolesByClientId, child.id, role);
      }
    }
  }

  const context = {
    memberships: normalizedMemberships,
    clients: Object.values(clientById),
    clientById,
    childrenByParentId,
    assignedClientIds,
    accessibleClientIds: Array.from(accessibleClientIds),
    assignedRoleByClientId,
    effectiveRolesByClientId,
  };

  context.permissionsByClientId = Object.fromEntries(
    context.accessibleClientIds.map(clientId => [
      clientId,
      {
        can_create_roles: canCreateRolesForClient(context, clientId),
        can_purchase_interviews: canPurchaseInterviewsForClient(context, clientId),
        can_view_legal_billing: canViewLegalBillingForClient(context, clientId),
        can_manage_members: canManageMembersForClient(context, clientId),
      },
    ])
  );

  return context;
}

function getAccessibleClientIds(scopeContext, options = {}) {
  if (!scopeContext) return [];
  const ids = options.assignedOnly || options.assigned_only
    ? scopeContext.assignedClientIds
    : scopeContext.accessibleClientIds;
  return Array.from(new Set(asArray(ids).map(toClientId).filter(Boolean)));
}

function canCreateRolesForClient(scopeContext, clientId) {
  return hasAnyRole(scopeContext, clientId, MANAGE_SCOPE_ROLES);
}

function canPurchaseInterviewsForClient(scopeContext, clientId) {
  return hasAnyRole(scopeContext, clientId, MANAGE_SCOPE_ROLES);
}

function canViewLegalBillingForClient(scopeContext, clientId) {
  const id = toClientId(clientId);
  if (!id || !scopeContext) return false;
  const billingClientId = getBillingClientId(scopeContext.clientById?.[id] || { id });
  return hasAnyRole(scopeContext, billingClientId, LEGAL_BILLING_ROLES);
}

function canManageMembersForClient(scopeContext, clientId) {
  return hasAnyRole(scopeContext, clientId, MANAGE_MEMBER_ROLES);
}

module.exports = {
  normalizeClientRole,
  getBillingClientId,
  buildClientScopeContext,
  getAccessibleClientIds,
  canCreateRolesForClient,
  canPurchaseInterviewsForClient,
  canViewLegalBillingForClient,
  canManageMembersForClient,
};
