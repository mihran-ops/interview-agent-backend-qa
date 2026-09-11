'use strict';

const crypto = require('crypto');
const { getOtpSecret } = require('../services/otpChallenge');

const COOKIE_NAME = '__Host-alphascreen_otp_launch';
const HEADER_NAME = 'x-alphascreen-otp-launch';
const PURPOSE = 'interview_launch';
const TTL_SECONDS = 5 * 60;
const MAX_TOKEN_LENGTH = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(encodedPayload, env = process.env) {
  const version = Number(env.OTP_HMAC_SECRET_VERSION || 1);
  return crypto.createHmac('sha256', getOtpSecret(version, env))
    .update(`otp-launch-capability:v1:${encodedPayload}`)
    .digest('base64url');
}

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 512) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== raw) return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function createOtpLaunchCapability(binding, { now = Date.now(), env = process.env } = {}) {
  const payload = {
    v: 1,
    purpose: PURPOSE,
    challenge_id: String(binding.challenge_id || '').trim().toLowerCase(),
    candidate_id: String(binding.candidate_id || '').trim().toLowerCase(),
    client_id: String(binding.client_id || '').trim().toLowerCase(),
    role_id: String(binding.role_id || '').trim().toLowerCase(),
    submission_id: binding.submission_id ? String(binding.submission_id).trim().toLowerCase() : null,
    interview_attempt_id: binding.interview_attempt_id ? String(binding.interview_attempt_id).trim().toLowerCase() : null,
    request_origin: normalizeOrigin(binding.request_origin),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + TTL_SECONDS,
  };
  for (const key of ['challenge_id', 'candidate_id', 'client_id', 'role_id']) {
    if (!UUID_RE.test(payload[key])) throw new Error(`invalid launch capability ${key}`);
  }
  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload, env)}`;
}

function verifyOtpLaunchCapability(token, { now = Date.now(), env = process.env } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const expected = sign(parts[0], env);
  const supplied = parts[1];
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  const nowSeconds = Math.floor(now / 1000);
  if (payload?.v !== 1 || payload?.purpose !== PURPOSE || !Number.isInteger(payload?.exp)
    || payload.exp <= nowSeconds || payload.exp > nowSeconds + TTL_SECONDS + 5) return null;
  for (const key of ['challenge_id', 'candidate_id', 'client_id', 'role_id']) {
    if (!UUID_RE.test(String(payload?.[key] || ''))) return null;
  }
  if (payload.request_origin !== null && normalizeOrigin(payload.request_origin) !== payload.request_origin) return null;
  return payload;
}

function parseCookie(req, name) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

function cookieAttributes(maxAge) {
  // Browser-enforced __Host- contract: Secure, no Domain, and exactly Path=/.
  return `Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function setOtpLaunchCapability(res, binding, options = {}) {
  const token = createOtpLaunchCapability(binding, options);
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(TTL_SECONDS)}`);
  return token;
}

function clearOtpLaunchCapability(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes(0)}`);
}

function readHeaderCapability(req) {
  const raw = req.headers?.[HEADER_NAME];
  if (raw === undefined) return { present: false, token: '' };
  if (typeof raw !== 'string') return { present: true, token: '' };
  const token = raw.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || /[\r\n,]/.test(token)) {
    return { present: true, token: '' };
  }
  return { present: true, token };
}

function requireOtpLaunchCapability(req, res, next) {
  let capability;
  try {
    const header = readHeaderCapability(req);
    const cookieToken = parseCookie(req, COOKIE_NAME);
    if (header.present && cookieToken && header.token !== cookieToken) throw new Error('conflicting launch capability transports');
    const token = header.present ? header.token : cookieToken;
    capability = verifyOtpLaunchCapability(token);
    if (header.present && capability?.request_origin !== normalizeOrigin(req.headers?.origin)) {
      capability = null;
    }
  } catch (_) {
    capability = null;
  }
  const candidateId = String(req.body?.candidate_id || '').trim().toLowerCase();
  const roleId = String(req.body?.role_id || '').trim().toLowerCase();
  if (!capability || capability.candidate_id !== candidateId || capability.role_id !== roleId) {
    clearOtpLaunchCapability(res);
    return res.status(401).json({
      error: 'verification_required',
      code: 'OTP_LAUNCH_CAPABILITY_REQUIRED',
      detail: 'Please verify your one-time code again before starting the interview.',
      request_id: req.request_id || null,
    });
  }
  req.otp_launch_capability = capability;
  return next();
}

module.exports = {
  COOKIE_NAME,
  HEADER_NAME,
  TTL_SECONDS,
  clearOtpLaunchCapability,
  createOtpLaunchCapability,
  normalizeOrigin,
  requireOtpLaunchCapability,
  setOtpLaunchCapability,
  verifyOtpLaunchCapability,
};
