'use strict';

// The outbound HTTP model the Tavus client established, generalised so every vendor
// call can use it: a named timeout profile per operation class, retry only where the
// operation is safe to repeat, a bounded attempt count with jittered backoff, and a
// cap on how much of a response body is read.
//
// Before this existed, Tavus was the only caller with any of it. Everything else —
// axios, node-fetch, the health probes — had no timeout at all, so a hung vendor held
// a request open until the platform killed it.

const { Agent, request: undiciRequest } = require('undici');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETRY_DELAY_MS = 1000;
const RETRY_BASE_DELAY_MS = 100;

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ABORT_ERR',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const RETRY_SAFETY = Object.freeze({
  SAFE_TO_RETRY: 'SAFE_TO_RETRY',
  NOT_SAFE_TO_RETRY: 'NOT_SAFE_TO_RETRY',
});

// requestMs bounds one attempt; operationMs, where set, bounds all attempts together.
const TIMEOUT_PROFILES = Object.freeze({
  read: Object.freeze({
    requestMs: 8000, connectMs: 3000, headersMs: 5000, bodyMs: 5000, operationMs: null,
  }),
  health_read: Object.freeze({
    requestMs: 2000, connectMs: 1000, headersMs: 1500, bodyMs: 1500, operationMs: 4500,
  }),
  mutation: Object.freeze({
    requestMs: 12000, connectMs: 3000, headersMs: 8000, bodyMs: 8000, operationMs: null,
  }),
  long_provider_mutation: Object.freeze({
    requestMs: 20000, connectMs: 4000, headersMs: 15000, bodyMs: 15000, operationMs: null,
  }),
  // Model calls answer far slower than an ordinary API, so they get their own class
  // rather than stretching the shared mutation profile.
  model_completion: Object.freeze({
    requestMs: 120000, connectMs: 5000, headersMs: 115000, bodyMs: 115000, operationMs: null,
  }),
});

const dispatcherCache = new Map();

function dispatcherFor(connectMs) {
  if (!dispatcherCache.has(connectMs)) {
    dispatcherCache.set(connectMs, new Agent({
      connect: { timeout: connectMs },
      headersTimeout: connectMs,
      bodyTimeout: connectMs,
    }));
  }
  return dispatcherCache.get(connectMs);
}

function clampNumber(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

// Applies per-profile overrides without letting a caller drop a bound entirely.
function mergeTimeouts(overrides = {}, defaults = TIMEOUT_PROFILES) {
  return Object.freeze(Object.fromEntries(Object.entries(defaults).map(([name, profile]) => [
    name,
    Object.freeze({
      requestMs: clampNumber(overrides?.[name]?.requestMs, profile.requestMs),
      connectMs: clampNumber(overrides?.[name]?.connectMs, profile.connectMs),
      headersMs: clampNumber(overrides?.[name]?.headersMs, profile.headersMs),
      bodyMs: clampNumber(overrides?.[name]?.bodyMs, profile.bodyMs),
      operationMs: overrides?.[name]?.operationMs === null
        ? null
        : clampNumber(overrides?.[name]?.operationMs, profile.operationMs, 1),
    }),
  ])));
}

function parseRetryAfterMs(headerValue, nowMs) {
  if (headerValue === undefined || headerValue === null) return null;
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : null;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(at - nowMs, MAX_RETRY_DELAY_MS));
}

function backoffDelayMs(attempt, random = Math.random) {
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
  return Math.floor(ceiling * (0.5 + (random() * 0.5)));
}

function isRetryableNetworkError(error) {
  const code = error?.code || error?.cause?.code || error?.name;
  return RETRYABLE_NETWORK_CODES.has(String(code || ''));
}

