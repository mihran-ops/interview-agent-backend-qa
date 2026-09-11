'use strict';

const express = require('express');
const { supabaseAdmin } = require('../../clients/supabase');

const router = express.Router();
const EVENT_NAME_RE = /^[a-z][a-z0-9_]{1,80}$/;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 180;
const rateBuckets = new Map();
const MAX_EVENTS_PER_REQUEST = 10;
const MAX_ARRAY_ITEMS = 20;
const MAX_PROPERTY_STRING = 180;
const SENSITIVE_PROPERTY_KEY_RE = /(password|token|secret|auth|authorization|cookie|session|ip|user[_-]?agent|message)/i;
// Keep this in sync with public frontend analytics emitters before adding new events.
const ALLOWED_EVENT_NAMES = new Set([
  'page_view',
  'page_viewed',
  'cta_clicked',
  'lead_form_viewed',
  'lead_form_started',
  'lead_form_field_completed',
  'lead_form_submit',
  'lead_form_submit_attempted',
  'lead_form_submit_failed',
  'lead_form_submit_succeeded',
  'lead_form_abandoned',
  'lead_draft_saved',
  'lead_draft_save_failed',
  'pricing_page_viewed',
  'plan_selected',
  'signup_started',
  'signup_back_clicked',
  'signup_step_viewed',
  'signup_step_completed',
  'checkout_started',
  'checkout_completed',
  'checkout_failed',
  'checkout_abandoned',
  'signup_completed',
]);
const SAFE_UTM_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
]);
const COMMON_PROPERTY_KEYS = new Set([
  'path',
  'section',
]);
const EVENT_PROPERTY_KEYS = {
  page_view: ['path', 'section'],
  page_viewed: ['path', 'section'],
  cta_clicked: ['cta_label', 'cta_target', 'placement'],
  lead_form_viewed: ['form_id', 'form_type', 'product_interest'],
  lead_form_started: ['form_id', 'form_type', 'product_interest', 'first_field'],
  lead_form_field_completed: ['form_id', 'form_type', 'product_interest', 'field_name'],
  lead_form_submit: ['form_id', 'form_type', 'product_interest', 'status'],
  lead_form_submit_attempted: ['form_id', 'form_type', 'product_interest'],
  lead_form_submit_failed: ['form_id', 'form_type', 'product_interest', 'error_type'],
  lead_form_submit_succeeded: ['form_id', 'form_type', 'product_interest'],
  lead_form_abandoned: ['form_id', 'form_type', 'product_interest', 'fields_completed'],
  lead_draft_saved: ['form_id', 'form_type', 'product_interest', 'status', 'fields_completed'],
  lead_draft_save_failed: ['form_id', 'form_type', 'product_interest', 'status', 'error_type'],
  pricing_page_viewed: ['plan', 'step'],
  plan_selected: ['plan', 'step'],
  signup_started: ['plan', 'step'],
  signup_back_clicked: ['plan', 'step'],
  signup_step_viewed: ['plan', 'step', 'completion_percent'],
  signup_step_completed: ['plan', 'step', 'completion_percent'],
  checkout_started: ['plan', 'step', 'completion_percent'],
  checkout_completed: ['plan', 'step', 'completion_percent'],
  checkout_failed: ['plan', 'step', 'completion_percent', 'error_type'],
  checkout_abandoned: ['plan', 'step', 'completion_percent'],
  signup_completed: ['plan', 'step', 'completion_percent'],
};
const ARRAY_PROPERTY_KEYS = new Set(['fields_completed']);
const FIELD_NAME_PROPERTY_KEYS = new Set(['field_name', 'first_field']);

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
  const current = rateBuckets.get(ip);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      request_id: req.request_id || null,
    });
  }
  return next();
}

function trimText(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function cleanPath(value) {
  const raw = trimText(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://www.alphasourceai.com');
    return trimText(url.pathname || '/', 300);
  } catch (_) {
    return trimText(raw.split('?')[0].split('#')[0], 300);
  }
}

function allowedPropertyKeys(eventName) {
  return new Set([
    ...COMMON_PROPERTY_KEYS,
    ...(EVENT_PROPERTY_KEYS[eventName] || []),
  ]);
}

function normalizeArrayProperty(value) {
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(
    value
      .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
      .map((item) => trimText(item, 80))
      .filter((item) => !SENSITIVE_PROPERTY_KEY_RE.test(item))
      .filter(Boolean)
      .slice(0, MAX_ARRAY_ITEMS)
  ));
}

