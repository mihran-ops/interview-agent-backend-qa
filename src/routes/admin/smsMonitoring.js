'use strict';

const express = require('express');
const { createSmsMonitoringService } = require('../../services/smsMonitoringService');

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

function boundedError(res, error, requestId) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : 'sms_monitoring_unavailable';
  return res.status(status).json({
    error: code,
    detail: status >= 500
      ? 'SMS monitoring data is temporarily unavailable.'
      : String(error?.message || 'The request could not be completed.').slice(0, 180),
    request_id: requestId || null,
  });
}

function createAdminSmsMonitoringRouter({ service = null } = {}) {
  const router = express.Router();
  const activeService = service || createSmsMonitoringService({
    db: require('../../clients/supabase').supabaseAdmin,
  });
  router.use(requireSuperAdmin);
  router.get('/', async (req, res) => {
    const requestId = req.request_id || null;
    try {
      const payload = await activeService.snapshot(req.query || {});
      res.set('Cache-Control', 'no-store');
      return res.json(payload);
    } catch (error) {
      console.error('[admin/sms-monitoring] bounded_failure', {
        request_id: requestId,
        code: typeof error?.code === 'string' ? error.code : 'sms_monitoring_unavailable',
      });
      return boundedError(res, error, requestId);
    }
  });
  return router;
}

module.exports = {
  createAdminSmsMonitoringRouter,
};
