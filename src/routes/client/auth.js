'use strict';

// Session identity: the auth ping, the caller profile, and the profile router.
// Mounted at the application root, so the paths here are absolute.

const express = require('express');
const { createProfileRouter } = require('./profile');
const { buildClientScopeContext } = require('../../services/clientScope');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const { uniqueClientIds } = require('../../services/clientScope/clientScope');
const { clientScopeMetadata, loadClientScopeContextForResponse } = require('../../services/clientScope/tenancy');

const router = express.Router();

router.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, user: req.user, client_ids: req.clientIds })
})

// ---------- Auth me ----------
router.get('/auth/me', requireAuth, withClientScope, async (req, res) => {
  let scopeContext = null
  try {
    scopeContext = await loadClientScopeContextForResponse(req)
  } catch (_) {
    scopeContext = buildClientScopeContext({ memberships: req.memberships || [], clients: [] })
  }

  const effectiveClientIds = uniqueClientIds(req.effectiveClientIds || req.clientIds || [])
  const assignedClientIds = uniqueClientIds(req.assignedClientIds || [])
  const memberships = (req.effectiveMemberships || req.memberships || []).map(m => ({
    ...m,
    ...clientScopeMetadata(scopeContext, m.client_id),
  }))
  const assignedMemberships = (req.assignedMemberships || req.directMemberships || []).map(m => ({
    ...m,
    ...clientScopeMetadata(scopeContext, m.client_id),
  }))

  return res.json({
    user: {
      id: req.user?.id || null,
      email: req.user?.email || null,
    },
    isGlobalAdmin: req.isGlobalAdmin === true,
    client_scope: {
      client_ids: effectiveClientIds,
      client_ids_count: effectiveClientIds.length,
      memberships,
      default_client_id: req.query?.client_id || null,
      assigned_client_ids: assignedClientIds,
      accessible_client_ids: effectiveClientIds,
      assigned_memberships: assignedMemberships,
    }
  })
})

router.use('/auth/profile', requireAuth, withClientScope, createProfileRouter({ db: supabaseAdmin }))


module.exports = router;
