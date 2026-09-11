'use strict';

const crypto = require('node:crypto');
const { lookupSmsLineType } = require('./telnyxNumberLookup');

const DEFAULT_LIMITS = Object.freeze({
  cooldownMs: 30_000,
  resourceWindowMs: 15 * 60_000,
  resourceMax: 3,
  candidateWindowMs: 15 * 60_000,
  candidateMax: 3,
  destinationHourMs: 60 * 60_000,
  destinationHourMax: 5,
  destinationDayMs: 24 * 60 * 60_000,
  destinationDayMax: 10,
  ipHourMs: 60 * 60_000,
  ipHourMax: 20,
  providerCountryDayMs: 24 * 60 * 60_000,
  providerCountryDayMax: 100,
});

function parseSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let bytes;
  if (/^[0-9a-f]{64,}$/i.test(raw) && raw.length % 2 === 0) bytes = Buffer.from(raw, 'hex');
  else if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) bytes = Buffer.from(raw, 'base64');
  else bytes = Buffer.from(raw, 'utf8');
  return bytes.length >= 32 ? bytes : null;
}

function boundedInteger(value, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function readSmsProductionControlConfig(env = process.env) {
  const environment = String(env.SMS_ENVIRONMENT || '').trim().toLowerCase();
  const provider = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  const abuseSecret = parseSecret(env.SMS_ABUSE_HMAC_SECRET);
  const dailyCapCents = boundedInteger(env.SMS_DAILY_SPEND_CAP_CENTS, 1, 10000000);
  const reservationCents = boundedInteger(env.SMS_MESSAGE_RESERVE_CENTS, 1, 100000);
  const valid = ['qa', 'production'].includes(environment) && provider === 'telnyx' && abuseSecret
    && dailyCapCents && reservationCents && reservationCents <= dailyCapCents;
  return Object.freeze({
    valid: Boolean(valid), environment, provider, abuseSecret,
    dailyCapCents, reservationCents,
  });
}

function keyedSubject(secret, label, ...parts) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw new TypeError('SMS abuse secret is required');
  const framed = [label, ...parts].map((value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`;
  }).join('|');
  return crypto.createHmac('sha256', secret).update(framed).digest('hex');
}

function createProductionRateLimitGates({
  config,
  candidateId,
  clientId,
  roleId,
  destinationFingerprint,
  requestIp,
  provider,
  country,
  rateLimiter = null,
} = {}) {
  if (!config?.valid) return [];
  const selectedRateLimiter = rateLimiter || require('./rateLimit').checkAndIncrementRateLimit;
  const resource = keyedSubject(config.abuseSecret, 'resource', candidateId, clientId, roleId);
  const candidate = keyedSubject(config.abuseSecret, 'candidate', candidateId);
  const ip = keyedSubject(config.abuseSecret, 'ip', requestIp || 'unknown');
  const providerCountry = keyedSubject(config.abuseSecret, 'provider-country', provider, country);
  const definitions = [
    ['sms_destination_cooldown', destinationFingerprint, DEFAULT_LIMITS.cooldownMs, 1],
    ['sms_resource_15m', resource, DEFAULT_LIMITS.resourceWindowMs, DEFAULT_LIMITS.resourceMax],
    ['sms_candidate_15m', candidate, DEFAULT_LIMITS.candidateWindowMs, DEFAULT_LIMITS.candidateMax],
    ['sms_destination_hour', destinationFingerprint, DEFAULT_LIMITS.destinationHourMs, DEFAULT_LIMITS.destinationHourMax],
    ['sms_destination_day', destinationFingerprint, DEFAULT_LIMITS.destinationDayMs, DEFAULT_LIMITS.destinationDayMax],
    ['sms_ip_hour', ip, DEFAULT_LIMITS.ipHourMs, DEFAULT_LIMITS.ipHourMax],
    ['sms_provider_country_day', providerCountry, DEFAULT_LIMITS.providerCountryDayMs, DEFAULT_LIMITS.providerCountryDayMax],
  ];
  return definitions.map(([routeName, subjectKey, windowMs, maxCount]) => async () => selectedRateLimiter({
    routeName, subjectKey, windowMs, maxCount,
  }));
}

async function reserveSmsSpend(db, {
  reservationId,
  config,
  country,
  destinationFingerprint,
  candidateId,
  resourceFingerprint,
} = {}) {
  if (!config?.valid || !db || typeof db.rpc !== 'function') return Object.freeze({ allowed: false });
  const { data, error } = await db.rpc('service_reserve_sms_spend', {
    p_reservation_id: reservationId,
    p_reserved_cents: config.reservationCents,
    p_daily_cap_cents: config.dailyCapCents,
    p_provider: config.provider,
    p_country: country,
    p_destination_fingerprint: destinationFingerprint,
    p_candidate_id: candidateId,
    p_resource_fingerprint: resourceFingerprint,
  });
  if (error) return Object.freeze({ allowed: false });
  const row = Array.isArray(data) ? data[0] : data;
  return Object.freeze({ allowed: row?.allowed === true, reservationId });
}

async function releaseSmsSpend(db, reservationId, outcome) {
  if (!db || typeof db.rpc !== 'function' || !reservationId) return false;
  const { data, error } = await db.rpc('service_release_sms_spend', {
    p_reservation_id: reservationId,
    p_outcome: outcome,
  });
  return !error && data === true;
}

async function finalizeSmsSpend(db, reservationId, outcome) {
  if (!db || typeof db.rpc !== 'function' || !reservationId) return false;
  const { data, error } = await db.rpc('service_finalize_sms_spend', {
    p_reservation_id: reservationId,
    p_outcome: outcome,
  });
  return !error && data === true;
}

function createSmsProductionControls({
  db,
  env = process.env,
  candidate,
  clientId,
  roleId,
  destinationFingerprint,
  requestIp,
  rateLimiter,
  lineLookup = lookupSmsLineType,
} = {}) {
  const config = readSmsProductionControlConfig(env);
  if (!config.valid) return null;
  const country = String(candidate?.phone_country_code || '').trim().toUpperCase();
  const resourceFingerprint = keyedSubject(config.abuseSecret, 'resource', candidate?.id, clientId, roleId);
  const reservationId = crypto.randomUUID();
  return Object.freeze({
    rateLimitGates: createProductionRateLimitGates({
      config,
      candidateId: candidate?.id,
      clientId,
      roleId,
      destinationFingerprint,
      requestIp,
      provider: config.provider,
      country,
      rateLimiter,
    }),
    lookupLineType: () => lineLookup({
      db,
      toE164: candidate?.phone_e164,
      destinationFingerprint,
      env,
    }),
    spendGate: () => reserveSmsSpend(db, {
      reservationId,
      config,
      country,
      destinationFingerprint,
      candidateId: candidate?.id,
      resourceFingerprint,
    }),
    releaseSpend: (outcome) => releaseSmsSpend(db, reservationId, outcome),
    finalizeSpend: (outcome) => finalizeSmsSpend(db, reservationId, outcome),
  });
}

module.exports = {
  DEFAULT_LIMITS,
  createProductionRateLimitGates,
  createSmsProductionControls,
  finalizeSmsSpend,
  keyedSubject,
  parseSecret,
  readSmsProductionControlConfig,
  releaseSmsSpend,
  reserveSmsSpend,
};
