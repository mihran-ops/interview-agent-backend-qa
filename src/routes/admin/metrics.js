'use strict';

// Admin dashboard metrics. Mounted on the admin router.

const express = require('express');
const { buildAdminMetricsPayload, safeErrorBody } = require('../../lib/adminMetricsService');
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { sendAdminError } = require('../../services/admin/adminHelpers');

const router = express.Router();

// Read-only internal metrics foundation. This route intentionally returns counts
// and sanitized operational summaries, not raw tokens, webhook payloads, or links.
router.get('/metrics', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await buildAdminMetricsPayload({
      db: supabaseAdmin,
      req,
      query: req.query || {},
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safeErrorBody(error, request_id)
    console.error('[admin/metrics] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})


module.exports = router;
