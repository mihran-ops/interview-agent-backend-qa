'use strict';

const express = require('express');
const { createInterviewReliabilityReadService } = require('../../services/interviewReliabilityReadService');

function sendBoundedError(res, error, requestId) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : 'interview_reliability_unavailable';
  const detail = status >= 500
    ? 'Interview reliability data is temporarily unavailable.'
    : String(error?.message || 'The request could not be completed.').slice(0, 180);
  return res.status(status).json({
    error: code,
    detail,
    request_id: requestId || null,
  });
}

function requireSuperAdmin(req, res, next) {
  if (req?.isGlobalAdmin !== true) {
    return res.status(403).json({
      error: 'super_admin_required',
      detail: 'Super Admin access is required.',
      request_id: req?.request_id || null,
    });
  }
  return next();
}

function createAdminInterviewReliabilityRouter({
  service = null,
} = {}) {
  const router = express.Router();
  const activeService = service || createInterviewReliabilityReadService({
    db: require('../../clients/supabase').supabaseAdmin,
  });
  router.use(requireSuperAdmin);

  router.get('/', async (req, res) => {
    const requestId = req.request_id || null;
    try {
      const payload = await activeService.list(req.query || {});
      res.set('Cache-Control', 'no-store');
      return res.json(payload);
    } catch (error) {
      console.error('[admin/interview-reliability] bounded_failure', {
        request_id: requestId,
        code: typeof error?.code === 'string' ? error.code : 'interview_reliability_unavailable',
      });
      return sendBoundedError(res, error, requestId);
    }
  });

  router.get('/:interviewId', async (req, res) => {
    const requestId = req.request_id || null;
    try {
      const payload = await activeService.detail(req.params?.interviewId, req.query || {});
      res.set('Cache-Control', 'no-store');
      return res.json(payload);
    } catch (error) {
      console.error('[admin/interview-reliability] bounded_failure', {
        request_id: requestId,
        code: typeof error?.code === 'string' ? error.code : 'interview_reliability_unavailable',
      });
      return sendBoundedError(res, error, requestId);
    }
  });

  return router;
}

module.exports = {
  createAdminInterviewReliabilityRouter,
  requireSuperAdmin,
  sendBoundedError,
};
