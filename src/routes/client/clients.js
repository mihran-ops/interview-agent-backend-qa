'use strict';

// The list of clients the caller can act on.
// Mounted at the application root, so the paths here are absolute.

const express = require('express');
const { buildClientScopeContext } = require('../../lib/clientScope');
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const { uniqueClientIds } = require('../../services/clientScope/clientScope');
const { clientScopeMetadata, loadClientScopeContextForResponse } = require('../../services/clientScope/tenancy');

const router = express.Router();

// ---------- Clients: my ----------
router.get('/clients/my', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = uniqueClientIds(req.effectiveClientIds || req.clientIds || [])
    if (ids.length === 0) return res.json({ items: [] })

    const { data: clients, error } = await supabaseAdmin
      .from('clients')
      .select('id, name, parent_client_id, entity_label, archived_at')
      .in('id', ids)
    if (error) return res.status(500).json({ error: 'Failed to load clients', detail: error.message })

    const activeClients = (clients || []).filter((client) => (
      !String(client?.parent_client_id || '').trim() ||
      !String(client?.archived_at || '').trim()
    ))

    let scopeContext = null
    try {
      scopeContext = await loadClientScopeContextForResponse(req, activeClients)
    } catch (_) {
      scopeContext = buildClientScopeContext({ memberships: req.memberships || [], clients: activeClients })
    }

    const membershipById = Object.fromEntries((req.effectiveMemberships || req.memberships || []).map(m => [m.client_id, m]))
    const items = activeClients.map((c) => {
      const membership = membershipById[c.id] || {}
      const inherited = membership.inherited === true
      return {
        client_id: c.id,
        name: c.name,
        role: membership.role || 'member',
        inherited,
        inherited_from_client_id: inherited ? (membership.inherited_from_client_id || c.parent_client_id || null) : null,
        ...clientScopeMetadata(scopeContext, c.id),
      }
    })
    res.json({
      items,
      assigned_client_ids: uniqueClientIds(req.assignedClientIds || []),
      accessible_client_ids: activeClients.map((client) => client.id).filter(Boolean),
    })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})


module.exports = router;
