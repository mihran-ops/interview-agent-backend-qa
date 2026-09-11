// routes/webhook.js

const express = require('express');
const { authenticateTavusWebhookRequest } = require('../src/lib/tavusWebhookAuth');
const tavusEvents = require('../src/services/tavusEvents');

const router = express.Router();

router.get('/_ping', (_req, res) => res.json({ ok: true }));

const parseTavusWebhookJson = express.json({ limit: '10mb' });

function handleTavusWebhookJsonError(error, _req, res, next) {
  if (!error) return next();
  console.warn('[webhook] tavus_webhook_payload_rejected', {
    validation_category: 'invalid_root',
    identifier_present: false,
    identifier_conflict: false,
    event_type: null,
  });
  return res.status(400).json({
    ok: false,
    error: 'invalid_webhook_payload',
  });
}

// Primary webhook entry
router.post(
  '/tavus',
  authenticateTavusWebhookRequest,
  parseTavusWebhookJson,
  handleTavusWebhookJsonError,
  tavusEvents.handleTavusWebhookEvent,
);

module.exports = router;
// Kept on the router so the existing tests reach the service through the same
// handle they used when the pipeline lived in this file.
router._setTavusHttpClientForTest = tavusEvents.setTavusHttpClientForTest;
router._setSupabaseAdminForTest = tavusEvents.setSupabaseAdminForTest;
router._test = tavusEvents._test;
