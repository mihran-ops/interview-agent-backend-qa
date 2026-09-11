'use strict';

// Cron entry point for contract renewal processing. Guarded by a shared secret
// header rather than a user session, because the caller is the scheduler.

const express = require('express');

const { processContractRenewals } = require('../../services/contracts/contractRenewals');

const router = express.Router();

router.post('/contracts/process-renewals', async (req, res) => {
  const expectedSecret = String(process.env.CONTRACTS_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const result = await processContractRenewals({
      triggerSource: 'cron',
      requestId: req.request_id || null
    })
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'process_contracts_failed', detail: e?.detail || e?.message || 'process_contracts_failed' })
  }
})

module.exports = router;
