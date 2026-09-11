'use strict';

const crypto = require('node:crypto');

const TAVUS_WEBHOOK_AUTH_QUERY_PARAM = 'tavus_webhook_token';
const MIN_SECRET_BYTES = 32;
const MAX_AUTH_VALUE_LENGTH = 512;
const AUTH_FAILURE_LOG_INTERVAL_MS = 60_000;
const lastAuthFailureLogAt = new Map();

function normalizeAuthValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeBase64Url(value) {
  const normalized = normalizeAuthValue(value);
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) return null;
  try {
    const decoded = Buffer.from(normalized, 'base64url');
    if (!decoded.length || decoded.toString('base64url') !== normalized) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isConfiguredTavusWebhookSecret(env = process.env) {
  const decoded = decodeBase64Url(env?.TAVUS_WEBHOOK_SECRET);
  return Boolean(decoded && decoded.length >= MIN_SECRET_BYTES);
}

function getTavusWebhookAuthReadiness(env = process.env) {
  const configured = isConfiguredTavusWebhookSecret(env);
  return {
    ok: configured,
    configured,
    status: configured ? 'configured' : 'missing_or_invalid',
  };
}

function configurationError() {
  const error = new Error('Tavus webhook authentication is not configured.');
  error.code = 'TAVUS_WEBHOOK_AUTH_NOT_CONFIGURED';
  error.status = 503;
  return error;
}

function buildAuthenticatedTavusWebhookUrl(callbackUrl, env = process.env) {
  if (!isConfiguredTavusWebhookSecret(env)) throw configurationError();

  let url;
  try {
    url = new URL(String(callbackUrl || ''));
  } catch {
    const error = new Error('Tavus callback URL is invalid.');
    error.code = 'TAVUS_WEBHOOK_URL_INVALID';
    error.status = 500;
    throw error;
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    const error = new Error('Tavus callback URL protocol is invalid.');
    error.code = 'TAVUS_WEBHOOK_URL_INVALID';
    error.status = 500;
    throw error;
  }

  url.searchParams.set(
    TAVUS_WEBHOOK_AUTH_QUERY_PARAM,
    normalizeAuthValue(env.TAVUS_WEBHOOK_SECRET),
  );
  return url.toString();
}

function extractProvidedAuth(req) {
  const query = req?.query || {};
  let provided = query[TAVUS_WEBHOOK_AUTH_QUERY_PARAM];

  if (provided === undefined) {
    try {
      const requestUrl = new URL(String(req?.originalUrl || req?.url || ''), 'https://webhook.invalid');
      if (requestUrl.searchParams.has(TAVUS_WEBHOOK_AUTH_QUERY_PARAM)) {
        provided = requestUrl.searchParams.getAll(TAVUS_WEBHOOK_AUTH_QUERY_PARAM);
        if (provided.length === 1) [provided] = provided;
      }
    } catch {
      return { ok: false, category: 'malformed_auth' };
    }
  }

  if (provided === undefined) return { ok: false, category: 'missing_secret' };
  if (Array.isArray(provided) || typeof provided !== 'string') {
    return { ok: false, category: 'malformed_auth' };
  }

  const normalized = normalizeAuthValue(provided);
  if (
    !normalized ||
    normalized.length > MAX_AUTH_VALUE_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    return { ok: false, category: 'malformed_auth' };
  }

  return { ok: true, value: normalized };
}

function verifyTavusWebhookRequest(req, env = process.env) {
  if (!isConfiguredTavusWebhookSecret(env)) {
    return { ok: false, status: 401, category: 'missing_configuration' };
  }

  const provided = extractProvidedAuth(req);
  if (!provided.ok) return { ok: false, status: 401, category: provided.category };

  const expectedDigest = crypto
    .createHash('sha256')
    .update(normalizeAuthValue(env.TAVUS_WEBHOOK_SECRET), 'utf8')
    .digest();
  const providedDigest = crypto
    .createHash('sha256')
    .update(provided.value, 'utf8')
    .digest();
  const ok = crypto.timingSafeEqual(expectedDigest, providedDigest);
  return ok
    ? { ok: true, status: 200, category: null }
    : { ok: false, status: 401, category: 'invalid_secret' };
}

function shouldLogAuthFailure(category, now = Date.now()) {
  const key = String(category || 'unknown');
  const previous = lastAuthFailureLogAt.get(key) || 0;
  if (now - previous < AUTH_FAILURE_LOG_INTERVAL_MS) return false;
  lastAuthFailureLogAt.set(key, now);
  return true;
}

function authenticateTavusWebhookRequest(req, res, next) {
  const result = verifyTavusWebhookRequest(req);
  if (result.ok) return next();

  if (shouldLogAuthFailure(result.category)) {
    console.warn('[webhook] tavus_webhook_auth_failed', {
      failure_category: result.category,
    });
  }
  return res.status(401).json({
    ok: false,
    error: 'webhook_authentication_failed',
  });
}

function redactAuthString(value, env = process.env) {
  let output = String(value);
  output = output.replace(
    /([?&]tavus_webhook_token=)[^&#\s"'},\]]*/gi,
    '$1[REDACTED]',
  );
  const configured = normalizeAuthValue(env?.TAVUS_WEBHOOK_SECRET);
  if (configured.length >= 16) output = output.split(configured).join('[REDACTED]');
  return output;
}

function redactTavusWebhookAuth(value, env = process.env, seen = new WeakSet()) {
  if (typeof value === 'string') return redactAuthString(value, env);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED_CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactTavusWebhookAuth(item, env, seen));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^tavus_webhook_secret$/i.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = redactTavusWebhookAuth(item, env, seen);
  }
  return output;
}

function omitProviderCallbackUrls(value, env = process.env, seen = new WeakSet()) {
  if (typeof value === 'string') return redactAuthString(value, env);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED_CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => omitProviderCallbackUrls(item, env, seen));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:callback_url|webhook_url)$/i.test(key)) continue;
    output[key] = omitProviderCallbackUrls(item, env, seen);
  }
  return output;
}

module.exports = {
  AUTH_FAILURE_LOG_INTERVAL_MS,
  MIN_SECRET_BYTES,
  TAVUS_WEBHOOK_AUTH_QUERY_PARAM,
  authenticateTavusWebhookRequest,
  buildAuthenticatedTavusWebhookUrl,
  getTavusWebhookAuthReadiness,
  isConfiguredTavusWebhookSecret,
  omitProviderCallbackUrls,
  redactTavusWebhookAuth,
  verifyTavusWebhookRequest,
  _test: {
    extractProvidedAuth,
    shouldLogAuthFailure,
  },
};
