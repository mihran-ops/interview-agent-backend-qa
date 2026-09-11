'use strict';

const express = require('express');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const { supabaseAdmin } = require('../../clients/supabase');
const { loadEntityMap, resolveEntityFilter, uniqueIds, withEntityFields } = require('../../services/entityScopeFilter');
const { ensureUserAndSendRecovery, redactEmail } = require('../../services/recoveryHelper');
const { sendMemberRecoveryEmail } = require('../../clients/sendgrid');
const crypto = require('crypto');
const { buildClientPwResetUrl } = require('../../config/urlConfig');

const router = express.Router();

function parseAccepted(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function readTesterAckAt(row) {
  if (!row || typeof row !== 'object') return null;
  return row.tester_acknowledged_at || row.tester_ack_at || null;
}

function hasCol(row, col) {
  return !!row && Object.prototype.hasOwnProperty.call(row, col);
}

async function ensureMembershipRow(clientId, userId) {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('client_members')
    .select('*')
    .eq('client_id', clientId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;

  let inserted = null;
  let insertError = null;

  ({ data: inserted, error: insertError } = await supabaseAdmin
    .from('client_members')
    .insert({ client_id: clientId, user_id: userId, role: 'tester' })
    .select('*')
    .single());

  if (insertError && insertError.code === '23514') {
    ({ data: inserted, error: insertError } = await supabaseAdmin
      .from('client_members')
      .insert({ client_id: clientId, user_id: userId, role: 'member' })
      .select('*')
      .single());
  }

  if (insertError) throw insertError;
  return inserted;
}

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return first.trim();
  }

  if (Array.isArray(xff) && xff.length > 0 && String(xff[0] || '').trim()) {
    return String(xff[0]).trim();
  }

  return req.ip || null;
}

function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'superadmin' ? 'super_admin' : normalized;
}

function findEffectiveMembership(req, clientId) {
  const targetClientId = String(clientId || '').trim();
  if (!targetClientId) return null;
  const memberships = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships
    : Array.isArray(req?.effectiveMemberships)
      ? req.effectiveMemberships
      : Array.isArray(req?.memberships)
        ? req.memberships
        : [];
  return memberships.find((m) => String(m?.client_id || '').trim() === targetClientId) || null;
}

function getEffectiveRole(req, clientId) {
  return normalizeRole(findEffectiveMembership(req, clientId)?.role);
}

function isManageCapableRole(role) {
  return ['manager', 'admin', 'owner', 'super_admin'].includes(normalizeRole(role));
}

function isHighPrivilegeRole(role) {
  return ['admin', 'owner', 'super_admin'].includes(normalizeRole(role));
}

function canManageMembers(req, clientId) {
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return true;
  return isManageCapableRole(getEffectiveRole(req, clientId));
}

function canManageTargetRole(actorRole, targetRole) {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(targetRole);
  if (actor === 'manager' && isHighPrivilegeRole(target)) return false;
  return true;
}

function normalizeRequiredString(value) {
  return String(value || '').trim();
}

function dedupeClientIds(values) {
  const seen = new Set();
  const ids = [];
  for (const value of values || []) {
    const clientId = normalizeRequiredString(value);
    if (!clientId || seen.has(clientId)) continue;
    seen.add(clientId);
    ids.push(clientId);
  }
  return ids;
}

function isDuplicateMembershipError(error) {
  return error?.code === '23505' || error?.code === 'PGRST116';
}

async function loadExistingMemberClientIds({ clientIds, userId, email }) {
  const existing = new Set();
  if (!Array.isArray(clientIds) || clientIds.length === 0) return existing;

  if (userId) {
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id')
      .in('client_id', clientIds)
      .eq('user_id', userId);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.client_id) existing.add(String(row.client_id));
    }
  }

  if (email) {
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id')
      .in('client_id', clientIds)
      .eq('email', email);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.client_id) existing.add(String(row.client_id));
    }
  }

  return existing;
}

