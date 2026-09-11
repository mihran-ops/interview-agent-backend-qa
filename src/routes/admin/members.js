'use strict';

// Client member administration and password recovery. Mounted on the admin router.

const express = require('express');
const { buildClientPwResetUrl } = require('../../../config/urlConfig');
const { sendMemberRecoveryEmail } = require('../../../utils/mailer');
const { loadEntityMap, resolveEntityFilter, withEntityFields } = require('../../lib/entityScopeFilter');
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { ensureUserIdAndRecoveryLink } = require('../../services/users/userProvisioning');

const router = express.Router();

// List members for a client (synthetic id)
router.get('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const { client_id } = req.query
  const entityFilter = req.query?.entity_filter || req.query?.entity_id || null
  if (!client_id) return res.status(400).json({ error: 'client_id_required', code: 'CLIENT_ID_REQUIRED', detail: null, hint: null, request_id })

  let scopedClientIds = [String(client_id).trim()].filter(Boolean)
  let entityScope = { entitiesById: {} }
  if (entityFilter) {
    const resolved = await resolveEntityFilter({
      db: supabaseAdmin,
      req,
      clientId: client_id,
      entityFilter,
      requestId: request_id
    })
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body)
    scopedClientIds = resolved.clientIds
    entityScope = resolved
  }

  let query = supabaseAdmin
    .from('client_members')
    .select('client_id,user_id,email,name,role,created_at')
    .order('created_at', { ascending: false })
  if (scopedClientIds.length === 1) query = query.eq('client_id', scopedClientIds[0])
  else query = query.in('client_id', scopedClientIds)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: 'list_members_failed', detail: error.message })

  const entityMap = { ...(entityScope.entitiesById || {}), ...(await loadEntityMap(supabaseAdmin, scopedClientIds)) }
  const items = (data || []).map(m => {
    const baseId = m.user_id || m.email
    return withEntityFields({
      ...m,
      id: baseId,
      row_id: `${m.client_id}:${baseId || m.email || m.created_at || 'member'}`
    }, entityMap, m.client_id)
  })
  res.json({ items })
})

// Add a client member
router.post('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, email, name } = req.body || {}
  const role = (req.body?.role || 'member').toLowerCase()
  const request_id = req.request_id || null
  if (!client_id || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required' })

  let userId = null
  let actionLink = null
  let method = null
  try {
    const ensured = await ensureUserIdAndRecoveryLink(email, buildClientPwResetUrl({ origin: 'admin' }), {
      requireActionLink: true
    })
    userId = ensured?.userId || null
    actionLink = ensured?.actionLink || null
    method = ensured?.method || null
  } catch (e) {
    console.error('[admin/client-members] ensure_recovery_failed', {
      request_id,
      error: e?.message || e,
      code: e?.code,
      status: e?.status || null
    })
    if (e?.code === 'add_member_no_user_id') {
      return res.status(400).json({
        error: 'add_member_failed',
        detail: e?.detail || 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        request_id,
        code: e.code
      })
    }
    return res.status(500).json({
      error: 'add_member_failed',
      detail: e?.detail || e?.message || 'add_member_failed',
      request_id,
      code: e?.code || 'add_member_failed',
      helper_status: e?.status || null
    })
  }

  if (!userId) {
    console.error('add_member_no_user_id', { email, method })
    return res.status(400).json({
      error: 'add_member_failed',
      detail: 'Could not create or locate user for this email.',
      hint: 'Try again or send the magic link manually.'
    })
  }

  try {
    const emailResult = await sendMemberRecoveryEmail(email, actionLink, name)
    if (emailResult?.statusCode !== 202) {
      const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed')
      err.code = 'send_member_recovery_email_failed'
      err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed'
      throw err
    }
  } catch (e) {
    return res.status(500).json({
      error: 'add_member_failed',
      detail: e?.detail || e?.message || 'add_member_failed',
      request_id,
      code: e?.code || 'add_member_failed'
    })
  }

  const payload = { client_id, email, name, role, user_id: userId }

  const { data, error } = await supabaseAdmin
    .from('client_members')
    .insert(payload)
    .select('client_id,user_id,email,name,role,created_at')
    .single()

  if (error) {
    console.error('add_member_insert_failed:', error.message)
    return res.status(500).json({ error: 'add_member_failed', detail: error.message })
  }

  const m = data
  res.json({ item: { ...m, id: m.user_id || m.email } })
})

