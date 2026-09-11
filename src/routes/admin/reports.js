'use strict';

// Admin-triggered report generation. Mounted on the admin router.

const express = require('express');
const { normalizeUuid } = require('../../lib/strictRequestValidation');
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router = express.Router();

// Generate candidate report from Admin dashboard (mirrors client dashboard /reports/generate)
router.post('/reports/generate', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const candidate_id = normalizeUuid(req.body?.candidate_id);
    if (candidate_id === null) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'INVALID_CANDIDATE_ID',
        detail: 'candidate_id must be a UUID.',
        hint: null,
        request_id
      });
    }

    const { data: cand, error: cErr } = await supabaseAdmin
      .from('candidates')
      .select('id, client_id')
      .eq('id', candidate_id)
      .maybeSingle();

    if (cErr) {
      console.error('[admin/reports/generate] candidate lookup failed', {
        request_id,
        candidate_id,
        code: cErr.code,
        message: cErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'CANDIDATE_LOOKUP_FAILED',
        detail: cErr.message,
        hint: cErr.hint || null,
        request_id
      });
    }

    if (!cand?.client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'CANDIDATE_NOT_FOUND',
        detail: 'Candidate not found',
        hint: null,
        request_id
      });
    }

    // Provide the same scoped context that /reports/* routes expect.
    req.clientIds = [cand.client_id];
    req.client_memberships = [cand.client_id];
    req.memberships = Array.isArray(req.memberships) && req.memberships.length
      ? req.memberships
      : [{ client_id: cand.client_id, role: 'admin' }];

    let reportsPdfRoutes;
    try {
      reportsPdfRoutes = require('../../../routes/reportsPdf');
    } catch (e) {
      console.error('[admin/reports/generate] require reportsPdf failed', { request_id, error: e?.message || e });
      return res.status(500).json({
        error: 'server_error',
        code: 'REPORTS_PDF_ROUTES_MISSING',
        detail: e?.message || 'Failed to load reportsPdf routes',
        hint: null,
        request_id
      });
    }

    const handler = reportsPdfRoutes && typeof reportsPdfRoutes._handleGenerate === 'function'
      ? reportsPdfRoutes._handleGenerate
      : null;

    if (!handler) {
      return res.status(500).json({
        error: 'server_error',
        code: 'REPORTS_PDF_HANDLER_MISSING',
        detail: 'reportsPdfRoutes._handleGenerate is not available',
        hint: null,
        request_id
      });
    }

    return handler(req, res);
  } catch (e) {
    console.error('[admin/reports/generate] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'GENERATE_REPORT_FAILED',
      detail: e?.message || 'Failed to generate report',
      hint: null,
      request_id
    });
  }
});


module.exports = router;
