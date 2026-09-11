'use strict';

// Tenant-managed child entities under the caller's client.
// Mounted at the application root, so the paths here are absolute.

const express = require('express');
const { archiveChildClientEntity } = require('../../lib/clientEntityArchive');
const { processClientEntityImport } = require('../../lib/clientEntityImportService');
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const { formatTenantClientEntity, hasTenantEntityManagementAccess, resolveTenantEntityParent } = require('../../services/clientScope/tenancy');

const router = express.Router();

router.get('/clients/entities', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const selectedClientId = req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || null
    const parentResult = await resolveTenantEntityParent(req, selectedClientId)
    if (!parentResult.ok) return res.status(parentResult.status).json({ ...parentResult.body, request_id })

    const { data: children, error } = await supabaseAdmin
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
      .eq('parent_client_id', parentResult.parent.id)
      .is('archived_at', null)
      .order('name', { ascending: true })

    if (error) return res.status(500).json({ error: 'list_client_entities_failed', detail: error.message, request_id })

    return res.json({
      ok: true,
      parent: formatTenantClientEntity(parentResult.parent),
      items: (children || []).map(formatTenantClientEntity),
      request_id
    })
  } catch (e) {
    console.error('[clients/entities] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'server_error', request_id })
  }
})

router.post('/clients/entities', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const selectedClientId = req.body?.client_id || req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || null
    const name = String(req.body?.name || '').trim()
    const entityLabel = String(req.body?.entity_label || '').trim() || null
    if (!name) return res.status(400).json({ error: 'name_required', request_id })

    const parentResult = await resolveTenantEntityParent(req, selectedClientId)
    if (!parentResult.ok) return res.status(parentResult.status).json({ ...parentResult.body, request_id })

    const parent = parentResult.parent
    if (!parent || String(parent.parent_client_id || '').trim()) {
      return res.status(400).json({
        error: 'invalid_parent_client',
        detail: 'Client hierarchy could not be resolved safely.',
        request_id
      })
    }

    const { data: created, error } = await supabaseAdmin
      .from('clients')
      .insert({
        name,
        email: parent.email,
        parent_client_id: parent.id,
        entity_label: entityLabel,
        candidate_assistance_contact: parent.candidate_assistance_contact || null
      })
      .select('id,name,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
      .single()

    if (error) return res.status(500).json({ error: 'create_client_entity_failed', detail: error.message, hint: error.hint, request_id })

    return res.json({
      ok: true,
      item: formatTenantClientEntity(created),
      request_id
    })
  } catch (e) {
    console.error('[clients/entities/create] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'server_error', request_id })
  }
})

router.post('/clients/entities/import', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const selectedClientId = req.body?.parent_client_id || req.body?.client_id || req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || null
    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null
    if (!rawRows) {
      return res.status(400).json({
        error: 'rows_required',
        code: 'ROWS_REQUIRED',
        detail: 'rows must be an array.',
        hint: null,
        request_id
      })
    }
    if (rawRows.length > 250) {
      return res.status(400).json({
        error: 'too_many_rows',
        code: 'TOO_MANY_ROWS',
        detail: 'Entity import is limited to 250 rows per upload.',
        hint: null,
        request_id
      })
    }

    const parentResult = await resolveTenantEntityParent(req, selectedClientId)
    if (!parentResult.ok) {
      return res.status(parentResult.status).json({
        error: parentResult.body?.error || 'client_scope_failed',
        code: parentResult.body?.code || String(parentResult.body?.error || 'client_scope_failed').toUpperCase(),
        detail: parentResult.body?.detail || null,
        hint: parentResult.body?.hint || null,
        request_id
      })
    }

    const parent = parentResult.parent
    if (!parent || String(parent.parent_client_id || '').trim()) {
      return res.status(400).json({
        error: 'invalid_parent_client',
        code: 'INVALID_PARENT_CLIENT',
        detail: 'Client hierarchy could not be resolved safely.',
        hint: null,
        request_id
      })
    }

    const { data: existingChildren, error: existingError } = await supabaseAdmin
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at')
      .eq('parent_client_id', parent.id)
      .is('archived_at', null)

    if (existingError) {
      return res.status(500).json({
        error: 'existing_entities_lookup_failed',
        code: 'EXISTING_ENTITIES_LOOKUP_FAILED',
        detail: existingError.message,
        hint: existingError.hint || null,
        request_id
      })
    }

    const importResult = await processClientEntityImport({
      db: supabaseAdmin,
      authAdmin: supabaseAdmin.auth?.admin,
      parent,
      rawRows,
      existingChildren,
      formatEntity: formatTenantClientEntity
    })

    return res.json({
      ok: true,
      parent: formatTenantClientEntity(parent),
      counts: importResult.counts,
      results: importResult.results,
      created: importResult.created,
      temporary_credentials: importResult.temporary_credentials,
      sensitive_result: importResult.temporary_credentials.length > 0,
      request_id
    })
  } catch (e) {
    console.error('[clients/entities/import] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      detail: e?.message || null,
      hint: null,
      request_id
    })
  }
})

