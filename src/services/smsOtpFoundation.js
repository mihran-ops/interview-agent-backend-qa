'use strict';

const SMS_ALLOWED_COUNTRIES = Object.freeze(['US']);
const SMS_LINE_TYPES = Object.freeze(['mobile', 'landline', 'voip', 'unknown']);

function normalizeSmsLineType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SMS_LINE_TYPES.includes(normalized) ? normalized : 'unknown';
}

function lineTypeAllowsSms(value) {
  return normalizeSmsLineType(value) === 'mobile';
}

async function isSmsDestinationSuppressed(db, destinationFingerprint, scope = 'authentication') {
  const fingerprint = String(destinationFingerprint || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) return true;
  if (!/^[a-z0-9_:-]{1,40}$/.test(String(scope || ''))) return true;
  if (!db || typeof db.rpc !== 'function') return true;
  const { data, error } = await db.rpc('service_is_sms_destination_suppressed', {
    p_destination_fingerprint: fingerprint,
    p_scope: scope,
  });
  if (error) return true;
  return data === true;
}

async function recordSmsInboundControlEvent(db, {
  provider,
  providerEventId,
  providerEventAt,
  destinationFingerprint,
  action,
} = {}) {
  if (!db || typeof db.rpc !== 'function') throw new Error('SMS_CONTROL_STORE_UNAVAILABLE');
  const { data, error } = await db.rpc('service_record_sms_inbound_control_event', {
    p_provider: provider,
    p_provider_event_id: providerEventId,
    p_provider_event_at: providerEventAt,
    p_destination_fingerprint: destinationFingerprint,
    p_action: action,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') throw new Error('SMS_CONTROL_STORE_EMPTY');
  return Object.freeze({
    applied: row.applied === true,
    replayed: row.replayed === true,
    suppressed: row.suppressed === true,
    released: row.released === true,
  });
}

async function activateSmsProviderBreaker(db, { provider, providerEventId, providerEventAt } = {}) {
  if (!db || typeof db.rpc !== 'function') throw new Error('SMS_BREAKER_STORE_UNAVAILABLE');
  const { error } = await db.rpc('service_activate_sms_provider_breaker', {
    p_provider: provider,
    p_source_event_id: providerEventId,
    p_activated_at: providerEventAt,
  });
  if (error) throw error;
  return true;
}

function getSmsOtpEligibility(candidate, {
  bindingValid = true,
  architectureAvailable = true,
  suppressed = false,
  lineType = null,
  lookupEnabled = false,
  lookupFailed = false,
} = {}) {
  const country = String(candidate?.phone_country_code || '').trim().toUpperCase();
  const phoneE164 = String(candidate?.phone_e164 || '').trim();
  let reason = null;

  if (!bindingValid) reason = 'invalid_binding';
  else if (!architectureAvailable) reason = 'architecture_unavailable';
  else if (!/^\+[1-9]\d{7,14}$/.test(phoneE164)) reason = 'canonical_phone_missing';
  else if (!SMS_ALLOWED_COUNTRIES.includes(country)) reason = 'country_not_supported';
  else if (suppressed) reason = 'destination_suppressed';
  else if (lookupEnabled && lookupFailed) reason = 'lookup_failed';
  else if (lookupEnabled && !lineTypeAllowsSms(lineType)) reason = 'line_type_ineligible';

  return Object.freeze({
    eligible: reason === null,
    reason,
    country: country || null,
    phone_present: Boolean(phoneE164),
    delivery_enabled: false,
  });
}

module.exports = {
  SMS_ALLOWED_COUNTRIES,
  SMS_LINE_TYPES,
  activateSmsProviderBreaker,
  getSmsOtpEligibility,
  isSmsDestinationSuppressed,
  lineTypeAllowsSms,
  normalizeSmsLineType,
  recordSmsInboundControlEvent,
};
