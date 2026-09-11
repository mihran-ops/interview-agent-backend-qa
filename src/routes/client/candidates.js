// routes/candidates.js
const express = require('express');
const router = express.Router();

const { requireAuth, withClientScope } = require('../../middleware/auth');
const { supabase } = require('../../clients/supabase');
const { loadEntityMap, resolveEntityFilter, uniqueIds, withEntityFields } = require('../../services/entityScopeFilter');

// Keep FE flexible for now
const CANDIDATE_SELECT = '*';

// GET /candidates?role_id=... OR /candidates?client_id=...
router.get('/', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.query.role_id || null;
    const clientId =
      req.query.client_id ||
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;

    if (!roleId && !clientId) return res.json({ candidates: [] });

    const entityScope = await resolveEntityFilter({
      db: supabase,
      req,
      clientId,
      entityFilter: req.query.entity_filter || req.query.entity_id || null,
      requestId: request_id
    });
    if (!entityScope.ok) return res.status(entityScope.status).json(entityScope.body);
    const scopedClientIds = entityScope.clientIds.length ? entityScope.clientIds : (clientId ? [clientId] : []);

    let query = supabase.from('candidates').select(CANDIDATE_SELECT);
    if (roleId)   query = query.eq('role_id', roleId);
    if (scopedClientIds.length === 1) query = query.eq('client_id', scopedClientIds[0]);
    else if (scopedClientIds.length > 1) query = query.in('client_id', scopedClientIds);
    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) {
      console.error('[GET /candidates] supabase error', error);
      return res.status(500).json({ error: 'Failed to fetch candidates', code: 'LIST_CANDIDATES_FAILED', detail: error.message, hint: error.hint || null, request_id });
    }

    const rows = data || [];
    const roleIds = uniqueIds(rows.map((row) => row.role_id));
    let roleClientById = {};
    if (roleIds.length) {
      let roleQuery = supabase
        .from('roles')
        .select('id,client_id')
        .in('id', roleIds);
      if (scopedClientIds.length === 1) roleQuery = roleQuery.eq('client_id', scopedClientIds[0]);
      else if (scopedClientIds.length > 1) roleQuery = roleQuery.in('client_id', scopedClientIds);
      const { data: roles, error: roleError } = await roleQuery;
      if (!roleError) {
        roleClientById = Object.fromEntries((roles || []).map((role) => [role.id, role.client_id]));
      }
    }

    const entityIds = rows.map((row) => roleClientById[row.role_id] || row.client_id);
    const entityMap = { ...(entityScope.entitiesById || {}), ...(await loadEntityMap(supabase, entityIds)) };
    const candidates = rows.map((row) => withEntityFields(row, entityMap, roleClientById[row.role_id] || row.client_id));
    return res.json({ candidates });
  } catch (e) {
    console.error('[GET /candidates] unexpected', e);
    return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR', detail: e?.message || null, hint: null, request_id });
  }
});

// GET /candidates/by-role/:roleId
router.get('/by-role/:roleId', requireAuth, withClientScope, async (req, res) => {
  try {
    const roleId = req.params.roleId;
    if (!roleId) return res.json({ candidates: [] });

    const { data, error } = await supabase
      .from('candidates')
      .select(CANDIDATE_SELECT)
      .eq('role_id', roleId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /candidates/by-role/:roleId] supabase error', error);
      return res.status(500).json({ error: 'Failed to fetch candidates' });
    }
    return res.json({ candidates: data || [] });
  } catch (e) {
    console.error('[GET /candidates/by-role/:roleId] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
