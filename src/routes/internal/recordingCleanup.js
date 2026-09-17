'use strict';

// Cron entry point that removes recordings with no substantive content.

const express = require('express');

const { supabaseAdmin } = require('../../clients/supabase');
const { cleanupNoSubstantiveRecordings } = require('../../services/recordingCleanup');
const { secretsMatch } = require('../../services/secretCompare');

const router = express.Router();

router.post('/recordings/cleanup', async (req, res) => {
  const expectedSecret = String(process.env.RECORDING_CLEANUP_CRON_SECRET || process.env.CONTRACTS_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!secretsMatch(providedSecret, expectedSecret)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  try {
    const result = await cleanupNoSubstantiveRecordings({ db: supabaseAdmin, logger: console })
    return res.json({
      ok: true,
      scanned: result.scanned,
      deleted: result.deleted,
      skipped: result.skipped,
      failed: result.failed
    })
  } catch (e) {
    console.error('[recording-cleanup] unexpected', { error: e?.message || e })
    return res.status(500).json({
      error: 'recording_cleanup_failed',
      detail: e?.message || 'recording_cleanup_failed'
    })
  }
})

module.exports = router;