// Reads at most MAX_RESPONSE_BYTES, so a vendor streaming without end cannot exhaust
// memory the way an unbounded read would.
async function readResponseText(body, maxBytes = MAX_RESPONSE_BYTES) {
  if (!body) return '';
  if (typeof body.text === 'function') {
    const text = await body.text();
    return typeof text === 'string' ? text.slice(0, maxBytes) : '';
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      chunks.push(buffer.subarray(0, buffer.length - (size - maxBytes)));
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class HttpClientError extends Error {
  constructor({ name, status = null, attemptCount = 1, retryable = false, category = 'network', cause = null }) {
    super(`${name}_request_failed:${category}${status ? `:${status}` : ''}`);
    this.name = 'HttpClientError';
    this.client = name;
    this.status = status;
    this.attemptCount = attemptCount;
    this.retryable = retryable;
    this.category = category;
    if (cause) this.cause = cause;
  }
}

// Builds a caller with its own name, timeout profiles and transport. The transport is
// injectable so a test can drive every branch without a socket.
function createHttpClient(options = {}) {
  const name = String(options.name || 'http');
  const timeouts = mergeTimeouts(options.timeouts);
  const transport = options.transport || undiciRequest;
  const usesDefaultTransport = !options.transport;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random || Math.random;
  const now = options.now || Date.now;

  async function request(url, {
    method = 'GET',
    headers = {},
    body,
    timeout = 'read',
    retrySafety = RETRY_SAFETY.NOT_SAFE_TO_RETRY,
    maxAttempts = 1,
  } = {}) {
    const profile = timeouts[timeout];
    if (!profile) throw new Error(`unknown_timeout_profile:${timeout}`);
    const attempts = retrySafety === RETRY_SAFETY.SAFE_TO_RETRY
      ? Math.min(Math.max(Number(maxAttempts) || 1, 1), 5)
      : 1;

    const startedAt = now();
    let finalError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const elapsed = Math.max(0, now() - startedAt);
      const remaining = profile.operationMs ? Math.max(1, profile.operationMs - elapsed) : null;
      const requestTimeoutMs = remaining ? Math.min(profile.requestMs, remaining) : profile.requestMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const response = await transport(url, {
          method,
          headers,
          body,
          signal: controller.signal,
          headersTimeout: profile.headersMs,
          bodyTimeout: profile.bodyMs,
          idempotent: retrySafety === RETRY_SAFETY.SAFE_TO_RETRY,
          maxRedirections: 0,
          ...(usesDefaultTransport ? { dispatcher: dispatcherFor(profile.connectMs) } : {}),
        });

        const status = Number(response?.statusCode || 0);
        const text = await readResponseText(response?.body);
        if (status >= 200 && status < 300) {
          return { status, text, headers: response?.headers || {} };
        }

        const retryable = retrySafety === RETRY_SAFETY.SAFE_TO_RETRY && RETRYABLE_HTTP_STATUSES.has(status);
        finalError = new HttpClientError({
          name,
          status,
          attemptCount: attempt,
          retryable,
          category: status >= 500 ? 'provider_error' : 'request_rejected',
        });
        if (!retryable || attempt === attempts) throw finalError;
        const retryAfter = parseRetryAfterMs(response?.headers?.['retry-after'], now());
        await sleep(retryAfter === null ? backoffDelayMs(attempt, random) : retryAfter);
      } catch (error) {
        if (error instanceof HttpClientError) {
          if (!error.retryable || attempt === attempts) throw error;
          continue;
        }
        const retryable = retrySafety === RETRY_SAFETY.SAFE_TO_RETRY && isRetryableNetworkError(error);
        finalError = new HttpClientError({
          name,
          attemptCount: attempt,
          retryable,
          category: controller.signal.aborted ? 'timeout' : 'network',
          cause: error,
        });
        if (!retryable || attempt === attempts) throw finalError;
        await sleep(backoffDelayMs(attempt, random));
      } finally {
        clearTimeout(timer);
      }
    }

    throw finalError || new HttpClientError({ name, attemptCount: attempts });
  }

  // Convenience wrapper for the common case: a JSON request and a JSON response.
  async function requestJson(url, requestOptions = {}) {
    const { body, headers = {}, ...rest } = requestOptions;
    const response = await request(url, {
      ...rest,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.text) return { ...response, data: null };
    try {
      return { ...response, data: JSON.parse(response.text) };
    } catch (cause) {
      throw new HttpClientError({ name, status: response.status, category: 'malformed_response', cause });
    }
  }

  return { request, requestJson };
}

module.exports = {
  HttpClientError,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_DELAY_MS,
  RETRYABLE_HTTP_STATUSES,
  RETRYABLE_NETWORK_CODES,
  RETRY_BASE_DELAY_MS,
  RETRY_SAFETY,
  TIMEOUT_PROFILES,
  backoffDelayMs,
  createHttpClient,
  dispatcherFor,
  isRetryableNetworkError,
  mergeTimeouts,
  parseRetryAfterMs,
  readResponseText,
};
