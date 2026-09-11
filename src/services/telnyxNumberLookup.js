'use strict';

const https = require('node:https');
const { normalizeSmsLineType } = require('./smsOtpFoundation');

const TELNYX_LOOKUP_HOST = 'api.telnyx.com';
const RESPONSE_LIMIT_BYTES = 128 * 1024;

function boundedSecret(value, max = 512) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function readTelnyxLookupConfig(env = process.env) {
  const enabled = String(env.SMS_LOOKUP_ENABLED || '').trim().toLowerCase() === 'true';
  const environment = String(env.SMS_ENVIRONMENT || '').trim().toLowerCase();
  const provider = String(env.SMS_LOOKUP_PROVIDER || env.SMS_PROVIDER || '').trim().toLowerCase();
  const apiKey = boundedSecret(env.TELNYX_API_KEY);
  const timeoutMs = Number(env.SMS_LOOKUP_TIMEOUT_MS || 3000);
  const cacheTtlSeconds = Number(env.SMS_LOOKUP_CACHE_SECONDS || 2592000);
  const valid = enabled && ['qa', 'production'].includes(environment) && provider === 'telnyx'
    && apiKey && Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 10000
    && Number.isInteger(cacheTtlSeconds) && cacheTtlSeconds >= 3600 && cacheTtlSeconds <= 2592000;
  return Object.freeze({ valid: Boolean(valid), enabled, environment, provider, apiKey, timeoutMs, cacheTtlSeconds });
}

function normalizeTelnyxLineType(payload) {
  const data = payload && payload.data;
  const raw = String(data?.portability?.line_type || data?.carrier?.type || '').trim().toLowerCase();
  if (['mobile', 'wireless', 'cellular'].includes(raw)) return 'mobile';
  if (['landline', 'fixed', 'fixed_line', 'fixed-line'].includes(raw)) return 'landline';
  if (['voip', 'non_fixed_voip', 'fixed_voip'].includes(raw)) return 'voip';
  return 'unknown';
}

function requestTelnyxNumberLookup({ toE164, apiKey, timeoutMs, httpsModule = https }) {
  return new Promise((resolve, reject) => {
    const path = `/v2/number_lookup/${encodeURIComponent(toE164)}?type=carrier`;
    let completed = false;
    const request = httpsModule.request({
      protocol: 'https:',
      hostname: TELNYX_LOOKUP_HOST,
      port: 443,
      path,
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT_BYTES) return response.destroy(new Error('LOOKUP_RESPONSE_TOO_LARGE'));
        chunks.push(chunk);
      });
      response.on('end', () => {
        completed = true;
        resolve({ statusCode: Number(response.statusCode || 0), body: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', () => { if (!completed) reject(new Error('LOOKUP_RESPONSE_ERROR')); });
    });
    request.once('error', () => { if (!completed) reject(new Error('LOOKUP_REQUEST_ERROR')); });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('LOOKUP_TIMEOUT')));
    request.end();
  });
}

async function getCachedLineType(db, destinationFingerprint, provider) {
  if (!db || typeof db.rpc !== 'function') return null;
  const { data, error } = await db.rpc('service_get_sms_line_type_cache', {
    p_destination_fingerprint: destinationFingerprint,
    p_provider: provider,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return normalizeSmsLineType(row.line_type);
}

async function putCachedLineType(db, { destinationFingerprint, provider, lineType, checkedAt, ttlSeconds }) {
  if (!db || typeof db.rpc !== 'function') throw new Error('LOOKUP_CACHE_UNAVAILABLE');
  const { error } = await db.rpc('service_put_sms_line_type_cache', {
    p_destination_fingerprint: destinationFingerprint,
    p_provider: provider,
    p_line_type: lineType,
    p_checked_at: checkedAt,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw error;
}

async function lookupSmsLineType({
  db,
  toE164,
  destinationFingerprint,
  env = process.env,
  transport = requestTelnyxNumberLookup,
  now = () => new Date(),
} = {}) {
  const config = readTelnyxLookupConfig(env);
  if (!config.valid || !/^\+1\d{10}$/.test(String(toE164 || ''))
      || !/^[0-9a-f]{64}$/.test(String(destinationFingerprint || ''))) {
    return Object.freeze({ ok: false, lineType: 'unknown', cached: false });
  }
  try {
    const cached = await getCachedLineType(db, destinationFingerprint, config.provider);
    if (cached) return Object.freeze({ ok: true, lineType: cached, cached: true });
    const response = await transport({
      toE164,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    });
    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      return Object.freeze({ ok: false, lineType: 'unknown', cached: false });
    }
    let payload;
    try { payload = JSON.parse(response.body); } catch { return Object.freeze({ ok: false, lineType: 'unknown', cached: false }); }
    const lineType = normalizeTelnyxLineType(payload);
    const checkedAt = now().toISOString();
    await putCachedLineType(db, {
      destinationFingerprint,
      provider: config.provider,
      lineType,
      checkedAt,
      ttlSeconds: config.cacheTtlSeconds,
    });
    return Object.freeze({ ok: true, lineType, cached: false });
  } catch {
    return Object.freeze({ ok: false, lineType: 'unknown', cached: false });
  }
}

module.exports = {
  TELNYX_LOOKUP_HOST,
  getCachedLineType,
  lookupSmsLineType,
  normalizeTelnyxLineType,
  putCachedLineType,
  readTelnyxLookupConfig,
  requestTelnyxNumberLookup,
};
