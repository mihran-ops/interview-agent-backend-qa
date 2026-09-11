'use strict';

const https = require('node:https');
const {
  assertSmsProviderRequest,
  assertSmsProviderResult,
} = require('../services/smsProviderContract');
const { buildOtpSmsMessage } = require('../services/smsMessage');

const TELNYX_API_HOST = 'api.telnyx.com';
const TELNYX_MESSAGE_PATH = '/v2/messages';
const TELNYX_WEBHOOK_PATH = '/webhook/telnyx/sms';
const RESPONSE_LIMIT_BYTES = 256 * 1024;
const INVALID_DESTINATION_CODES = new Set(['10002', '40001', '40012', '40310', '42201']);
const TELNYX_WEBHOOK_HOSTS = Object.freeze({
  qa: new Set(['ia-backend-qa.onrender.com']),
  production: new Set(['api.alphasourceai.com', 'ia-backend-prod.onrender.com']),
});

class TelnyxTransportError extends Error {
  constructor(kind, dispatched) {
    super('Telnyx transport request failed');
    this.name = 'TelnyxTransportError';
    this.kind = kind;
    this.dispatched = dispatched === true;
  }
}

function boundedOpaque(value, max = 255) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function boundedErrorCode(payload) {
  if (!payload || !Array.isArray(payload.errors) || !payload.errors[0]) return null;
  const code = String(payload.errors[0].code || '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : null;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeTelnyxWebhookUrl(value, environment) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 500) return null;
  try {
    const parsed = new URL(normalized);
    const allowedHosts = TELNYX_WEBHOOK_HOSTS[environment];
    if (parsed.protocol !== 'https:'
      || !allowedHosts
      || !allowedHosts.has(parsed.hostname)
      || parsed.pathname !== TELNYX_WEBHOOK_PATH
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function failureResult(outcome) {
  const failureCategory = outcome === 'rejected' ? 'provider_rejected' : outcome;
  const status = ['rejected', 'invalid_destination', 'blocked_destination'].includes(outcome) ? 'rejected'
    : outcome === 'ambiguous_outcome' ? null : 'failed';
  const result = Object.freeze({ provider: 'telnyx', messageId: null, status, outcome, failureCategory });
  assertSmsProviderResult(result);
  return result;
}

function classifyTelnyxHttpFailure(statusCode, payload) {
  const code = boundedErrorCode(payload);
  if (code === '40333') return failureResult('rejected');
  if (code === '40300') return failureResult('blocked_destination');
  if (INVALID_DESTINATION_CODES.has(code)) return failureResult('invalid_destination');
  if ([401, 402].includes(statusCode)) return failureResult('misconfigured');
  if (statusCode === 403) return failureResult('misconfigured');
  if (statusCode === 429 || statusCode >= 500) return failureResult('transient_preacceptance');
  return failureResult('rejected');
}

function normalizeTelnyxAcceptedResponse(payload) {
  const data = payload && payload.data;
  const messageId = boundedOpaque(data && data.id);
  const nativeStatus = data && Array.isArray(data.to) && data.to[0] && data.to[0].status;
  const status = nativeStatus === 'sent' ? 'sent' : nativeStatus === 'queued' ? 'queued' : null;
  if (!messageId || !status) return failureResult('ambiguous_outcome');
  const result = Object.freeze({
    provider: 'telnyx',
    messageId,
    status,
    outcome: 'accepted',
    failureCategory: null,
  });
  assertSmsProviderResult(result);
  return result;
}

function requestTelnyxMessage({ apiKey, body, timeoutMs, httpsModule = https }) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8');
    let dispatched = false;
    let completed = false;
    const request = httpsModule.request({
      protocol: 'https:',
      hostname: TELNYX_API_HOST,
      port: 443,
      path: TELNYX_MESSAGE_PATH,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': String(encoded.length),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT_BYTES) {
          response.destroy(new TelnyxTransportError('oversized_response', true));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        completed = true;
        resolve({ statusCode: Number(response.statusCode || 0), body: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', () => {
        if (!completed) reject(new TelnyxTransportError('response_error', true));
      });
    });
    request.once('finish', () => { dispatched = true; });
    request.once('error', () => {
      if (!completed) reject(new TelnyxTransportError('connection_error', dispatched));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new TelnyxTransportError('timeout', dispatched)));
    request.end(encoded);
  });
}

function readTelnyxConfig(env) {
  const enabled = String(env.SMS_ENABLED || '').toLowerCase() === 'true';
  const environment = String(env.SMS_ENVIRONMENT || '').toLowerCase();
  const provider = String(env.SMS_PROVIDER || '').toLowerCase();
  const apiKey = boundedOpaque(env.TELNYX_API_KEY, 512);
  const profileId = boundedOpaque(env.TELNYX_MESSAGING_PROFILE_ID);
  const senderE164 = String(env.TELNYX_SENDER_E164 || '').trim();
  const webhookUrl = normalizeTelnyxWebhookUrl(env.TELNYX_MESSAGING_WEBHOOK_URL, environment);
  const timeoutMs = Number(env.TELNYX_TIMEOUT_MS || 5000);
  const valid = enabled && ['qa', 'production'].includes(environment) && provider === 'telnyx'
    && apiKey && profileId && webhookUrl && /^\+1\d{10}$/.test(senderE164)
    && Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 10_000;
  return Object.freeze({ valid: !!valid, environment, apiKey, profileId, senderE164, webhookUrl, timeoutMs });
}

function createTelnyxSmsProvider({ env = process.env, transport = requestTelnyxMessage, now = () => new Date() } = {}) {
  let calls = 0;
  return Object.freeze({
    name: 'telnyx',
    network: 'https',
    getCallCount: () => calls,
    async sendOtpSms(request) {
      calls += 1;
      assertSmsProviderRequest(request);
      const config = readTelnyxConfig(env);
      if (!config.valid || request.environment !== config.environment) return failureResult('misconfigured');
      let message;
      try {
        message = buildOtpSmsMessage({
          code: request.code,
          expiresAt: request.expiresAt,
          now: now(),
          complianceSuffix: String(env.SMS_COMPLIANCE_SUFFIX || ''),
        });
      } catch {
        return failureResult('misconfigured');
      }
      const payload = {
        from: config.senderE164,
        to: request.toE164,
        text: message.body,
        type: 'SMS',
        encoding: 'gsm7',
        webhook_url: config.webhookUrl,
      };
      try {
        const response = await transport({
          apiKey: config.apiKey,
          messagingProfileId: config.profileId,
          body: payload,
          timeoutMs: config.timeoutMs,
        });
        const parsed = safeJson(response.body);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return normalizeTelnyxAcceptedResponse(parsed);
        }
        return classifyTelnyxHttpFailure(response.statusCode, parsed);
      } catch (error) {
        return failureResult(error && error.dispatched === false
          ? 'transient_preacceptance'
          : 'ambiguous_outcome');
      }
    },
  });
}

module.exports = {
  TELNYX_API_HOST,
  TELNYX_MESSAGE_PATH,
  TELNYX_WEBHOOK_PATH,
  TelnyxTransportError,
  classifyTelnyxHttpFailure,
  createTelnyxSmsProvider,
  normalizeTelnyxAcceptedResponse,
  normalizeTelnyxWebhookUrl,
  readTelnyxConfig,
  requestTelnyxMessage,
};
