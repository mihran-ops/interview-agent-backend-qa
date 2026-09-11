// src/middleware/auth.js
const { supabaseAdmin, supabaseAnon } = require('../clients/supabase');
const { buildClientScopeContext } = require('../services/clientScope');

const supabase = supabaseAdmin;
const ROLE_PRIORITY = ['super_admin', 'owner', 'admin', 'manager', 'member', 'tester'];
const PARENT_CHILD_EXPANSION_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);

/**
 * Extract a bearer token from:
 *  - Authorization: Bearer <token>
 *  - Cookie: sb-access-token=<token> (or sb:token)
 */
function getToken(req) {
  const hdr = req.header('authorization') || req.header('Authorization') || '';
  if (hdr.startsWith('Bearer ')) return hdr.slice(7).trim();

  // Very light cookie parse to avoid bringing a dependency
  const rawCookie = req.headers.cookie || '';
  if (rawCookie) {
    for (const part of rawCookie.split(';')) {
      const [k, v] = part.split('=').map(s => (s || '').trim());
      if (!k) continue;
      if (k === 'sb-access-token' || k === 'sb:token') return decodeURIComponent(v || '');
    }
  }
  return null;
}

async function lookupGlobalAdmin(userEmail, userId) {
  if (!supabase) return false;
  try {
    if (userEmail) {
      const { data, error } = await supabase
        .from('admins')
        .select('id')
        .eq('email', userEmail)
        .eq('is_active', true)
        .maybeSingle();
      if (!error && data) return true;
    }
    if (userId) {
      const { data, error } = await supabase
        .from('admins')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();
      if (!error && data) return true;
    }
  } catch (err) {
    console.error('[requireAuth] admin lookup error', err);
  }
  return false;
}

function normalizeClientRole(role) {
  const normalized = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'superadmin' ? 'super_admin' : normalized;
}

function uniqueValues(values) {
  return Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
}

function strongestRole(roles, fallback = 'member') {
  const roleSet = new Set((roles || []).map(normalizeClientRole).filter(Boolean));
  for (const role of ROLE_PRIORITY) {
    if (roleSet.has(role)) return role;
  }
  return normalizeClientRole(fallback) || 'member';
}

/**
 * Auth middleware
 * - Verifies the Supabase access token with Supabase Auth before trusting identity
 * - Attaches req.user and req.userToken
 */
