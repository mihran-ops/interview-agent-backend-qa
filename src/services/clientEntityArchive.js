'use strict';

function trimNullableString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function archiveError(status, error, detail = null, hint = null, requestId = null) {
  return {
    ok: false,
    status,
    body: {
      error,
      code: String(error || 'archive_client_entity_failed').toUpperCase(),
      detail,
      hint,
      request_id: requestId,
    },
  };
}

async function archiveChildClientEntity({
  db,
  parentClientId,
  entityClientId,
  actorUserId = null,
  reason = null,
  requestId = null,
  archivedAt = null,
} = {}) {
  if (!db?.from) {
    return archiveError(500, 'db_required', 'A Supabase client is required.', null, requestId);
  }

  const parentId = trimNullableString(parentClientId);
  const entityId = trimNullableString(entityClientId);
  if (!parentId) return archiveError(400, 'parent_client_id_required', null, null, requestId);
  if (!entityId) return archiveError(404, 'entity_client_not_found', null, null, requestId);

  const { data: parent, error: parentError } = await db
    .from('clients')
    .select('id,name,parent_client_id,entity_label,archived_at')
    .eq('id', parentId)
    .maybeSingle();

  if (parentError) {
    return archiveError(500, 'parent_client_lookup_failed', parentError.message, parentError.hint || null, requestId);
  }
  if (!parent) return archiveError(404, 'parent_client_not_found', null, null, requestId);
  if (trimNullableString(parent.parent_client_id)) {
    return archiveError(
      400,
      'invalid_parent_client',
      'Child entities can only be archived under top-level parent clients.',
      null,
      requestId
    );
  }

  const { data: entity, error: entityError } = await db
    .from('clients')
    .select('id,name,parent_client_id,entity_label,archived_at')
    .eq('id', entityId)
    .maybeSingle();

  if (entityError) {
    return archiveError(500, 'client_entity_lookup_failed', entityError.message, entityError.hint || null, requestId);
  }
  if (!entity) return archiveError(404, 'client_entity_not_found', null, null, requestId);
  if (!trimNullableString(entity.parent_client_id)) {
    return archiveError(400, 'child_entity_required', null, null, requestId);
  }
  if (trimNullableString(entity.parent_client_id) !== parentId) {
    return archiveError(404, 'client_entity_not_found', null, null, requestId);
  }

  const archiveTimestamp = trimNullableString(entity.archived_at) || archivedAt || new Date().toISOString();
  const updates = {
    archived_at: archiveTimestamp,
    archived_reason: trimNullableString(reason),
    archived_by_user_id: trimNullableString(actorUserId),
  };

  const { data: updated, error: updateError } = await db
    .from('clients')
    .update(updates)
    .eq('id', entity.id)
    .select('id,name,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
    .single();

  if (updateError) {
    return archiveError(500, 'archive_client_entity_failed', updateError.message, updateError.hint || null, requestId);
  }

  return {
    ok: true,
    parent,
    entity: updated,
    archived: true,
    request_id: requestId,
  };
}

async function restoreChildClientEntity({
  db,
  parentClientId,
  entityClientId,
  requestId = null,
} = {}) {
  if (!db?.from) {
    return archiveError(500, 'db_required', 'A Supabase client is required.', null, requestId);
  }

  const parentId = trimNullableString(parentClientId);
  const entityId = trimNullableString(entityClientId);
  if (!parentId) return archiveError(400, 'parent_client_id_required', null, null, requestId);
  if (!entityId) return archiveError(404, 'entity_client_not_found', null, null, requestId);

  const { data: parent, error: parentError } = await db
    .from('clients')
    .select('id,name,parent_client_id,entity_label,archived_at')
    .eq('id', parentId)
    .maybeSingle();

  if (parentError) {
    return archiveError(500, 'parent_client_lookup_failed', parentError.message, parentError.hint || null, requestId);
  }
  if (!parent) return archiveError(404, 'parent_client_not_found', null, null, requestId);
  if (trimNullableString(parent.parent_client_id)) {
    return archiveError(
      400,
      'invalid_parent_client',
      'Child entities can only be restored under top-level parent clients.',
      null,
      requestId
    );
  }

  const { data: entity, error: entityError } = await db
    .from('clients')
    .select('id,name,parent_client_id,entity_label,archived_at')
    .eq('id', entityId)
    .maybeSingle();

  if (entityError) {
    return archiveError(500, 'client_entity_lookup_failed', entityError.message, entityError.hint || null, requestId);
  }
  if (!entity) return archiveError(404, 'client_entity_not_found', null, null, requestId);
  if (!trimNullableString(entity.parent_client_id)) {
    return archiveError(400, 'child_entity_required', null, null, requestId);
  }
  if (trimNullableString(entity.parent_client_id) !== parentId) {
    return archiveError(404, 'client_entity_not_found', null, null, requestId);
  }

  const { data: updated, error: updateError } = await db
    .from('clients')
    .update({
      archived_at: null,
      archived_reason: null,
      archived_by_user_id: null,
    })
    .eq('id', entity.id)
    .select('id,name,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
    .single();

  if (updateError) {
    return archiveError(500, 'restore_client_entity_failed', updateError.message, updateError.hint || null, requestId);
  }

  return {
    ok: true,
    parent,
    entity: updated,
    restored: true,
    request_id: requestId,
  };
}

module.exports = {
  archiveChildClientEntity,
  restoreChildClientEntity,
};
