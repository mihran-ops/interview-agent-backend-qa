'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { supabaseAdmin } = require('../../clients/supabase');
const { processSalesIntegrationDeliveries } = require('../../services/salesIntegrations');

function secretMatches(actual, expected) {
  const actualDigest = crypto.createHash('sha256').update(String(actual || '')).digest();
  const expectedDigest = crypto.createHash('sha256').update(String(expected || '')).digest();
  return Boolean(expected) && crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function createInternalSalesIntegrationsRouter(options = {}) {
  const router = express.Router();
  const db = options.db || supabaseAdmin;
  const processor = options.processor || processSalesIntegrationDeliveries;
  const env = options.env || process.env;
  const logger = options.logger || console;

  router.post('/process', async (req, res) => {
    const expectedSecret = String(env.SALES_INTEGRATIONS_RUNNER_SECRET || '').trim();
    const providedSecret = String(req.get('x-cron-secret') || '').trim();
    if (!secretMatches(providedSecret, expectedSecret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const result = await processor({ db, env, logger });
      return res.json(result);
    } catch (error) {
      logger.error?.('[sales-integrations] worker_failed', { error: error?.message || error });
      return res.status(500).json({
        error: 'sales_integrations_worker_failed',
        request_id: req.request_id || null
      });
    }
  });

  return router;
}

module.exports = {
  createInternalSalesIntegrationsRouter,
  secretMatches
};