async function applyTesterAck(clientId, userId, ipAddress) {
  const nowIso = new Date().toISOString();
  const row = await ensureMembershipRow(clientId, userId);

  const updatePayload = {};
  if (hasCol(row, 'tester_acknowledged_at')) updatePayload.tester_acknowledged_at = nowIso;
  if (hasCol(row, 'tester_acknowledged_ip')) updatePayload.tester_acknowledged_ip = ipAddress;
  if (hasCol(row, 'tester_ack')) updatePayload.tester_ack = true;
  if (hasCol(row, 'tester_ack_version')) updatePayload.tester_ack_version = 'v1';
  if (hasCol(row, 'tester_ack_at')) updatePayload.tester_ack_at = nowIso;

  if (Object.keys(updatePayload).length === 0) {
    return row;
  }

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('client_members')
    .update(updatePayload)
    .eq('client_id', clientId)
    .eq('user_id', userId)
    .select('*')
    .single();

  if (updateError) throw updateError;
  return updated;
}

router.get('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || null;
    const clientId = req.query.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    if (!clientId) return res.status(400).json({ error: 'client_id_required', request_id });

    const entityScope = await resolveEntityFilter({
      db: supabaseAdmin,
      req,
      clientId,
      entityFilter: req.query.entity_filter || req.query.entity_id || null,
      requestId: request_id
    });
    if (!entityScope.ok) return res.status(entityScope.status).json(entityScope.body);

    const requestedClientIds = entityScope.clientIds.length ? entityScope.clientIds : [clientId];
    let memberClientIds = uniqueIds(requestedClientIds).filter((id) => canManageMembers(req, id));
    if (!memberClientIds.length) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'CLIENT_SCOPE_MISMATCH',
        detail: 'You do not have permission to manage members for the requested entity scope.',
        hint: null,
        request_id
      });
    }

    let query = supabaseAdmin
      .from('client_members')
      .select('client_id,user_id,email,name,role,created_at,tester_acknowledged_at,tester_acknowledged_ip')
      .order('created_at', { ascending: false });
    if (memberClientIds.length === 1) query = query.eq('client_id', memberClientIds[0]);
    else query = query.in('client_id', memberClientIds);

    const { data, error } = await query;

    if (error) {
      console.error('[client-members] list error', error.message);
      return res.status(500).json({ error: 'list_members_failed', detail: error.message, request_id });
    }

    const entityMap = { ...(entityScope.entitiesById || {}), ...(await loadEntityMap(supabaseAdmin, memberClientIds)) };
    const items = (data || []).map((m) => {
      const baseId = m.user_id || m.email;
      return withEntityFields({
        ...m,
        id: baseId,
        row_id: `${m.client_id}:${baseId || m.email || m.created_at || 'member'}`
      }, entityMap, m.client_id);
    });
    res.json({ items, request_id });
  } catch (e) {
    const request_id = req.request_id || null;
    console.error('[client-members] unexpected', e?.message || e);
    res.status(500).json({ error: 'server_error', request_id });
  }
});

router.get('/me', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const clientId = req.client?.id || req.clientScope?.defaultClientId || req.query.client_id || null;
    const userId = req.user?.id || null;
    if (!clientId) return res.status(400).json({ error: 'client_id_required', request_id });
    if (!userId) return res.status(401).json({ error: 'unauthorized', request_id });

    const membership = findEffectiveMembership(req, clientId);
    const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true;
    if (!isGlobalAdmin && !membership) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }

    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id,user_id,role,created_at,tester_acknowledged_at,tester_acknowledged_ip')
      .eq('client_id', clientId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[client-members/me] fetch_failed', { request_id, error: error.message, code: error.code });
      return res.status(500).json({ error: 'fetch_member_failed', detail: error.message, code: error.code, request_id });
    }
    const member = data || null;
    const effectiveMembership = membership || null;
    return res.json({
      ok: true,
      member,
      role: member?.role || null,
      effective_role: effectiveMembership?.role || member?.role || null,
      inherited: effectiveMembership?.inherited === true,
      inherited_from_client_id: effectiveMembership?.inherited_from_client_id || null,
      effective_membership: effectiveMembership,
      tester_acknowledged_at: member?.tester_acknowledged_at || null,
      tester_acknowledged_ip: member?.tester_acknowledged_ip || null,
      request_id
    });
  } catch (e) {
    console.error('[client-members/me] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', request_id });
  }
});

