'use strict';

// Admin-triggered contract renewal processing. Mounted on the admin router.

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { processContractRenewals } = require('../../services/contracts/contractRenewals');

const router = express.Router();

router.post('/contracts/process-renewals', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await processContractRenewals({
      triggerSource: 'admin',
      requestId: req.request_id || null,
      triggeredByUserId: req.user?.id || null,
      triggeredByEmail: req.user?.email || null
    })
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'process_contracts_failed', detail: e?.detail || e?.message || 'process_contracts_failed' })
  }
})


module.exports = router;
