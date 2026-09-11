'use strict';

const express = require('express');
const sg = require('@sendgrid/mail');
const { supabaseAdmin } = require('../../clients/supabase');
const { buildBrandedEmailShell, escapeHtml } = require('../../clients/sendgrid');
const { authenticateSendgridWebhook } = require('../../services/sendgridWebhookAuth');

const router = express.Router();

const STORED_EVENTS = new Set(['processed', 'delivered', 'deferred', 'bounce', 'dropped', 'spamreport']);
const PROBLEM_EVENTS = new Set(['deferred', 'bounce', 'dropped', 'spamreport']);
const ALERT_EVENTS = new Set(['bounce', 'dropped', 'spamreport']);
const TIME_SENSITIVE_CATEGORIES = new Set([
  'otp',
  'password_reset',
  'member_recovery',
  'supabase_auth_recovery',
  'agreement_signing',
  'subscription_checkout',
  'member_access'
]);
const ALERT_EMAIL = 'emaildelivery@alphasourceai.com';

function cleanText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function firstCategory(value) {
  if (Array.isArray(value)) {
    return cleanText(value.find((item) => cleanText(item)));
  }
  return cleanText(value);
}

function toIsoFromUnix(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function inferSupabaseAuthCategory({ explicitCategory, subject, fromEmail, templateId }) {
  if (explicitCategory) return null;
  const recoveryTemplateId = cleanText(process.env.SENDGRID_SUPABASE_AUTH_RECOVERY_TEMPLATE_ID);
  if (recoveryTemplateId && cleanText(templateId) === recoveryTemplateId) return 'supabase_auth_recovery';

  const subjectText = String(subject || '').trim().toLowerCase();
  if (
    subjectText.includes('set password') ||
    subjectText.includes('reset') ||
    subjectText.includes('password') ||
    subjectText.includes('recovery')
  ) {
    return 'supabase_auth_recovery';
  }

  const authFrom = normalizeEmail(process.env.SUPABASE_AUTH_EMAIL_FROM);
  if (authFrom && normalizeEmail(fromEmail) === authFrom) return 'supabase_auth_unknown';
  return null;
}

function normalizeEvent(raw) {
  const event = asObject(raw);
  const eventType = String(event.event || '').trim().toLowerCase();
  if (!STORED_EVENTS.has(eventType)) return null;

  const customArgs = asObject(event.custom_args);
  const uniqueArgs = asObject(event.unique_args);
  const mergedArgs = { ...uniqueArgs, ...customArgs };
  const category = firstCategory(event.category);
  const explicitEmailCategory = cleanText(mergedArgs.email_category) || cleanText(mergedArgs.category) || category;
  const subject = cleanText(event.subject);
  const fromEmail = cleanText(event.from_email) || cleanText(event.from);
  const templateId = cleanText(event.sg_template_id);
  const inferredCategory = inferSupabaseAuthCategory({
    explicitCategory: explicitEmailCategory,
    subject,
    fromEmail,
    templateId
  });
  const emailCategory = explicitEmailCategory || inferredCategory;
  const isTimeSensitive = TIME_SENSITIVE_CATEGORIES.has(String(emailCategory || '').trim().toLowerCase());

  return {
    event_at: toIsoFromUnix(event.timestamp),
    event_type: eventType,
    email: cleanText(event.email),
    sg_event_id: cleanText(event.sg_event_id),
    sg_message_id: cleanText(event.sg_message_id),
    smtp_id: cleanText(event['smtp-id'] || event.smtp_id),
    category,
    email_category: emailCategory,
    custom_args: Object.keys(mergedArgs).length ? mergedArgs : null,
    reason: cleanText(event.reason),
    status: cleanText(event.status),
    response: cleanText(event.response),
    attempt: Number.isFinite(Number(event.attempt)) ? Number(event.attempt) : null,
    url: cleanText(event.url),
    ip: cleanText(event.ip),
    useragent: cleanText(event.useragent),
    tls: cleanText(event.tls),
    sg_template_id: templateId,
    subject,
    from_email: fromEmail,
    raw_payload: event,
    is_problem: PROBLEM_EVENTS.has(eventType),
    is_time_sensitive: isTimeSensitive
  };
}

async function insertDeliveryEvent(payload) {
  const { data, error } = await supabaseAdmin
    .from('email_delivery_events')
    .insert(payload)
    .select('id')
    .maybeSingle();
  if (!error) return { id: data?.id || null, inserted: true };

  if (String(error?.code || '') === '23505' && payload.sg_event_id) {
    const existing = await supabaseAdmin
      .from('email_delivery_events')
      .select('id')
      .eq('sg_event_id', payload.sg_event_id)
      .maybeSingle();
    return { id: existing?.data?.id || null, inserted: false };
  }
  throw error;
}

function shouldAlert(payload) {
  const email = normalizeEmail(payload.email);
  const category = String(payload.email_category || '').trim().toLowerCase();
  if (email === ALERT_EMAIL || category === 'email_delivery_alert') return false;
  if (ALERT_EVENTS.has(payload.event_type)) return true;
  return payload.event_type === 'deferred' && payload.is_time_sensitive === true;
}

async function sendAlert(payload) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.SENDGRID_FROM;
  if (!apiKey) throw new Error('SENDGRID_API_KEY missing');
  if (!from) throw new Error('SENDGRID_FROM missing');
  sg.setApiKey(apiKey);

  const subject = `[alphaScreen email] ${payload.event_type} ${payload.email || ''}`.trim();
  const detailRows = [
    ['Event', payload.event_type],
    ['Recipient', payload.email],
    ['Category', payload.email_category || payload.category],
    ['Reason', payload.reason],
    ['Status', payload.status],
    ['Response', payload.response],
    ['Message ID', payload.sg_message_id],
    ['Event ID', payload.sg_event_id],
    ['Time sensitive', payload.is_time_sensitive ? 'yes' : 'no']
  ].filter(([, value]) => cleanText(value));

  const html = buildBrandedEmailShell({
    title: 'Email delivery problem',
    preheader: `SendGrid reported ${payload.event_type} for ${payload.email || 'a recipient'}.`,
    helpEmail: '',
    footerNote: 'Internal delivery alert from alphaScreen.',
    contentHtml: `
      <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
        SendGrid reported a transactional email delivery problem.
      </p>
      <table role="presentation" width="100%" style="margin:0 0 14px;">
        ${detailRows.map(([label, value]) => `
          <tr>
            <td style="padding:5px 0;color:#6A76A2;font-size:13px;line-height:1.4;width:130px;vertical-align:top;">${escapeHtml(label)}</td>
            <td style="padding:5px 0;color:#0A1547;font-size:13px;line-height:1.4;vertical-align:top;">${escapeHtml(value)}</td>
          </tr>
        `).join('')}
      </table>
    `
  });

  const [resp] = await sg.send({
    to: ALERT_EMAIL,
    from,
    subject,
    html,
    categories: ['email_delivery_alert'],
    custom_args: { email_category: 'email_delivery_alert' }
  });
  return resp?.statusCode || 0;
}

