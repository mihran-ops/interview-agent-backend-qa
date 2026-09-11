'use strict';

// Public funnel analytics and the lead captures behind them. Mounted on the admin router.

const express = require('express');
const {
  archivePublicLeadCapture,
  buildAdminPublicAnalyticsLeadsCsv,
  buildAdminPublicAnalyticsPayload,
  safePublicAnalyticsErrorBody,
  unarchivePublicLeadCapture,
  updatePublicLeadCaptureArchiveBatch,
} = require('../../services/adminPublicAnalyticsService');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { sendAdminError } = require('../../services/admin/adminHelpers');

const router = express.Router();

router.get('/public-analytics', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await buildAdminPublicAnalyticsPayload({
      db: supabaseAdmin,
      query: req.query || {},
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.get('/public-analytics/leads.csv', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await buildAdminPublicAnalyticsLeadsCsv({
      db: supabaseAdmin,
      query: req.query || {}
    })
    res.setHeader('Content-Type', payload.content_type)
    res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`)
    res.setHeader('X-Export-Row-Count', String(payload.row_count))
    res.setHeader('X-Export-Truncated', payload.truncated ? 'true' : 'false')
    return res.status(200).send(payload.csv)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads.csv] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.post('/public-analytics/leads/archive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await updatePublicLeadCaptureArchiveBatch({
      db: supabaseAdmin,
      leadIds: req.body?.lead_ids,
      archive: true,
      actorUserId: req.user?.id || null,
      reason: req.body?.reason || '',
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads/bulk-archive] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.post('/public-analytics/leads/unarchive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await updatePublicLeadCaptureArchiveBatch({
      db: supabaseAdmin,
      leadIds: req.body?.lead_ids,
      archive: false,
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads/bulk-unarchive] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.post('/public-analytics/leads/:id/archive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await archivePublicLeadCapture({
      db: supabaseAdmin,
      leadId: req.params.id,
      actorUserId: req.user?.id || null,
      reason: req.body?.reason || '',
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads/archive] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.post('/public-analytics/leads/:id/unarchive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await unarchivePublicLeadCapture({
      db: supabaseAdmin,
      leadId: req.params.id,
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads/unarchive] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})


module.exports = router;
