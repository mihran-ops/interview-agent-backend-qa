'use strict';

// Cron entry point that removes used and expired OTP tokens.

const express = require('express');

const { supabaseAdmin } = require('../../lib/supabaseClient');

const router = express.Router();

router.post('/otp/cleanup', async (req, res) => {
  const expectedSecret = String(process.env.OTP_CLEANUP_CRON_SECRET || process.env.CONTRACTS_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const nowIso = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from('otp_tokens')
      .delete()
      .or(`used.eq.true,expires_at.lt.${nowIso}`)
      .select('id')

    if (error) {
      return res.status(500).json({ error: 'otp_cleanup_failed', detail: error.message })
    }

    return res.json({
      ok: true,
      deleted_count: Array.isArray(data) ? data.length : 0
    })
  } catch (e) {
    return res.status(500).json({
      error: 'otp_cleanup_failed',
      detail: e?.detail || e?.message || 'otp_cleanup_failed'
    })
  }
})

module.exports = router;