router.post('/client-members/batch', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const normalizeRequiredString = (value) => String(value || '').trim()
  const normalizeRole = (value) => {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    return normalized === 'superadmin' ? 'super_admin' : normalized
  }
  const dedupeClientIds = (values) => {
    const seen = new Set()
    const ids = []
    for (const value of values || []) {
      const clientId = normalizeRequiredString(value)
      if (!clientId || seen.has(clientId)) continue
      seen.add(clientId)
      ids.push(clientId)
    }
    return ids
  }
  const isDuplicateMembershipError = (error) => error?.code === '23505' || error?.code === 'PGRST116'
  const loadExistingMemberClientIds = async ({ clientIds, email, userId = null }) => {
    const existing = new Set()
    const byEmail = supabaseAdmin
      .from('client_members')
      .select('client_id')
      .in('client_id', clientIds)
      .eq('email', email)
    const { data: emailRows, error: emailError } = await byEmail
    if (emailError) throw emailError
    for (const row of emailRows || []) {
      if (row?.client_id) existing.add(String(row.client_id))
    }

    if (userId) {
      const { data: userRows, error: userError } = await supabaseAdmin
        .from('client_members')
        .select('client_id')
        .in('client_id', clientIds)
        .eq('user_id', userId)
      if (userError) throw userError
      for (const row of userRows || []) {
        if (row?.client_id) existing.add(String(row.client_id))
      }
    }

    return existing
  }

  try {
    const clientIds = dedupeClientIds(Array.isArray(req.body?.client_ids) ? req.body.client_ids : [])
    const email = normalizeRequiredString(req.body?.email)
    const name = normalizeRequiredString(req.body?.name)
    const role = normalizeRole(req.body?.role || 'member')

    if (!Array.isArray(req.body?.client_ids) || clientIds.length === 0) {
      return res.status(400).json({ error: 'client_ids_required', request_id })
    }
    if (clientIds.length > 50) {
      return res.status(400).json({
        error: 'too_many_client_ids',
        detail: 'Batch member assignment is limited to 50 client scopes.',
        request_id
      })
    }
    if (!email || !name) {
      return res.status(400).json({ error: 'client_id_email_name_required', request_id })
    }
    if (!['member', 'manager', 'super_admin'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role', request_id })
    }

    const itemByClientId = new Map(clientIds.map((clientId) => [clientId, { client_id: clientId, ok: false, status: 'pending' }]))

    let existingClientIds
    try {
      existingClientIds = await loadExistingMemberClientIds({ clientIds, email })
    } catch (e) {
      return res.status(500).json({
        error: 'existing_members_lookup_failed',
        detail: e?.message || 'existing_members_lookup_failed',
        request_id,
        code: e?.code || 'existing_members_lookup_failed'
      })
    }

    for (const clientId of existingClientIds) {
      itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' })
    }

    const needsUserClientIds = clientIds.filter((clientId) => !existingClientIds.has(clientId))
    if (needsUserClientIds.length === 0) {
      return res.json({
        ok: true,
        created_user: false,
        email_sent: false,
        items: clientIds.map((clientId) => itemByClientId.get(clientId)),
        request_id
      })
    }

    let userId = null
    let actionLink = null
    let method = null
    try {
      const ensured = await ensureUserIdAndRecoveryLink(email, buildClientPwResetUrl({ origin: 'admin' }), {
        requireActionLink: true
      })
      userId = ensured?.userId || null
      actionLink = ensured?.actionLink || null
      method = ensured?.method || null
    } catch (e) {
      console.error('[admin/client-members/batch] ensure_recovery_failed', {
        request_id,
        error: e?.message || e,
        code: e?.code,
        status: e?.status || null
      })
      if (e?.code === 'add_member_no_user_id') {
        return res.status(400).json({
          error: 'add_member_failed',
          detail: e?.detail || 'Could not create or locate user for this email.',
          hint: 'Try again or send the magic link manually.',
          request_id,
          code: e.code
        })
      }
      return res.status(500).json({
        error: 'add_member_failed',
        detail: e?.detail || e?.message || 'add_member_failed',
        request_id,
        code: e?.code || 'add_member_failed',
        helper_status: e?.status || null
      })
    }

    if (!userId) {
      console.error('[admin/client-members/batch] add_member_no_user_id', { request_id, email, method })
      return res.status(400).json({
        error: 'add_member_failed',
        detail: 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        request_id
      })
    }

    try {
      existingClientIds = await loadExistingMemberClientIds({ clientIds, email, userId })
    } catch (e) {
      return res.status(500).json({
        error: 'existing_members_lookup_failed',
        detail: e?.message || 'existing_members_lookup_failed',
        request_id,
        code: e?.code || 'existing_members_lookup_failed'
      })
    }

    for (const clientId of existingClientIds) {
      itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' })
    }

    const insertClientIds = clientIds.filter((clientId) => !existingClientIds.has(clientId))
    if (insertClientIds.length === 0) {
      return res.json({
        ok: true,
        created_user: method === 'createUser',
        email_sent: false,
        items: clientIds.map((clientId) => itemByClientId.get(clientId)),
        request_id
      })
    }

    try {
      const emailResult = await sendMemberRecoveryEmail(email, actionLink, name)
      if (emailResult?.statusCode !== 202) {
        const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed')
        err.code = 'send_member_recovery_email_failed'
        err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed'
        throw err
      }
    } catch (e) {
      return res.status(500).json({
        error: 'add_member_failed',
        detail: e?.detail || e?.message || 'add_member_failed',
        request_id,
        code: e?.code || 'add_member_failed'
      })
    }

    for (const clientId of insertClientIds) {
      const payload = { client_id: clientId, email, name, role, user_id: userId }
      const { data, error } = await supabaseAdmin
        .from('client_members')
        .insert(payload)
        .select('client_id,user_id,email,name,role,created_at')
        .single()

      if (error) {
        console.error('[admin/client-members/batch] add_member_insert_failed:', {
          request_id,
          client_id: clientId,
          error: error.message,
          code: error.code,
          hint: error.hint
        })
        if (isDuplicateMembershipError(error)) {
          itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' })
        } else {
          itemByClientId.set(clientId, {
            client_id: clientId,
            ok: false,
            status: 'failed',
            detail: error.message,
            code: error.code || 'add_member_failed'
          })
        }
        continue
      }

      itemByClientId.set(clientId, {
        client_id: clientId,
        ok: true,
        status: 'created',
        item: { ...data, id: data.user_id || data.email }
      })
    }

    return res.json({
      ok: true,
      created_user: method === 'createUser',
      email_sent: true,
      items: clientIds.map((clientId) => itemByClientId.get(clientId)),
      request_id
    })
  } catch (e) {
    console.error('[admin/client-members/batch] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({
      error: 'server_error',
      detail: e?.message || 'server_error',
      request_id,
      code: e?.code || 'server_error'
    })
  }
})

