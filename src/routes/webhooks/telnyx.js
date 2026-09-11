'use strict';

const express = require('express');
const { destinationFingerprint } = require('../../services/otpChallenge');
const { recordAnyOtpSmsDeliveryEvent } = require('../../services/retailSmsVerification');
const {
  activateSmsProviderBreaker,
  recordSmsInboundControlEvent,
} = require('../../services/smsOtpFoundation');
const {
  TelnyxWebhookError,
  parseTelnyxWebhook,
  verifyTelnyxWebhook,
} = require('../../services/telnyxWebhook');

function createTelnyxSmsWebhookRouter({
  db = null,
  env = process.env,
  now = () => Date.now(),
  recordDeliveryEvent = recordAnyOtpSmsDeliveryEvent,
  recordControlEvent = recordSmsInboundControlEvent,
  activateProviderBreaker = activateSmsProviderBreaker,
  fingerprintDestination = destinationFingerprint,
  logger = null,
} = {}) {
  const router = express.Router();
  router.post('/', async (req, res) => {
    const publicKey = String(env.TELNYX_WEBHOOK_PUBLIC_KEY || '').trim();
    if (!publicKey) return res.status(503).json({ ok: false });
    try {
      const receivedAtMs = now();
      verifyTelnyxWebhook({
        rawBody: req.body,
        signature: req.get('telnyx-signature-ed25519'),
        timestamp: req.get('telnyx-timestamp'),
        publicKey,
        now: receivedAtMs,
      });
      const event = parseTelnyxWebhook(req.body);
      if (event.ignored) return res.status(200).json({ ok: true });
      const selectedDb = db || require('../../clients/supabase').supabaseAdmin;
      let result;
      if (event.kind === 'control') {
        const fingerprint = fingerprintDestination(event.fromE164, undefined, env, 'sms');
        result = await recordControlEvent(selectedDb, {
          provider: event.provider,
          providerEventId: event.eventId,
          providerEventAt: event.occurredAt,
          destinationFingerprint: fingerprint,
          action: event.action,
        });
      } else if (event.kind === 'provider_breaker') {
        await activateProviderBreaker(selectedDb, {
          provider: event.provider,
          providerEventId: event.eventId,
          providerEventAt: event.occurredAt,
        });
        result = { applied: true, replayed: false };
      } else {
        result = await recordDeliveryEvent(selectedDb, {
          provider: event.provider,
          providerMessageId: event.messageId,
          providerEventId: event.eventId,
          providerEventAt: event.occurredAt,
          deliveryStatus: event.status,
        });
      }
      if (logger && typeof logger.info === 'function') {
        const providerEventAtMs = Date.parse(String(event.occurredAt || ''));
        logger.info('sms_provider_callback', {
          provider: 'telnyx',
          event_kind: event.kind,
          event_type: event.eventType,
          status: event.status || null,
          control_action: event.action || null,
          found: result.found === true,
          applied: result.applied === true,
          replayed: result.replayed === true,
          provider_event_age_ms: Number.isFinite(providerEventAtMs)
            ? Math.max(0, receivedAtMs - providerEventAtMs)
            : null,
        });
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      if (error instanceof TelnyxWebhookError) {
        const status = ['invalid_signature', 'stale_signature'].includes(error.code) ? 403 : 400;
        return res.status(status).json({ ok: false });
      }
      return res.status(503).json({ ok: false });
    }
  });
  return router;
}

const router = createTelnyxSmsWebhookRouter({ logger: console });
module.exports = router;
module.exports.createTelnyxSmsWebhookRouter = createTelnyxSmsWebhookRouter;
