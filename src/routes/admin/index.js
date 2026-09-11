'use strict';

// The admin router. The three injected sub-routers mount first, as they did in
// app.js, then the extracted route groups, then billing and accommodation
// requests, whose mounts stay wrapped so a load failure degrades those endpoints
// rather than the whole service. The route groups carry disjoint path prefixes,
// so the order between them cannot change which handler answers a request.

const express = require('express');
const { createAdminInterviewReliabilityRouter } = require('../../../routes/adminInterviewReliability');
const { createAdminSmsMonitoringRouter } = require('../../../routes/adminSmsMonitoring');
const { createInterviewRecoveryRouter } = require('../../../routes/interviewRecovery');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router = express.Router();

// Candidate replacement authorization is deliberately separate from the
// legacy candidate CRUD handlers: it is admin-only, client/role-bound, and
// writes an immutable reset event through the Phase B RPC.
router.use('/interview-recovery', requireAuth, requireAdmin, createInterviewRecoveryRouter())
router.use('/interview-reliability', requireAuth, requireAdmin, createAdminInterviewReliabilityRouter())
router.use('/sms-monitoring', requireAuth, requireAdmin, createAdminSmsMonitoringRouter())

router.use(require('./metrics'));
router.use(require('./publicAnalytics'));
router.use(require('./publicPurchases'));
router.use(require('./automation'));
router.use(require('./clients'));
router.use(require('./entities'));
router.use(require('./contracts'));
router.use(require('./audit'));
router.use(require('./billing'));
router.use(require('./roles'));
router.use(require('./candidates'));
router.use(require('./reports'));
router.use(require('./members'));

// Mount admin sub-routers (Billing + Accommodation Requests)
try {
  router.use('/billing', requireAuth, requireAdmin, require('../../../routes/adminBilling'))
} catch (e) {
  console.error('[mount] Failed to load routes/adminBilling:', e?.message || e)
}
try {
  router.use('/accommodation-requests', requireAuth, requireAdmin, require('../../../routes/accommodationRequests'))
} catch (_) {}

module.exports = router;
