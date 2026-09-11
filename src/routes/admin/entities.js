'use strict';

// Child client entities under a parent client. Mounted on the admin router.

const express = require('express');
const { archiveChildClientEntity, restoreChildClientEntity } = require('../../services/clientEntityArchive');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const {
  buildAdminClientHierarchyMaps,
  loadTopLevelParentClient,
  trimNullableString,
  withAdminClientHierarchyMetadata,
} = require('../../services/admin/adminHelpers');

const router = express.Router();

router.post('/clients/:parentClientId/entities', requireAuth, requireAdmin, async (req, res) => {
  const name = trimNullableString(req.body?.name)
  const entityLabel = trimNullableString(req.body?.entity_label)
  if (!name) return res.status(400).json({ error: 'name_required' })

  const parentResult = await loadTopLevelParentClient(req.params.parentClientId)
  if (!parentResult.ok) return res.status(parentResult.status).json(parentResult.body)
  const parent = parentResult.client

  const { data: created, error } = await supabaseAdmin
    .from('clients')
    .insert({
      name,
      email: parent.email,
      parent_client_id: parent.id,
      entity_label: entityLabel,
      candidate_assistance_contact: parent.candidate_assistance_contact || null
    })
    .select('id,name,email,created_at,parent_client_id,entity_label,candidate_assistance_contact,archived_at,archived_reason,archived_by_user_id')
    .single()

  if (error) return res.status(500).json({ error: 'create_client_entity_failed', detail: error.message, hint: error.hint })

  const hierarchyMaps = buildAdminClientHierarchyMaps([parent, created])
  return res.json({
    ok: true,
    item: withAdminClientHierarchyMetadata(created, hierarchyMaps)
  })
})

router.patch('/clients/:parentClientId/entities/:entityClientId', requireAuth, requireAdmin, async (req, res) => {
  const parentResult = await loadTopLevelParentClient(req.params.parentClientId)
  if (!parentResult.ok) return res.status(parentResult.status).json(parentResult.body)
  const parent = parentResult.client

  const updates = {}
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
    const name = trimNullableString(req.body?.name)
    if (!name) return res.status(400).json({ error: 'name_required' })
    updates.name = name
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'entity_label')) {
    updates.entity_label = trimNullableString(req.body?.entity_label)
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_update_fields' })

  const { data: entity, error: entityError } = await supabaseAdmin
    .from('clients')
    .select('id,parent_client_id,archived_at')
    .eq('id', req.params.entityClientId)
    .maybeSingle()

  if (entityError) return res.status(500).json({ error: 'client_entity_lookup_failed', detail: entityError.message })
  if (!entity || String(entity.parent_client_id || '') !== String(parent.id)) {
    return res.status(404).json({ error: 'client_entity_not_found' })
  }

  const { data: updated, error } = await supabaseAdmin
    .from('clients')
    .update(updates)
    .eq('id', entity.id)
    .select('id,name,email,created_at,parent_client_id,entity_label,candidate_assistance_contact,archived_at,archived_reason,archived_by_user_id')
    .single()

  if (error) return res.status(500).json({ error: 'update_client_entity_failed', detail: error.message, hint: error.hint })

  const hierarchyMaps = buildAdminClientHierarchyMaps([parent, updated])
  return res.json({
    ok: true,
    item: withAdminClientHierarchyMetadata(updated, hierarchyMaps)
  })
})

router.patch('/clients/:parentClientId/entities/:entityClientId/archive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const result = await archiveChildClientEntity({
      db: supabaseAdmin,
      parentClientId: req.params?.parentClientId,
      entityClientId: req.params?.entityClientId,
      actorUserId: req.user?.id || null,
      reason: req.body?.reason || null,
      requestId: request_id
    })

    if (!result.ok) return res.status(result.status).json(result.body)

    const hierarchyMaps = buildAdminClientHierarchyMaps([result.parent, result.entity])
    const item = withAdminClientHierarchyMetadata(result.entity, hierarchyMaps)
    return res.json({
      ok: true,
      entity: {
        id: result.entity?.id || null,
        name: result.entity?.name || null,
        archived: true,
        archived_at: result.entity?.archived_at || null,
      },
      item,
      request_id
    })
  } catch (e) {
    console.error('[admin/clients/entities/archive] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      detail: e?.message || null,
      hint: null,
      request_id
    })
  }
})

router.patch('/clients/:parentClientId/entities/:entityClientId/restore', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const result = await restoreChildClientEntity({
      db: supabaseAdmin,
      parentClientId: req.params?.parentClientId,
      entityClientId: req.params?.entityClientId,
      requestId: request_id
    })

    if (!result.ok) return res.status(result.status).json(result.body)

    const hierarchyMaps = buildAdminClientHierarchyMaps([result.parent, result.entity])
    const item = withAdminClientHierarchyMetadata(result.entity, hierarchyMaps)
    return res.json({
      ok: true,
      entity: {
        id: result.entity?.id || null,
        name: result.entity?.name || null,
        archived: false,
        archived_at: null,
      },
      item,
      request_id
    })
  } catch (e) {
    console.error('[admin/clients/entities/restore] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      detail: e?.message || null,
      hint: null,
      request_id
    })
  }
})


module.exports = router;