router.post('/', async (req, res) => {
  const authentication = authenticateSendgridWebhook({
    env: process.env,
    getHeader: (name) => req.get(name),
    rawBody: req.raw_body,
    querySecret: req.query?.secret,
  });
  if (!authentication.ok) {
    return res.status(authentication.status).json({ error: authentication.code });
  }

  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  let stored = 0;
  let skipped = 0;
  let alerted = 0;
  let errors = 0;

  for (const rawEvent of req.body) {
    const payload = normalizeEvent(rawEvent);
    if (!payload) {
      skipped += 1;
      continue;
    }

    let rowId = null;
    let inserted = false;
    try {
      const result = await insertDeliveryEvent(payload);
      rowId = result.id;
      inserted = result.inserted === true;
      if (inserted) stored += 1;
      else skipped += 1;
    } catch (err) {
      errors += 1;
      console.error('[sendgrid-webhook] event_store_failed', {
        event_type: payload.event_type,
        sg_event_id: payload.sg_event_id,
        email: payload.email,
        error: err?.message || err,
        code: err?.code || null
      });
      continue;
    }

    if (!inserted || !rowId || !shouldAlert(payload)) continue;

    try {
      await sendAlert(payload);
      alerted += 1;
      await supabaseAdmin
        .from('email_delivery_events')
        .update({ alert_sent_at: new Date().toISOString(), alert_error: null })
        .eq('id', rowId);
    } catch (alertErr) {
      await supabaseAdmin
        .from('email_delivery_events')
        .update({ alert_error: String(alertErr?.message || alertErr || 'alert_failed') })
        .eq('id', rowId);
    }
  }

  return res.status(200).json({ ok: true, stored, skipped, alerted, errors });
});

module.exports = router;