router.post('/batch', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || null;
    const clientIds = dedupeClientIds(Array.isArray(req.body?.client_ids) ? req.body.client_ids : []);
    const email = normalizeRequiredString(req.body?.email);
    const name = normalizeRequiredString(req.body?.name);
    const role = normalizeRole(req.body?.role || 'member');

    if (!Array.isArray(req.body?.client_ids) || clientIds.length === 0) {
      return res.status(400).json({ error: 'client_ids_required', request_id });
    }
    if (clientIds.length > 50) {
      return res.status(400).json({ error: 'too_many_client_ids', detail: 'Batch member assignment is limited to 50 client scopes.', request_id });
    }
    if (!email || !name) {
      return res.status(400).json({ error: 'client_id_email_name_required', request_id });
    }
    if (!['member', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role', request_id });
    }

    const itemByClientId = new Map(clientIds.map((clientId) => [clientId, { client_id: clientId, ok: false, status: 'pending' }]));
    const manageableClientIds = [];

    for (const clientId of clientIds) {
      if (canManageMembers(req, clientId)) {
        manageableClientIds.push(clientId);
      } else {
        itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'forbidden' });
      }
    }

    if (manageableClientIds.length === 0) {
      return res.status(403).json({
        error: 'forbidden',
        detail: 'No manageable client scopes were provided.',
        items: clientIds.map((clientId) => itemByClientId.get(clientId)),
        request_id
      });
    }

    const existingByEmail = await loadExistingMemberClientIds({ clientIds: manageableClientIds, email });
    for (const clientId of existingByEmail) {
      itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' });
    }

    const needsUserClientIds = manageableClientIds.filter((clientId) => !existingByEmail.has(clientId));
    if (needsUserClientIds.length === 0) {
      return res.json({
        ok: true,
        created_user: false,
        email_sent: false,
        items: clientIds.map((clientId) => itemByClientId.get(clientId)),
        request_id
      });
    }

    const { userId, method, actionLink } = await ensureUserAndSendRecovery({
      email,
      redirectTo: buildClientPwResetUrl(),
      request_id,
      loggerPrefix: '[client-members/scoped-batch]'
    });
    if (!userId) {
      console.error('[client-members/scoped-batch] add_member_no_user_id', { request_id, email: redactEmail(email), method });
      return res.status(400).json({
        error: 'add_member_failed',
        detail: 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        request_id
      });
    }

    const existingByUserOrEmail = await loadExistingMemberClientIds({ clientIds: manageableClientIds, userId, email });
    for (const clientId of existingByUserOrEmail) {
      itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' });
    }

    const insertClientIds = manageableClientIds.filter((clientId) => !existingByUserOrEmail.has(clientId));
    if (insertClientIds.length === 0) {
      return res.json({
        ok: true,
        created_user: method === 'createUser',
        email_sent: false,
        items: clientIds.map((clientId) => itemByClientId.get(clientId)),
        request_id
      });
    }

    const emailResult = await sendMemberRecoveryEmail(email, actionLink, name);
    if (emailResult?.statusCode !== 202) {
      const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed');
      err.code = 'send_member_recovery_email_failed';
      err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed';
      throw err;
    }

    for (const clientId of insertClientIds) {
      const payload = { client_id: clientId, email, name, role, user_id: userId };
      const { data, error } = await supabaseAdmin
        .from('client_members')
        .insert(payload)
        .select('client_id,user_id,email,name,role,created_at')
        .single();

      if (error) {
        console.error('[client-members/scoped-batch] add_member_insert_failed', {
          request_id,
          client_id: clientId,
          error: error.message,
          code: error.code,
          hint: error.hint
        });
        if (isDuplicateMembershipError(error)) {
          itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' });
        } else {
          itemByClientId.set(clientId, {
            client_id: clientId,
            ok: false,
            status: 'failed',
            detail: error.message,
            code: error.code || 'add_member_failed'
          });
        }
        continue;
      }

      itemByClientId.set(clientId, {
        client_id: clientId,
        ok: true,
        status: 'created',
        item: { ...data, id: data.user_id || data.email }
      });
    }

    return res.json({
      ok: true,
      created_user: method === 'createUser',
      email_sent: true,
      items: clientIds.map((clientId) => itemByClientId.get(clientId)),
      request_id
    });
  } catch (e) {
    if (e?.code === 'misconfigured_supabase_auth') {
      return res.status(500).json({ error: 'misconfigured_supabase_auth', detail: e.detail || 'Missing SUPABASE_PUBLIC_ANON_KEY', request_id: req.request_id || null });
    }
    if (e?.code === 'add_member_no_user_id') {
      return res.status(400).json({
        error: 'add_member_failed',
        detail: e?.detail || 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        request_id: req.request_id || null,
        code: e.code
      });
    }
    if (e?.code === 'recover_failed' || e?.code === 'create_user_failed' || e?.code === 'send_member_recovery_email_failed') {
      return res.status(500).json({
        error: e.code,
        detail: e?.detail || e?.message || e.code,
        request_id: req.request_id || null,
        code: e.code,
        helper_status: e?.status || null
      });
    }
    console.error('[client-members/batch] unexpected', { request_id: req.request_id || null, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', request_id: req.request_id || null, code: 'server_error' });
  }
});

