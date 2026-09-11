'use strict';

const { Agent, request: undiciRequest } = require('undici');

const DEFAULT_TAVUS_BASE_URL = 'https://tavusapi.com/v2';
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

const TIMEOUTS = Object.freeze({
  read: Object.freeze({
    requestMs: 8000,
    connectMs: 3000,
    headersMs: 5000,
    bodyMs: 5000,
    operationMs: null,
  }),
  health_read: Object.freeze({
    requestMs: 2000,
    connectMs: 1000,
    headersMs: 1500,
    bodyMs: 1500,
    operationMs: 4500,
  }),
  mutation: Object.freeze({
    requestMs: 12000,
    connectMs: 3000,
    headersMs: 8000,
    bodyMs: 8000,
    operationMs: null,
  }),
  long_provider_mutation: Object.freeze({
    requestMs: 20000,
    connectMs: 4000,
    headersMs: 15000,
    bodyMs: 15000,
    operationMs: null,
  }),
});

const OPERATION_CONFIG = Object.freeze({
  create_conversation: Object.freeze({ method: 'POST', path: '/conversations', timeout: 'mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
  get_conversation: Object.freeze({ method: 'GET', path: '/conversations/:conversationId', timeout: 'read', retrySafety: RETRY_SAFETY.SAFE_TO_RETRY, maxAttempts: 3 }),
  list_conversations: Object.freeze({ method: 'GET', path: '/conversations', timeout: 'read', retrySafety: RETRY_SAFETY.SAFE_TO_RETRY, maxAttempts: 3 }),
  list_conversations_health: Object.freeze({ method: 'GET', path: '/conversations', timeout: 'health_read', retrySafety: RETRY_SAFETY.SAFE_TO_RETRY, maxAttempts: 2 }),
  end_conversation: Object.freeze({ method: 'POST', path: '/conversations/:conversationId/end', timeout: 'mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
  create_document: Object.freeze({ method: 'POST', path: '/documents', timeout: 'long_provider_mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
  create_persona: Object.freeze({ method: 'POST', path: '/personas', timeout: 'mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
  get_persona: Object.freeze({ method: 'GET', path: '/personas/:personaId', timeout: 'read', retrySafety: RETRY_SAFETY.SAFE_TO_RETRY, maxAttempts: 3 }),
  patch_persona: Object.freeze({ method: 'PATCH', path: '/personas/:personaId', timeout: 'mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
  get_pal: Object.freeze({ method: 'GET', path: '/pals/:palId', timeout: 'read', retrySafety: RETRY_SAFETY.SAFE_TO_RETRY, maxAttempts: 3 }),
  patch_pal: Object.freeze({ method: 'PATCH', path: '/pals/:palId', timeout: 'mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
  publish_pal: Object.freeze({ method: 'POST', path: '/pals/:palId/publish', timeout: 'mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
  list_pronunciation_dictionaries: Object.freeze({ method: 'GET', path: '/pronunciation-dictionaries', timeout: 'read', retrySafety: RETRY_SAFETY.SAFE_TO_RETRY, maxAttempts: 3 }),
  get_pronunciation_dictionary: Object.freeze({ method: 'GET', path: '/pronunciation-dictionaries/:dictionaryId', timeout: 'read', retrySafety: RETRY_SAFETY.SAFE_TO_RETRY, maxAttempts: 3 }),
  create_pronunciation_dictionary: Object.freeze({ method: 'POST', path: '/pronunciation-dictionaries', timeout: 'mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
  update_pronunciation_dictionary: Object.freeze({ method: 'PATCH', path: '/pronunciation-dictionaries/:dictionaryId', timeout: 'mutation', retrySafety: RETRY_SAFETY.NOT_SAFE_TO_RETRY, maxAttempts: 1 }),
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

function mergeTimeouts(overrides = {}) {
  return Object.freeze(Object.fromEntries(Object.entries(TIMEOUTS).map(([name, defaults]) => [
    name,
    Object.freeze({
      requestMs: clampNumber(overrides?.[name]?.requestMs, defaults.requestMs),
      connectMs: clampNumber(overrides?.[name]?.connectMs, defaults.connectMs),
      headersMs: clampNumber(overrides?.[name]?.headersMs, defaults.headersMs),
      bodyMs: clampNumber(overrides?.[name]?.bodyMs, defaults.bodyMs),
      operationMs: overrides?.[name]?.operationMs === null
        ? null
        : clampNumber(overrides?.[name]?.operationMs, defaults.operationMs, 1),
    }),
  ])));
}

function boundedIdentifier(value, maximum = 120) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(text)) return null;
  return text;
}

function sanitizeProviderText(value, maximum = 180) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return null;
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bx-api-key\s*[:=]\s*[^\s,;]+/gi, 'x-api-key [redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum) || null;
}

function providerMessageFor(category, rawMessage) {
  const sanitized = sanitizeProviderText(rawMessage);
  if (sanitized) return sanitized;
  const messages = {
    authentication: 'Tavus authentication failed',
    configuration: 'Tavus client is not configured',
    malformed_response: 'Tavus returned a malformed response',
    network: 'Tavus network request failed',
    not_found: 'Tavus resource was not found',
    provider_error: 'Tavus request failed',
    provider_timeout: 'Tavus reported a request timeout',
    rate_limited: 'Tavus rate limited the request',
    timeout: 'Tavus request timed out',
    validation: 'Tavus rejected the request',
  };
  return messages[category] || 'Tavus request failed';
}

class TavusProviderError extends Error {
  constructor({
    operation,
    category,
    status = null,
    retryable = false,
    attemptCount = 0,
    timeout = false,
    timeoutPhase = null,
    providerCode = null,
    providerMessage = null,
    requestId = null,
    cause = null,
  }) {
    super(providerMessageFor(category, providerMessage), cause ? { cause } : undefined);
    this.name = 'TavusProviderError';
    this.provider = 'tavus';
    this.operation = operation;
    this.category = category;
    this.status = Number.isInteger(status) ? status : null;
    this.httpStatus = this.status;
    this.retryable = Boolean(retryable);
    this.attemptCount = Number.isInteger(attemptCount) ? attemptCount : 0;
    this.timeout = Boolean(timeout);
    this.timeoutPhase = timeoutPhase || null;
    this.providerCode = boundedIdentifier(providerCode, 80);
    this.requestId = boundedIdentifier(requestId, 120);
    this.code = 'tavus_provider_error';
  }

  toJSON() {
    return {
      provider: this.provider,
      operation: this.operation,
      category: this.category,
      status: this.status,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      attemptCount: this.attemptCount,
      timeout: this.timeout,
      timeoutPhase: this.timeoutPhase,
      providerCode: this.providerCode,
      requestId: this.requestId,
      message: this.message,
    };
  }
}

function parseRetryAfterMs(value, { nowMs = Date.now(), capMs = MAX_RETRY_DELAY_MS } = {}) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === null || raw === undefined || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), capMs);
  }
  const timestamp = Date.parse(String(raw));
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(Math.max(0, timestamp - nowMs), capMs);
}

function headerValue(headers, name) {
  if (!headers) return null;
  const target = String(name).toLowerCase();
  if (typeof headers.get === 'function') return headers.get(target);
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

async function readResponseText(body, maximumBytes = MAX_RESPONSE_BYTES) {
  if (!body) return '';
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maximumBytes) {
        const error = new Error('tavus_response_too_large');
        error.code = 'TAVUS_RESPONSE_TOO_LARGE';
        throw error;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof body.text === 'function') {
    const text = await body.text();
    if (Buffer.byteLength(String(text), 'utf8') > maximumBytes) {
      const error = new Error('tavus_response_too_large');
      error.code = 'TAVUS_RESPONSE_TOO_LARGE';
      throw error;
    }
    return String(text);
  }
  return '';
}

function timeoutDetails(error, signal) {
  const code = String(error?.code || error?.cause?.code || '');
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return { timeout: true, phase: 'connect' };
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return { timeout: true, phase: 'response_headers' };
  if (code === 'UND_ERR_BODY_TIMEOUT') return { timeout: true, phase: 'response_body' };
  if (error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED' || signal?.aborted) {
    return { timeout: true, phase: 'request' };
  }
  return { timeout: false, phase: null };
}

function classifyHttpStatus(status) {
  if (status === 400 || status === 409 || status === 422) return 'validation';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'not_found';
  if (status === 408) return 'provider_timeout';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

function providerFields(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const providerCode = boundedIdentifier(String(data.code || data.error_code || data.error || ''), 80);
  // Provider messages can echo submitted values. Keep the allowlisted provider
  // code, but use the client's stable category message rather than risk copying
  // candidate or signed-URL material into logs/Sentry/caller responses.
  return { providerCode };
}

function defaultTelemetry(event) {
  const method = event.event === 'tavus_request_failed' || event.event === 'tavus_request_timeout'
    ? 'warn'
    : 'info';
  console[method]('[tavus-http]', event);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_TAVUS_BASE_URL).trim().replace(/\/+$/, '');
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function replacePathParameter(path, parameter, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    const error = new Error(`${parameter}_required`);
    error.code = `${parameter.toUpperCase()}_REQUIRED`;
    throw error;
  }
  return path.replace(`:${parameter}`, encodeURIComponent(normalized));
}

function createTavusHttpClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.TAVUS_API_BASE || process.env.TAVUS_API_BASE_URL);
  const timeouts = mergeTimeouts(options.timeouts);
  const transport = options.transport || undiciRequest;
  const usesDefaultTransport = !options.transport;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random || Math.random;
  const now = options.now || Date.now;
  const telemetry = options.telemetry || defaultTelemetry;
  const apiKeyProvider = typeof options.apiKeyProvider === 'function'
    ? options.apiKeyProvider
    : () => options.apiKey !== undefined ? options.apiKey : process.env.TAVUS_API_KEY;

  function emit(event, metadata) {
    telemetry(Object.freeze({ event, ...metadata }));
  }

  async function execute(operation, request = {}) {
    const config = OPERATION_CONFIG[operation];
    if (!config) throw new Error(`unknown_tavus_operation:${operation}`);
    const apiKey = String(apiKeyProvider() || '').trim();
    if (!apiKey) {
      throw new TavusProviderError({
        operation,
        category: 'configuration',
        providerMessage: 'TAVUS_API_KEY is not set',
      });
    }

    const timeoutProfile = timeouts[config.timeout];
    const configuredMaxAttempts = Number.isInteger(request.maxAttempts)
      ? request.maxAttempts
      : config.maxAttempts;
    const maxAttempts = config.retrySafety === RETRY_SAFETY.SAFE_TO_RETRY
      ? Math.min(Math.max(configuredMaxAttempts, 1), config.maxAttempts)
      : 1;
    const operationStartedAt = now();
    const url = buildUrl(baseUrl, request.path || config.path, request.query);
    const headers = {
      'x-api-key': apiKey,
      accept: 'application/json',
      ...(request.body !== undefined ? { 'content-type': request.contentType || 'application/json' } : {}),
    };
    const serializedBody = request.body === undefined ? undefined : JSON.stringify(request.body);
    let finalError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const elapsedBeforeAttempt = Math.max(0, now() - operationStartedAt);
      const remainingOperationMs = timeoutProfile.operationMs
        ? Math.max(1, timeoutProfile.operationMs - elapsedBeforeAttempt)
        : null;
      const requestTimeoutMs = remainingOperationMs
        ? Math.min(timeoutProfile.requestMs, remainingOperationMs)
        : timeoutProfile.requestMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      emit('tavus_request_started', { operation, attempt });
      let response;

      try {
        response = await transport(url, {
          method: config.method,
          headers,
          body: serializedBody,
          signal: controller.signal,
          headersTimeout: timeoutProfile.headersMs,
          bodyTimeout: timeoutProfile.bodyMs,
          idempotent: config.retrySafety === RETRY_SAFETY.SAFE_TO_RETRY,
          maxRedirections: 0,
          ...(usesDefaultTransport ? { dispatcher: dispatcherFor(timeoutProfile.connectMs) } : {}),
        });

        const status = Number(response?.statusCode || 0);
        const text = await readResponseText(response?.body);
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (cause) {
            if (status >= 200 && status < 300) {
              throw new TavusProviderError({
                operation,
                category: 'malformed_response',
                status: status || null,
                retryable: false,
                attemptCount: attempt,
                requestId: headerValue(response?.headers, 'x-request-id') || headerValue(response?.headers, 'request-id'),
                cause,
              });
            }
          }
        }

        if (status >= 200 && status < 300) {
          emit('tavus_request_succeeded', { operation, attempt, status });
          return data;
        }

        const category = classifyHttpStatus(status);
        const fields = providerFields(data);
        const conditionRetryable = config.retrySafety === RETRY_SAFETY.SAFE_TO_RETRY
          && RETRYABLE_HTTP_STATUSES.has(status);
        finalError = new TavusProviderError({
          operation,
          category,
          status,
          retryable: conditionRetryable,
          attemptCount: attempt,
          requestId: headerValue(response?.headers, 'x-request-id') || headerValue(response?.headers, 'request-id'),
          ...fields,
        });

        if (!conditionRetryable || attempt >= maxAttempts) {
          emit('tavus_request_failed', {
            operation,
            attempt,
            status,
            category,
            retryable: conditionRetryable,
          });
          throw finalError;
        }

        const retryAfter = parseRetryAfterMs(headerValue(response?.headers, 'retry-after'), {
          nowMs: now(),
          capMs: MAX_RETRY_DELAY_MS,
        });
        const retryNumber = attempt;
        const jitterFactor = 0.5 + Math.min(1, Math.max(0, Number(random()) || 0));
        const backoff = Math.min(
          Math.round(RETRY_BASE_DELAY_MS * (2 ** (retryNumber - 1)) * jitterFactor),
          MAX_RETRY_DELAY_MS,
        );
        const delayMs = retryAfter === null ? backoff : retryAfter;
        if (timeoutProfile.operationMs
          && timeoutProfile.operationMs - Math.max(0, now() - operationStartedAt) <= delayMs) {
          emit('tavus_request_failed', {
            operation,
            attempt,
            status,
            category,
            retryable: conditionRetryable,
          });
          throw finalError;
        }
        emit('tavus_request_retry', { operation, attempt, status, category, delayMs });
        await sleep(delayMs);
      } catch (caught) {
        if (caught instanceof TavusProviderError) {
          if (caught === finalError) throw caught;
          emit('tavus_request_failed', {
            operation,
            attempt: caught.attemptCount || attempt,
            status: caught.status,
            category: caught.category,
            retryable: caught.retryable,
          });
          throw caught;
        }

        const timeout = timeoutDetails(caught, controller.signal);
        const networkCode = String(caught?.code || caught?.cause?.code || '');
        const isNetworkFailure = timeout.timeout || RETRYABLE_NETWORK_CODES.has(networkCode);
        const conditionRetryable = config.retrySafety === RETRY_SAFETY.SAFE_TO_RETRY && isNetworkFailure;
        finalError = new TavusProviderError({
          operation,
          category: timeout.timeout ? 'timeout' : 'network',
          retryable: conditionRetryable,
          attemptCount: attempt,
          timeout: timeout.timeout,
          timeoutPhase: timeout.phase,
          cause: caught,
        });
        if (timeout.timeout) {
          emit('tavus_request_timeout', {
            operation,
            attempt,
            category: 'timeout',
            timeoutPhase: timeout.phase,
            retryable: conditionRetryable,
          });
        }

        if (!conditionRetryable || attempt >= maxAttempts) {
          emit('tavus_request_failed', {
            operation,
            attempt,
            status: null,
            category: finalError.category,
            retryable: conditionRetryable,
          });
          throw finalError;
        }

        const retryNumber = attempt;
        const jitterFactor = 0.5 + Math.min(1, Math.max(0, Number(random()) || 0));
        const delayMs = Math.min(
          Math.round(RETRY_BASE_DELAY_MS * (2 ** (retryNumber - 1)) * jitterFactor),
          MAX_RETRY_DELAY_MS,
        );
        if (timeoutProfile.operationMs
          && timeoutProfile.operationMs - Math.max(0, now() - operationStartedAt) <= delayMs) {
          emit('tavus_request_failed', {
            operation,
            attempt,
            status: null,
            category: finalError.category,
            retryable: conditionRetryable,
          });
          throw finalError;
        }
        emit('tavus_request_retry', {
          operation,
          attempt,
          status: null,
          category: finalError.category,
          delayMs,
        });
        await sleep(delayMs);
      } finally {
        clearTimeout(timer);
      }
    }

    throw finalError;
  }

  return Object.freeze({
    createConversation(body, requestOptions = {}) {
      return execute('create_conversation', { ...requestOptions, body });
    },
    getConversation(conversationId, requestOptions = {}) {
      return execute('get_conversation', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.get_conversation.path, 'conversationId', conversationId),
      });
    },
    listConversations(query = {}, requestOptions = {}) {
      const operation = requestOptions.health ? 'list_conversations_health' : 'list_conversations';
      return execute(operation, { ...requestOptions, query });
    },
    endConversation(conversationId, body = {}, requestOptions = {}) {
      return execute('end_conversation', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.end_conversation.path, 'conversationId', conversationId),
        body,
      });
    },
    createDocument(body, requestOptions = {}) {
      return execute('create_document', { ...requestOptions, body });
    },
    createPersona(body, requestOptions = {}) {
      return execute('create_persona', { ...requestOptions, body });
    },
    getPersona(personaId, requestOptions = {}) {
      return execute('get_persona', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.get_persona.path, 'personaId', personaId),
      });
    },
    patchPersona(personaId, body, requestOptions = {}) {
      return execute('patch_persona', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.patch_persona.path, 'personaId', personaId),
        body,
      });
    },
    getPal(palId, query = {}, requestOptions = {}) {
      return execute('get_pal', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.get_pal.path, 'palId', palId),
        query,
      });
    },
    patchPal(palId, body, query = {}, requestOptions = {}) {
      return execute('patch_pal', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.patch_pal.path, 'palId', palId),
        query,
        body,
      });
    },
    publishPal(palId, requestOptions = {}) {
      return execute('publish_pal', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.publish_pal.path, 'palId', palId),
      });
    },
    listPronunciationDictionaries(query = {}, requestOptions = {}) {
      return execute('list_pronunciation_dictionaries', { ...requestOptions, query });
    },
    getPronunciationDictionary(dictionaryId, requestOptions = {}) {
      return execute('get_pronunciation_dictionary', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.get_pronunciation_dictionary.path, 'dictionaryId', dictionaryId),
      });
    },
    createPronunciationDictionary(body, requestOptions = {}) {
      return execute('create_pronunciation_dictionary', { ...requestOptions, body });
    },
    updatePronunciationDictionary(dictionaryId, body, requestOptions = {}) {
      return execute('update_pronunciation_dictionary', {
        ...requestOptions,
        path: replacePathParameter(OPERATION_CONFIG.update_pronunciation_dictionary.path, 'dictionaryId', dictionaryId),
        body,
      });
    },
    createReadRequestForTest(operation, path, requestOptions = {}) {
      if (!['get_conversation', 'list_conversations', 'get_persona', 'get_pal', 'list_pronunciation_dictionaries', 'get_pronunciation_dictionary'].includes(operation)) {
        throw new Error('test_read_operation_required');
      }
      return execute(operation, { ...requestOptions, path });
    },
  });
}

const tavusHttpClient = createTavusHttpClient();

module.exports = {
  DEFAULT_TAVUS_BASE_URL,
  MAX_RETRY_DELAY_MS,
  OPERATION_CONFIG,
  RETRY_SAFETY,
  TavusProviderError,
  TIMEOUTS,
  createTavusHttpClient,
  parseRetryAfterMs,
  sanitizeProviderText,
  tavusHttpClient,
};