router.post('/send-password-reset', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const email = String(req.body?.email || '').trim()
  if (!email) return res.status(400).json({ error: 'email_required', request_id })
  const diagPrefix = '[admin/send-password-reset][diag]'
  const redirectTo = buildClientPwResetUrl({ origin: 'admin' })

  try {
    console.log(`${diagPrefix} start`, {
      request_id,
      email,
      redirectTo
    })

    let ensured = null
    try {
      ensured = await ensureUserIdAndRecoveryLink(email, redirectTo, {
        requireActionLink: true
      })
    } catch (e) {
      console.error(`${diagPrefix} helper_failed`, {
        request_id,
        email,
        redirectTo,
        error: e?.message || e,
        code: e?.code || null,
        status: e?.status || null
      })
      throw e
    }

    const actionLink = ensured?.actionLink || null
    let actionLinkHost = null
    let actionLinkPath = null
    let actionLinkContainsPwreset = false
    let actionLinkContainsRedirectTo = false
    if (actionLink) {
      actionLinkContainsPwreset =
        String(actionLink).includes('/pwreset') ||
        String(actionLink).toLowerCase().includes('%2fpwreset')
      actionLinkContainsRedirectTo =
        String(actionLink).includes('redirect_to=') ||
        String(actionLink).toLowerCase().includes('redirect_to%3d')
      try {
        const parsed = new URL(actionLink)
        actionLinkHost = parsed.host || null
        actionLinkPath = parsed.pathname || null
      } catch (_) {}
    }

    console.log(`${diagPrefix} link_generated`, {
      request_id,
      email,
      redirectTo,
      action_link_present: Boolean(actionLink),
      action_link_host: actionLinkHost,
      action_link_path: actionLinkPath,
      action_link_contains_pwreset: actionLinkContainsPwreset,
      action_link_contains_redirect_to: actionLinkContainsRedirectTo
    })

    try {
      const emailResult = await sendMemberRecoveryEmail(email, actionLink, null)
      if (emailResult?.statusCode !== 202) {
        const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed')
        err.code = 'send_member_recovery_email_failed'
        err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed'
        throw err
      }
    } catch (e) {
      console.error(`${diagPrefix} mail_send_failed`, {
        request_id,
        email,
        redirectTo,
        action_link_present: Boolean(actionLink),
        action_link_host: actionLinkHost,
        action_link_path: actionLinkPath,
        error: e?.message || e,
        code: e?.code || null,
        status: e?.status || null
      })
      throw e
    }

    console.log(`${diagPrefix} success`, {
      request_id,
      email,
      redirectTo,
      action_link_host: actionLinkHost,
      action_link_path: actionLinkPath
    })
    return res.json({ ok: true, request_id })
  } catch (e) {
    return res.status(500).json({
      error: 'send_password_reset_failed',
      detail: e?.detail || e?.message || 'send_password_reset_failed',
      request_id,
      code: e?.code || 'send_password_reset_failed',
      helper_error_code: e?.code || null,
      helper_status: e?.status || null
    })
  }
})

// Remove a client member
router.delete('/client-members/:id', requireAuth, requireAdmin, async (req, res) => {
  const key = req.params.id
  const client_id = req.query.client_id || null

  let q = supabaseAdmin.from('client_members').delete()
  if (key.includes('@')) q = q.eq('email', key)
  else q = q.eq('user_id', key)
  if (client_id) q = q.eq('client_id', client_id)

  const { error } = await q
  if (error) return res.status(500).json({ error: 'remove_member_failed', detail: error.message })
  res.json({ ok: true })
})


module.exports = router;
