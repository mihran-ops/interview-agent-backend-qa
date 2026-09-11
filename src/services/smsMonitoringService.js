'use strict';

const RANGE_HOURS = Object.freeze({
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function configured(value) {
  return String(value || '').trim().length > 0;
}

function boundedToken(value, fallback = 'not_recorded') {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_:-]{1,80}$/.test(normalized) ? normalized : fallback;
}

function normalizeRange(value) {
  const range = String(value || '7d').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(RANGE_HOURS, range)) {
    const error = new Error('Time range must be 24h, 7d, or 30d.');
    error.status = 400;
    error.code = 'invalid_sms_monitoring_range';
    throw error;
  }
  return range;
}

function normalizeClientId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === 'all') return null;
  if (!UUID_RE.test(normalized)) {
    const error = new Error('Client scope is invalid.');
    error.status = 400;
    error.code = 'invalid_sms_monitoring_scope';
    throw error;
  }
  return normalized;
}

function runtimePosture(env = process.env) {
  const complianceStatus = boundedToken(env.SMS_COMPLIANCE_REVIEW_STATUS);
  const recognizedComplianceStatus = ['approved', 'pending', 'not_recorded'].includes(complianceStatus)
    ? complianceStatus
    : 'not_recorded';
  const allowedCountries = String(env.SMS_ALLOWED_COUNTRIES || '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value))
    .slice(0, 10);
  const dailyCap = Number(env.SMS_DAILY_SPEND_CAP_CENTS);
  const telnyxWebhookSigningConfigured = configured(env.TELNYX_WEBHOOK_PUBLIC_KEY);
  return Object.freeze({
    delivery_enabled: enabled(env.SMS_ENABLED),
    candidate_ui_enabled: enabled(env.SMS_CANDIDATE_UI_ENABLED),
    environment: boundedToken(env.SMS_ENVIRONMENT),
    provider: boundedToken(env.SMS_PROVIDER),
    sender_configured: configured(env.TELNYX_SENDER_E164),
    outbound_credentials_configured: configured(env.TELNYX_API_KEY),
    delivery_webhook_signing_configured: telnyxWebhookSigningConfigured,
    // Telnyx signs both delivery and inbound message events with the same
    // Ed25519 public key; no second shared secret is required or accepted.
    inbound_webhook_signing_configured: telnyxWebhookSigningConfigured,
    inbound_webhook_secret_configured: telnyxWebhookSigningConfigured,
    lookup_enabled: enabled(env.SMS_LOOKUP_ENABLED),
    lookup_provider: boundedToken(env.SMS_LOOKUP_PROVIDER),
    spend_cap_cents: Number.isInteger(dailyCap) && dailyCap > 0 ? dailyCap : null,
    abuse_secret_configured: configured(env.SMS_ABUSE_HMAC_SECRET),
    consent_copy_version: configured(env.SMS_CONSENT_COPY_VERSION)
      ? String(env.SMS_CONSENT_COPY_VERSION).trim().slice(0, 80)
      : null,
    allowed_countries: allowedCountries,
    compliance_review: {
      status: recognizedComplianceStatus,
      version: configured(env.SMS_COMPLIANCE_REVIEW_VERSION)
        ? String(env.SMS_COMPLIANCE_REVIEW_VERSION).trim().slice(0, 80)
        : null,
      reviewed_at: /^\d{4}-\d{2}-\d{2}T/.test(String(env.SMS_COMPLIANCE_REVIEWED_AT || ''))
        ? String(env.SMS_COMPLIANCE_REVIEWED_AT).slice(0, 40)
        : null,
      legal_review_required: recognizedComplianceStatus !== 'approved',
    },
  });
}

function createSmsMonitoringService({ db, env = process.env, now = () => new Date() } = {}) {
  if (!db || typeof db.rpc !== 'function') throw new TypeError('SMS monitoring requires a database client.');
  return Object.freeze({
    async snapshot(query = {}) {
      const range = normalizeRange(query.range);
      const clientId = normalizeClientId(query.client_id);
      const since = new Date(now().getTime() - RANGE_HOURS[range] * 60 * 60 * 1000).toISOString();
      const [monitoringResponse, retentionResponse] = await Promise.all([
        db.rpc('service_get_sms_monitoring_snapshot', {
          p_since: since,
          p_client_id: clientId,
        }),
        db.rpc('service_get_sms_retention_snapshot'),
      ]);
      const { data, error } = monitoringResponse;
      if (error || retentionResponse.error) {
        const serviceError = new Error('SMS monitoring data is temporarily unavailable.');
        serviceError.code = 'sms_monitoring_unavailable';
        serviceError.cause = error || retentionResponse.error;
        throw serviceError;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        const serviceError = new Error('SMS monitoring response was incomplete.');
        serviceError.code = 'sms_monitoring_unavailable';
        throw serviceError;
      }
      const retention = retentionResponse.data;
      if (!retention || typeof retention !== 'object' || Array.isArray(retention)) {
        const serviceError = new Error('SMS monitoring response was incomplete.');
        serviceError.code = 'sms_monitoring_unavailable';
        throw serviceError;
      }
      return Object.freeze({
        ...data,
        retention,
        range,
        client_id: clientId,
        runtime: runtimePosture(env),
      });
    },
  });
}

module.exports = {
  RANGE_HOURS,
  createSmsMonitoringService,
  normalizeClientId,
  normalizeRange,
  runtimePosture,
};