router.post('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const { client_id, email, name } = req.body || {};
    const role = normalizeRole(req.body?.role || 'member');
    const clientId = client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    const request_id = req.request_id || null;

    if (!clientId || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required', request_id });

    if (!canManageMembers(req, clientId)) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }
    if (!['member', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role', request_id });
    }

    const { userId, method, actionLink, recovery_sent } = await ensureUserAndSendRecovery({
      email,
      redirectTo: buildClientPwResetUrl(),
      request_id,
      loggerPrefix: '[client-members/scoped-add]'
    });
    if (!userId) {
      console.error('[client-members/scoped-add] add_member_no_user_id', { request_id, email: redactEmail(email), method });
      return res.status(400).json({
        error: 'add_member_failed',
        detail: 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        request_id
      });
    }

    const emailResult = await sendMemberRecoveryEmail(email, actionLink, name);
    if (emailResult?.statusCode !== 202) {
      const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed');
      err.code = 'send_member_recovery_email_failed';
      err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed';
      throw err;
    }

    const payload = { client_id: clientId, email, name, role, user_id: userId };
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .insert(payload)
      .select('client_id,user_id,email,name,role,created_at')
      .single();

    if (error) {
      console.error('[client-members/scoped-add] add_member_insert_failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      if (error.code === '23505' || error.code === 'PGRST116') {
        return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id });
      }
      return res.status(500).json({ error: 'add_member_failed', detail: error.message, hint: error.hint, code: error.code, request_id });
    }

    const m = data;
    res.json({ item: { ...m, id: m.user_id || m.email }, request_id });
  } catch (e) {
    if (e?.code === 'misconfigured_supabase_auth') {
      return res.status(500).json({ error: 'misconfigured_supabase_auth', detail: e.detail || 'Missing SUPABASE_PUBLIC_ANON_KEY', request_id: req.request_id || null });
    }
    if (e?.code === 'email_in_use') {
      console.warn('[client-members/scoped-add] email_in_use', { email: redactEmail(req.body?.email), request_id: req.request_id || null });
      return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id: req.request_id || null });
    }
    if (e?.code === 'add_member_no_user_id') {
      return res.status(400).json({
        error: 'add_member_failed',
        detail: e?.detail || 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        request_id: req.request_id || null,
        code: e.code
      });
    }
    if (e?.code === 'recover_failed' || e?.code === 'create_user_failed' || e?.code === 'send_member_recovery_email_failed') {
      return res.status(500).json({
        error: e.code,
        detail: e?.detail || e?.message || e.code,
        request_id: req.request_id || null,
        code: e.code,
        helper_status: e?.status || null
      });
    }
    console.error('[client-members/add] unexpected', { request_id: req.request_id || null, error: e?.message || e });
    res.status(500).json({ error: 'server_error', request_id: req.request_id || null, code: 'server_error' });
  }
});