function normalizeScalarProperty(key, value) {
  if (value === null || value === undefined) return undefined;
  if (key === 'completion_percent') {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return undefined;
    return Math.max(0, Math.min(100, Math.round(numberValue)));
  }
  if (key === 'cta_target' || key === 'path') {
    return cleanPath(value) || trimText(value, MAX_PROPERTY_STRING);
  }
  if (FIELD_NAME_PROPERTY_KEYS.has(key)) {
    const fieldName = trimText(value, 80);
    return SENSITIVE_PROPERTY_KEY_RE.test(fieldName) ? undefined : fieldName;
  }
  if (typeof value === 'string') return trimText(value, MAX_PROPERTY_STRING);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function normalizeAllowedProperties(eventName, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowedKeys = allowedPropertyKeys(eventName);
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = trimText(rawKey, 80);
    if (!key || !allowedKeys.has(key) || SENSITIVE_PROPERTY_KEY_RE.test(key)) continue;
    if (ARRAY_PROPERTY_KEYS.has(key)) {
      const normalizedArray = normalizeArrayProperty(rawValue);
      if (normalizedArray && normalizedArray.length) out[key] = normalizedArray;
      continue;
    }
    if (Array.isArray(rawValue) || (rawValue && typeof rawValue === 'object')) continue;
    const normalized = normalizeScalarProperty(key, rawValue);
    if (normalized !== undefined && normalized !== '') out[key] = normalized;
  }
  return out;
}

function normalizeUtm(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = trimText(rawKey, 80);
    if (!SAFE_UTM_KEYS.has(key) || SENSITIVE_PROPERTY_KEY_RE.test(key)) continue;
    const normalized = normalizeScalarProperty(key, rawValue);
    if (normalized !== undefined && normalized !== '') out[key] = normalized;
  }
  return out;
}

function normalizeOccurredAt(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function toEventRows(req) {
  const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [req.body];
  const events = rawEvents.slice(0, MAX_EVENTS_PER_REQUEST);
  const invalidEvent = events.find((event) => {
    const eventName = trimText(event?.event_name, 100);
    return !EVENT_NAME_RE.test(eventName) || !ALLOWED_EVENT_NAMES.has(eventName);
  });
  if (invalidEvent) return null;
  return events.map((event) => {
    const eventName = trimText(event?.event_name, 100);
    return {
      event_name: eventName,
      anonymous_id: trimText(event?.anonymous_id, 120),
      session_id: trimText(event?.session_id, 120),
      path: cleanPath(event?.path) || '/',
      page_title: trimText(event?.page_title, 180),
      referrer_path: cleanPath(event?.referrer_path),
      utm: normalizeUtm(event?.utm),
      properties: normalizeAllowedProperties(eventName, event?.properties),
      occurred_at: normalizeOccurredAt(event?.occurred_at),
      request_id: req.request_id || null,
    };
  });
}

router.post('/events', rateLimit, async (req, res) => {
  try {
    const rows = toEventRows(req);
    if (!rows || rows.length === 0) {
      return res.status(400).json({
        error: 'invalid_event',
        code: 'VALIDATION_ERROR',
        request_id: req.request_id || null,
      });
    }

    const { error } = await supabaseAdmin
      .from('public_analytics_events')
      .insert(rows);

    if (error) {
      console.error('[public-analytics/events] insert error:', error.message);
      return res.status(503).json({
        error: 'analytics_not_configured',
        code: 'ANALYTICS_TABLE_ERROR',
        detail: error.message,
        request_id: req.request_id || null,
      });
    }

    return res.status(202).json({
      ok: true,
      accepted: rows.length,
      request_id: req.request_id || null,
    });
  } catch (e) {
    console.error('[public-analytics/events] unexpected:', e?.message || e);
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      request_id: req.request_id || null,
    });
  }
});

module.exports = router;