async function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const authClient = supabaseAnon || supabaseAdmin;
    if (!authClient?.auth?.getUser) {
      console.error('[requireAuth] Supabase auth client not configured.');
      return res.status(500).json({ error: 'Server not configured' });
    }

    const { data, error } = await authClient.auth.getUser(token);
    const authUser = data?.user || null;
    if (error || !authUser?.id) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = {
      id: authUser.id,
      email: authUser.email || null
    };
    req.userToken = token;
    req.isGlobalAdmin = await lookupGlobalAdmin(req.user.email, req.user.id);
    req.isAdmin = req.isGlobalAdmin;
    return next();
  } catch (err) {
    console.error('[requireAuth] error', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

/**
 * Client scope middleware
 * - Works with client_members.user_id_uuid (new) OR client_members.user_id (legacy)
 * - Attaches:
 *     req.client_memberships: string[] of client_ids
 *     req.clientScope: { user, memberships, defaultClientId? }
 *     req.client: { id, name? }
 */
async function withClientScope(req, res, next) {
  try {
    if (!supabase) {
      console.error('[withClientScope] Supabase client not configured.');
      return res.status(500).json({ error: 'Server not configured' });
    }
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const explicit = req.query.client_id || req.body?.client_id || null;

    if (req.isGlobalAdmin === true) {
      if (explicit) {
        req.client_memberships = [explicit];
        req.clientIds = [explicit];
        req.assignedClientIds = [explicit];
        req.effectiveClientIds = [explicit];
        req.memberships = [{ client_id: explicit, role: 'admin', name: null }];
        req.assignedMemberships = req.memberships;
        req.directMemberships = req.assignedMemberships;
        req.effectiveMemberships = req.memberships;
        req.clientScope = {
          user: req.user,
          memberships: req.effectiveMemberships,
          assignedMemberships: req.assignedMemberships,
          assignedClientIds: req.assignedClientIds,
          accessibleClientIds: req.effectiveClientIds,
          effectiveClientIds: req.effectiveClientIds,
          effectiveMemberships: req.effectiveMemberships,
          defaultClientId: explicit,
          default_client_id: explicit
        };
        req.client = { id: explicit, name: null };
        req.membership = { role: 'admin' };
        return next();
      }

      const { data: clients, error: clientsErr } = await supabase
        .from('clients')
        .select('id, name, parent_client_id, entity_label, archived_at')
        .is('archived_at', null)
        .limit(5000);
      if (clientsErr) {
        console.error('[withClientScope] admin clients lookup error', clientsErr);
        req.client_memberships = [];
        req.clientIds = [];
        req.assignedClientIds = [];
        req.effectiveClientIds = [];
        req.memberships = [];
        req.assignedMemberships = [];
        req.directMemberships = [];
        req.effectiveMemberships = [];
        req.clientScope = { user: req.user, memberships: [], assignedMemberships: [], assignedClientIds: [], accessibleClientIds: [], effectiveClientIds: [], effectiveMemberships: [] };
        return next();
      }

      const memberships = (clients || []).map(c => ({
        client_id: c.id,
        role: 'admin',
        name: c.name || null,
      }));
      const ids = memberships.map(m => m.client_id).filter(Boolean);
      req.client_memberships = ids;
      req.clientIds = ids;
      req.assignedClientIds = ids;
      req.effectiveClientIds = ids;
      req.memberships = memberships;
      req.assignedMemberships = memberships;
      req.directMemberships = memberships;
      req.effectiveMemberships = memberships;
      const defaultClientId = ids.length ? ids[0] : null;
      req.clientScope = {
        user: req.user,
        memberships,
        assignedMemberships: memberships,
        assignedClientIds: ids,
        accessibleClientIds: ids,
        effectiveClientIds: ids,
        effectiveMemberships: memberships,
        defaultClientId,
        default_client_id: defaultClientId
      };
      if (defaultClientId) {
        const m = memberships.find(x => x.client_id === defaultClientId) || null;
        req.client = { id: defaultClientId, name: m?.name || null };
        req.membership = { role: 'admin' };
      }
      return next();
    }

    // Try modern column first
    let rows = [];
    let { data, error } = await supabase
      .from('client_members')
      .select('client_id, role, user_id_uuid, clients ( id, name, parent_client_id, entity_label, archived_at )')
      .eq('user_id_uuid', userId)
      .limit(5000);

    // Retry with legacy column if schema differs
    if (error && error.code === '42703') {
      const retry = await supabase
        .from('client_members')
        .select('client_id, role, user_id, clients ( id, name, parent_client_id, entity_label, archived_at )')
        .eq('user_id', userId)
        .limit(5000);
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      console.error('[withClientScope] lookup error', error);
      // Don’t block every request due to a read failure; attach empty context
      req.client_memberships = [];
      req.clientIds = [];
      req.assignedClientIds = [];
      req.effectiveClientIds = [];
      req.memberships = [];
      req.assignedMemberships = [];
      req.directMemberships = [];
      req.effectiveMemberships = [];
      req.clientScope = { user: req.user, memberships: [], assignedMemberships: [], assignedClientIds: [], accessibleClientIds: [], effectiveClientIds: [], effectiveMemberships: [] };
      return next();
    }

    rows = Array.isArray(data) ? data : [];
    const memberships = rows.map(r => ({
      client_id: r.client_id,
      role: normalizeClientRole(r.role || 'member'),
      name: r.clients?.name || null,
      client: r.clients || null,
    }));

    const ids = uniqueValues(memberships.map(m => m.client_id));
    const directClients = rows.map(r => r.clients).filter(Boolean);
    const parentExpansionIds = uniqueValues(
      memberships
        .filter(m => PARENT_CHILD_EXPANSION_ROLES.has(m.role) && !m.client?.parent_client_id)
        .map(m => m.client_id)
    );
    let childClients = [];
    if (parentExpansionIds.length) {
      const { data: childData, error: childError } = await supabase
        .from('clients')
        .select('id, name, parent_client_id, entity_label, archived_at')
        .in('parent_client_id', parentExpansionIds)
        .is('archived_at', null)
        .limit(5000);
      if (childError) {
        console.error('[withClientScope] child client expansion error', childError);
      } else if (Array.isArray(childData)) {
        childClients = childData;
      }
    }

    const scopeContext = buildClientScopeContext({
      memberships,
      clients: directClients.concat(childClients),
    });
    const effectiveIds = uniqueValues(scopeContext.accessibleClientIds || ids);
    const effectiveMemberships = effectiveIds.map((clientId) => {
      const assigned = memberships.find(m => m.client_id === clientId) || null;
      const client = scopeContext.clientById?.[clientId] || assigned?.client || null;
      const roles = scopeContext.effectiveRolesByClientId?.[clientId] || (assigned ? [assigned.role] : []);
      const role = strongestRole(roles, assigned?.role || 'member');
      const inheritedFrom = assigned ? null : String(client?.parent_client_id || '').trim() || null;
      return {
        client_id: clientId,
        role,
        name: assigned?.name || client?.name || null,
        inherited: !!inheritedFrom,
        inherited_from_client_id: inheritedFrom,
        client
      };
    });

    req.client_memberships = effectiveIds;
    req.clientIds = effectiveIds;
    req.assignedClientIds = ids;
    req.effectiveClientIds = effectiveIds;
    req.memberships = effectiveMemberships;
    req.assignedMemberships = memberships;
    req.directMemberships = memberships;
    req.effectiveMemberships = effectiveMemberships;

    // Decide default
    let defaultClientId = null;
    if (explicit && effectiveIds.includes(explicit)) {
      defaultClientId = explicit;
    } else if (effectiveIds.length) {
      defaultClientId = effectiveIds[0];
    }

    // Attach helpers for routes that expect them
    req.clientScope = {
      ...scopeContext,
      user: req.user,
      memberships: effectiveMemberships,
      assignedMemberships: memberships,
      assignedClientIds: ids,
      accessibleClientIds: effectiveIds,
      effectiveClientIds: effectiveIds,
      effectiveMemberships,
      defaultClientId,
      default_client_id: defaultClientId
    };
    if (defaultClientId) {
      const m = effectiveMemberships.find(x => x.client_id === defaultClientId) || effectiveMemberships[0] || null;
      req.client = { id: defaultClientId, name: m?.name || null };
      req.membership = m ? { role: m.role } : null;
    }

    // IMPORTANT: we no longer hard-403 when user has zero memberships here.
    // Let routes decide whether to 403 or show an empty state.
    return next();
  } catch (err) {
    console.error('[withClientScope] error', err);
    req.client_memberships = [];
    req.clientIds = [];
    req.assignedClientIds = [];
    req.effectiveClientIds = [];
    req.memberships = [];
    req.assignedMemberships = [];
    req.directMemberships = [];
    req.effectiveMemberships = [];
    req.clientScope = { user: req.user, memberships: [], assignedMemberships: [], assignedClientIds: [], accessibleClientIds: [], effectiveClientIds: [], effectiveMemberships: [] };
    return next();
  }
}

module.exports = { requireAuth, withClientScope, supabase };