router.post('/send-password-reset', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || null;
    const clientId = req.body?.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    const email = String(req.body?.email || '').trim();
    if (!clientId || !email) return res.status(400).json({ error: 'client_id_and_email_required', request_id });

    const actorRole = getEffectiveRole(req, clientId);
    if (!canManageMembers(req, clientId)) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }

    const { data: existingMember, error: lookupErr } = await supabaseAdmin
      .from('client_members')
      .select('email,name,role')
      .eq('client_id', clientId)
      .eq('email', email)
      .maybeSingle();
    if (lookupErr) {
      return res.status(500).json({ error: 'member_lookup_failed', detail: lookupErr.message, request_id });
    }
    if (!existingMember) {
      return res.status(404).json({ error: 'member_not_found', request_id });
    }
    if ((req.isGlobalAdmin !== true && req.isAdmin !== true) && !canManageTargetRole(actorRole, existingMember.role)) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }

    const memberName = String(existingMember.name || req.body?.name || email).trim() || email;
    const { userId, method, actionLink } = await ensureUserAndSendRecovery({
      email,
      redirectTo: buildClientPwResetUrl(),
      request_id,
      loggerPrefix: '[client-members/send-password-reset]'
    });
    if (!userId) {
      console.error('[client-members/send-password-reset] add_member_no_user_id', { request_id, email: redactEmail(email), method });
      return res.status(400).json({
        error: 'send_password_reset_failed',
        detail: 'Could not create or locate user for this email.',
        request_id
      });
    }

    const emailResult = await sendMemberRecoveryEmail(email, actionLink, memberName);
    if (emailResult?.statusCode !== 202) {
      const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed');
      err.code = 'send_member_recovery_email_failed';
      err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed';
      throw err;
    }

    return res.json({ ok: true, request_id });
  } catch (e) {
    if (e?.code === 'recover_failed' || e?.code === 'create_user_failed' || e?.code === 'send_member_recovery_email_failed') {
      return res.status(500).json({
        error: 'send_password_reset_failed',
        detail: e?.detail || e?.message || 'send_password_reset_failed',
        request_id: req.request_id || null,
        code: e?.code || 'send_password_reset_failed',
        helper_status: e?.status || null
      });
    }
    return res.status(500).json({
      error: 'send_password_reset_failed',
      detail: e?.message || 'send_password_reset_failed',
      request_id: req.request_id || null,
      code: e?.code || 'send_password_reset_failed'
    });
  }
});

