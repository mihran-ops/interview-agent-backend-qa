'use strict';

function toId(value) {
  const id = value == null ? '' : String(value).trim();
  return id || null;
}

function uniqueIds(values) {
  const seen = new Set();
  const ids = [];
  for (const value of values || []) {
    const id = toId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function errorBody(error, code, detail, hint, requestId) {
  return {
    error,
    code: code || error,
    detail: detail || null,
    hint: hint || null,
    request_id: requestId || null,
  };
}

function scopedError(status, error, code, detail, hint, requestId) {
  return { ok: false, status, body: errorBody(error, code, detail, hint, requestId) };
}

function isAdminRequest(req) {
  return req?.isGlobalAdmin === true || req?.isAdmin === true;
}

function accessibleClientIds(req) {
  return uniqueIds([
    ...(Array.isArray(req?.clientScope?.accessibleClientIds) ? req.clientScope.accessibleClientIds : []),
    ...(Array.isArray(req?.clientScope?.effectiveClientIds) ? req.clientScope.effectiveClientIds : []),
    ...(Array.isArray(req?.effectiveClientIds) ? req.effectiveClientIds : []),
    ...(Array.isArray(req?.clientIds) ? req.clientIds : []),
    ...(Array.isArray(req?.client_memberships) ? req.client_memberships : []),
  ]);
}

function normalizeFilter(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'parent' || lower === 'direct_parent') return { mode: 'parent' };
  if (lower === 'all' || lower === 'all_entities' || lower === 'hierarchy') return { mode: 'all' };
  if (lower.startsWith('entity:')) return { mode: 'specific', id: toId(raw.slice('entity:'.length)) };
  if (lower.startsWith('client:')) return { mode: 'specific', id: toId(raw.slice('client:'.length)) };
  return { mode: 'specific', id: toId(raw) };
}

function formatClientEntity(client) {
  const id = toId(client?.id);
  const parentClientId = toId(client?.parent_client_id);
  return {
    id,
    name: String(client?.name || '').trim() || id,
    parent_client_id: parentClientId,
    entity_label: String(client?.entity_label || '').trim() || null,
    archived_at: String(client?.archived_at || '').trim() || null,
    billing_client_id: parentClientId || id,
    is_parent_client: !parentClientId,
    is_child_client: !!parentClientId,
  };
}

function buildEntityMap(clients) {
  const map = {};
  for (const client of clients || []) {
    const entity = formatClientEntity(client);
    if (entity.id) map[entity.id] = entity;
  }
  return map;
}

async function loadEntityMap(db, clientIds) {
  const ids = uniqueIds(clientIds);
  if (!ids.length) return {};

  const { data, error } = await db
    .from('clients')
    .select('id,name,parent_client_id,entity_label,archived_at')
    .in('id', ids);
  if (error) throw error;
  return buildEntityMap(data || []);
}

async function loadSelectedHierarchy(db, selectedClientId, requestId) {
  const clientId = toId(selectedClientId);
  if (!clientId) {
    return scopedError(
      400,
      'bad_request',
      'CLIENT_ID_REQUIRED',
      'client_id is required when entity_filter is provided.',
      null,
      requestId
    );
  }

  const { data: selected, error: selectedError } = await db
    .from('clients')
    .select('id,name,parent_client_id,entity_label,archived_at')
    .eq('id', clientId)
    .maybeSingle();
  if (selectedError) {
    return scopedError(
      500,
      'server_error',
      'CLIENT_LOOKUP_FAILED',
      selectedError.message,
      selectedError.hint || null,
      requestId
    );
  }
  if (!selected) {
    return scopedError(404, 'not_found', 'CLIENT_NOT_FOUND', 'Client was not found.', null, requestId);
  }

  const selectedEntity = formatClientEntity(selected);
  let parent = selectedEntity;
  if (selectedEntity.parent_client_id) {
    const { data: parentRow, error: parentError } = await db
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at')
      .eq('id', selectedEntity.parent_client_id)
      .maybeSingle();
    if (parentError) {
      return scopedError(
        500,
        'server_error',
        'PARENT_CLIENT_LOOKUP_FAILED',
        parentError.message,
        parentError.hint || null,
        requestId
      );
    }
    if (!parentRow || toId(parentRow.parent_client_id)) {
      return scopedError(
        400,
        'bad_request',
        'INVALID_PARENT_CLIENT',
        'Client hierarchy could not be resolved safely.',
        null,
        requestId
      );
    }
    parent = formatClientEntity(parentRow);
  }

  const { data: childRows, error: childrenError } = await db
    .from('clients')
    .select('id,name,parent_client_id,entity_label,archived_at')
    .eq('parent_client_id', parent.id)
    .is('archived_at', null)
    .order('name', { ascending: true });
  if (childrenError) {
    return scopedError(
      500,
      'server_error',
      'CHILD_CLIENT_LOOKUP_FAILED',
      childrenError.message,
      childrenError.hint || null,
      requestId
    );
  }

  const children = (childRows || []).map(formatClientEntity).filter((child) => child.id);
  const entitiesById = buildEntityMap([parent, ...children]);
  return { ok: true, selected: selectedEntity, parent, children, entitiesById };
}

async function resolveEntityFilter({ db, req, clientId, entityFilter, requestId }) {
  const filter = normalizeFilter(entityFilter);
  const selectedClientId = toId(clientId);

  if (!filter) {
    return {
      ok: true,
      mode: 'default',
      clientIds: selectedClientId ? [selectedClientId] : [],
      entitiesById: {},
      parent: null,
      children: [],
      selected: null,
    };
  }

  const hierarchy = await loadSelectedHierarchy(db, selectedClientId, requestId);
  if (!hierarchy.ok) return hierarchy;

  const hierarchyIds = uniqueIds([hierarchy.parent.id, ...hierarchy.children.map((child) => child.id)]);
  let requestedIds = [];

  if (filter.mode === 'parent') {
    requestedIds = [hierarchy.parent.id];
  } else if (filter.mode === 'all') {
    requestedIds = hierarchyIds;
  } else {
    const specificId = toId(filter.id);
    if (!specificId || !hierarchyIds.includes(specificId)) {
      return scopedError(
        403,
        'forbidden',
        'ENTITY_SCOPE_MISMATCH',
        'Requested entity is outside the selected parent client hierarchy.',
        null,
        requestId
      );
    }
    requestedIds = [specificId];
  }

  let authorizedIds = requestedIds;
  if (!isAdminRequest(req)) {
    const allowed = new Set(accessibleClientIds(req));
    if (filter.mode === 'all') {
      authorizedIds = requestedIds.filter((id) => allowed.has(id));
    } else if (!requestedIds.every((id) => allowed.has(id))) {
      return scopedError(
        403,
        'forbidden',
        'CLIENT_SCOPE_MISMATCH',
        'Requested entity is outside your client scope.',
        null,
        requestId
      );
    }
  }

  authorizedIds = uniqueIds(authorizedIds);
  if (!authorizedIds.length) {
    return scopedError(
      403,
      'forbidden',
      'CLIENT_SCOPE_MISMATCH',
      'No requested entities are available in your client scope.',
      null,
      requestId
    );
  }

  return {
    ok: true,
    mode: filter.mode,
    clientIds: authorizedIds,
    requestedClientIds: requestedIds,
    entitiesById: hierarchy.entitiesById,
    parent: hierarchy.parent,
    children: hierarchy.children,
    selected: hierarchy.selected,
  };
}

function entityFieldsForClientId(entityMap, clientId) {
  const id = toId(clientId);
  const entity = id ? entityMap?.[id] : null;
  return {
    entity_id: id,
    entity_name: entity?.name || id || null,
    entity_label: entity?.entity_label || null,
    entity_parent_client_id: entity?.parent_client_id || null,
    entity_is_parent: entity ? entity.is_parent_client === true : null,
    entity_is_child: entity ? entity.is_child_client === true : null,
  };
}

function withEntityFields(row, entityMap, clientId) {
  return {
    ...row,
    ...entityFieldsForClientId(entityMap, clientId ?? row?.client_id),
  };
}

module.exports = {
  toId,
  uniqueIds,
  normalizeFilter,
  errorBody,
  scopedError,
  accessibleClientIds,
  formatClientEntity,
  buildEntityMap,
  loadEntityMap,
  loadSelectedHierarchy,
  resolveEntityFilter,
  entityFieldsForClientId,
  withEntityFields,
};
