'use strict';

const express = require('express');

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeFullName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function createProfileRouter({ db }) {
  const router = express.Router();

  router.patch('/sync', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const userId = String(req.user?.id || '').trim();
    const verifiedEmail = String(req.user?.email || '').trim().toLowerCase();
    const hasFullName = Object.prototype.hasOwnProperty.call(req.body || {}, 'full_name');
    const fullName = hasFullName ? normalizeFullName(req.body.full_name) : null;

    if (!USER_ID_RE.test(userId) || !EMAIL_RE.test(verifiedEmail)) {
      return res.status(401).json({ error: 'invalid_authenticated_profile' });
    }
    if (hasFullName && (!fullName || fullName.length > 120)) {
      return res.status(400).json({
        error: 'invalid_full_name',
        detail: 'Name must be between 1 and 120 characters.',
      });
    }
    if (!db?.from) {
      return res.status(503).json({ error: 'profile_sync_unavailable' });
    }

    try {
      const updatePayload = { email: verifiedEmail };
      if (hasFullName) updatePayload.name = fullName;
      const { data, error } = await db
        .from('client_members')
        .update(updatePayload)
        .or(`user_id.eq.${userId},user_id_uuid.eq.${userId}`)
        .select('client_id');

      if (error) {
        console.error('[auth-profile] member profile sync failed', {
          code: String(error.code || 'profile_sync_failed'),
        });
        return res.status(503).json({ error: 'profile_sync_failed' });
      }

      return res.json({
        item: {
          full_name: fullName,
          email: verifiedEmail,
          name_updated: hasFullName,
          memberships_updated: Array.isArray(data) ? data.length : 0,
        },
      });
    } catch (error) {
      console.error('[auth-profile] member profile sync failed', {
        code: String(error?.code || 'profile_sync_failed'),
      });
      return res.status(503).json({ error: 'profile_sync_failed' });
    }
  });

  return router;
}

module.exports = {
  createProfileRouter,
  normalizeFullName,
};