router.patch('/clients/entities/:entityClientId', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const entityClientId = String(req.params?.entityClientId || '').trim()
    if (!entityClientId) return res.status(404).json({ error: 'entity_client_not_found', request_id })

    const { data: entity, error: entityError } = await supabaseAdmin
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at')
      .eq('id', entityClientId)
      .maybeSingle()

    if (entityError) return res.status(500).json({ error: 'entity_client_lookup_failed', detail: entityError.message, request_id })
    if (!entity) return res.status(404).json({ error: 'entity_client_not_found', request_id })

    const parentClientId = String(entity.parent_client_id || '').trim()
    if (!parentClientId) return res.status(400).json({ error: 'child_entity_required', request_id })

    const { data: parent, error: parentError } = await supabaseAdmin
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at')
      .eq('id', parentClientId)
      .maybeSingle()

    if (parentError) return res.status(500).json({ error: 'parent_client_lookup_failed', detail: parentError.message, request_id })
    if (!parent || String(parent.parent_client_id || '').trim()) {
      return res.status(400).json({
        error: 'invalid_parent_client',
        detail: 'Client hierarchy could not be resolved safely.',
        request_id
      })
    }
    if (!hasTenantEntityManagementAccess(req, parent.id)) {
      return res.status(403).json({ error: 'forbidden', request_id })
    }

    const updates = {}
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      const name = String(req.body?.name || '').trim()
      if (!name) return res.status(400).json({ error: 'name_required', request_id })
      updates.name = name
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'entity_label')) {
      updates.entity_label = String(req.body?.entity_label || '').trim() || null
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_update_fields', request_id })

    const { data: updated, error } = await supabaseAdmin
      .from('clients')
      .update(updates)
      .eq('id', entity.id)
      .select('id,name,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
      .single()

    if (error) return res.status(500).json({ error: 'update_client_entity_failed', detail: error.message, hint: error.hint, request_id })

    return res.json({
      ok: true,
      item: formatTenantClientEntity(updated),
      request_id
    })
  } catch (e) {
    console.error('[clients/entities/update] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'server_error', request_id })
  }
})

router.patch('/clients/entities/:entityClientId/archive', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const selectedClientId = req.body?.client_id || req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || null
    const parentResult = await resolveTenantEntityParent(req, selectedClientId)
    if (!parentResult.ok) return res.status(parentResult.status).json({ ...parentResult.body, request_id })

    const result = await archiveChildClientEntity({
      db: supabaseAdmin,
      parentClientId: parentResult.parent.id,
      entityClientId: req.params?.entityClientId,
      actorUserId: req.user?.id || null,
      reason: req.body?.reason || null,
      requestId: request_id
    })

    if (!result.ok) return res.status(result.status).json(result.body)

    return res.json({
      ok: true,
      entity: {
        id: result.entity?.id || null,
        name: result.entity?.name || null,
        archived: true,
        archived_at: result.entity?.archived_at || null,
      },
      item: formatTenantClientEntity(result.entity),
      request_id
    })
  } catch (e) {
    console.error('[clients/entities/archive] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'server_error', code: 'SERVER_ERROR', detail: e?.message || null, request_id })
  }
})


module.exports = router;