router.delete('/:id', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || null;
    const key = req.params.id;
    const client_id = req.query.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    if (!client_id) return res.status(400).json({ error: 'client_id_required', request_id });

    const actorRole = getEffectiveRole(req, client_id);
    if (!canManageMembers(req, client_id)) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }

    let targetLookup = supabaseAdmin
      .from('client_members')
      .select('user_id,email,role')
      .eq('client_id', client_id);
    if (key.includes('@')) targetLookup = targetLookup.eq('email', key);
    else targetLookup = targetLookup.eq('user_id', key);

    const { data: targetMember, error: targetLookupError } = await targetLookup.maybeSingle();
    if (targetLookupError) {
      return res.status(500).json({ error: 'remove_member_failed', detail: targetLookupError.message, request_id });
    }
    if ((req.isGlobalAdmin !== true && req.isAdmin !== true) && !canManageTargetRole(actorRole, targetMember?.role)) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }

    // Block self-delete by either user id or email match.
    const currentUserId = String(req.user?.id || '').trim();
    const currentUserEmail = String(req.user?.email || '').trim().toLowerCase();
    const targetUserId = String(targetMember?.user_id || '').trim();
    const targetEmail = String(targetMember?.email || '').trim().toLowerCase();
    if (
      (currentUserId && targetUserId && targetUserId === currentUserId) ||
      (currentUserEmail && targetEmail && targetEmail === currentUserEmail)
    ) {
      console.error('[client/members/delete] self delete blocked', { request_id, user_id: req.user?.id, target_user_id: targetUserId });
      return res.status(403).json({
        error: 'not_allowed',
        code: 'self_delete_forbidden',
        detail: 'Not allowed to delete yourself',
        hint: 'A user cannot remove their own membership.',
        request_id
      });
    }

    let q = supabaseAdmin.from('client_members').delete();
    if (key.includes('@')) q = q.eq('email', key);
    else q = q.eq('user_id', key);
    q = q.eq('client_id', client_id);

    const { error } = await q;
    if (error) return res.status(500).json({ error: 'remove_member_failed', detail: error.message, request_id });
    res.json({ ok: true, request_id });
  } catch (e) {
    const request_id = req.request_id || null;
    console.error('[client-members/delete] unexpected', e?.message || e);
    res.status(500).json({ error: 'server_error', request_id });
  }
});

router.get('/tester-ack', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || null;
    const clientId = req.client?.id || req.clientScope?.defaultClientId || req.query.client_id || req.body?.client_id || null;
    const userId = req.user?.id || null;

    if (!clientId) return res.status(400).json({ error: 'client_id_required', request_id });
    if (!userId) return res.status(401).json({ error: 'unauthorized', request_id });

    const { data: row, error } = await supabaseAdmin
      .from('client_members')
      .select('tester_acknowledged_at,tester_acknowledged_ip,tester_ack,tester_ack_at')
      .eq('client_id', clientId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('[tester-ack] get failed', error.message);
      return res.status(500).json({ error: 'tester_ack_fetch_failed', detail: error.message, request_id });
    }

    const testerAckAt = readTesterAckAt(row);
    const acknowledged = Boolean(testerAckAt);
    return res.json({
      ok: true,
      acknowledged,
      tester_acknowledged_at: testerAckAt || null,
      tester_acknowledged_ip: row?.tester_acknowledged_ip || null,
      tester_ack_at: testerAckAt || null,
      request_id
    });
  } catch (e) {
    const request_id = req.request_id || null;
    console.error('[tester-ack] unexpected', e?.message || e);
    return res.status(500).json({ error: 'server_error', request_id });
  }
});

// Tester NDA acknowledgement
router.post('/tester-ack', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || null;
    const clientId = req.client?.id || req.clientScope?.defaultClientId || req.query.client_id || req.body?.client_id || null;
    const userId = req.user?.id || null;
    const accepted = parseAccepted(req.body?.accepted);
    const ipAddress = getClientIp(req);

    if (!clientId) return res.status(400).json({ error: 'client_id_required', request_id });
    if (!userId) return res.status(401).json({ error: 'unauthorized', request_id });
    if (!accepted) return res.status(400).json({ error: 'accepted_required', request_id });

    const updateRow = await applyTesterAck(clientId, userId, ipAddress);
    if (!updateRow) {
      return res.status(500).json({ error: 'tester_ack_failed', request_id });
    }
    return res.json({ ok: true });
  } catch (e) {
    const request_id = req.request_id || null;
    if (e?.message) {
      console.error('[tester-ack] update failed', e.message);
      return res.status(500).json({ error: 'tester_ack_failed', detail: e.message, request_id });
    }
    console.error('[tester-ack] unexpected', e?.message || e);
    return res.status(500).json({ error: 'server_error', request_id });
  }
});

module.exports = router;
