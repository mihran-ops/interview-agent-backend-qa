const crypto = require('node:crypto');

const SUPPORT_TO = 'support@alphasourceai.com';
const SUPPORT_FROM = 'support-agent@alphasourceai.com';
const SUPPORT_TOOL = Object.freeze({
  type: 'function',
  name: 'send_support_message',
  description: 'Submit one brief issue summary to the alphaSource support team only after the caller explicitly chooses email escalation, confirms their name and reply email, and approves the summary. Ask for spelling when unclear; never guess. Never use for routine conversations or include candidate records, credentials, or transcripts.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Caller-approved issue summary, without sensitive records or credentials; maximum 1000 characters.' },
      contact_name: { type: 'string', description: 'Caller-provided name, spelling explicitly confirmed; maximum 120 characters. Ask for spelling when unclear.' },
      contact_email: { type: 'string', description: 'Reply email explicitly provided and confirmed by the caller. Ask for spelling when unclear; do not guess.' },
      confirmed: { type: 'boolean', description: 'True only after the caller explicitly approves sending this summary, name and reply email to support.' },
    },
    required: ['summary', 'contact_name', 'contact_email', 'confirmed'],
    additionalProperties: false,
  },
});

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateHandoff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'confirmed,contact_email,contact_name,summary' || value.confirmed !== true) return null;
  if (typeof value.summary !== 'string' || typeof value.contact_email !== 'string' || typeof value.contact_name !== 'string') return null;
  const name = value.contact_name.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name) || !/\p{L}/u.test(name)) return null;
  const summary = value.summary.trim();
  const email = value.contact_email.trim().toLowerCase();
  if (summary.length < 5 || summary.length > 1000 || /[\u0000-\u001f\u007f]/.test(summary)) return null;
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(email)) return null;
  // Block obvious credentials/links before they can enter team email. Do not log rejected input.
  if (/https?:\/\/|bearer\s|\b(?:sk-|SG\.)[a-z0-9_-]{12,}|\b\d{6}\b|\b(?:\d[ -]?){13,19}\b/i.test(`${name} ${summary}`)) return null;
  return { contact_name: name, summary, contact_email: email, confirmed: true };
}

function handoffEnabled(env = process.env) {
  return env.SUPPORT_HANDOFF_ENABLED === 'true' && typeof env.SENDGRID_API_KEY === 'string' && env.SENDGRID_API_KEY.length > 20;
}

function createSupportHandoff(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const rateLimit = options.rateLimit || require('./rateLimit').checkAndIncrementRateLimit;
  async function reserve(routeName, subjectKey, windowMs, maxCount) {
    let timer;
    try {
      return (await Promise.race([
        rateLimit({ routeName, subjectKey: hash(subjectKey), windowMs, maxCount }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('rate_timeout')), 2500); }),
      ]))?.allowed === true;
    } finally { clearTimeout(timer); }
  }
  async function send(value, { channel, requestKey } = {}) {
    if (!handoffEnabled(env)) return { status: 'unavailable' };
    const input = validateHandoff(value);
    if (!input || !['phone', 'dashboard'].includes(channel) || typeof requestKey !== 'string' || !requestKey || requestKey.length > 200) return { status: 'invalid_request' };
    const reference = hash(`${channel}:${requestKey}`).slice(0, 12);
    try {
      if (!await reserve('support_handoff_global', 'all', 3600000, 60) ||
          !await reserve('support_handoff_contact', input.contact_email, 3600000, 5)) return { status: 'rate_limited' };
      // Reserve before sending. A timeout must never trigger a duplicate send, including across instances.
      if (!await reserve('support_handoff_once', `${channel}:${requestKey}`, 86400000, 1)) return { status: 'already_attempted', reference };
    } catch { return { status: 'unavailable' }; }
    try {
      const response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: SUPPORT_TO }] }],
          from: { email: SUPPORT_FROM, name: 'alphaSource Support Agent' },
          reply_to: { email: input.contact_email, name: input.contact_name },
          subject: channel === 'phone' ? 'Support request from a phone conversation' : 'Support request from Talk with Support',
          content: [{ type: 'text/plain', value: `Hi team,\n\n${input.contact_name} ${channel === 'phone' ? 'called alphaSource' : 'used Talk with Support in the dashboard'} and asked me to pass along this message:\n\n${input.summary}\n\nThey approved sharing this with the team. You can reply directly to this email to reach them at ${input.contact_email}.\n\nThanks,\nalphaSource Support\n\nPlease confirm their identity before discussing private account details or making account changes.` }],
          tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
        }),
      });
      return { status: response.status === 202 ? 'accepted' : 'failed', reference };
    } catch { return { status: 'unknown', reference }; }
  }
  return { send, enabled: () => handoffEnabled(env) };
}

function createPhoneHandoffRouter(options = {}) {
  const express = require('express');
  const router = express.Router();
  const env = options.env || process.env;
  const service = options.service || createSupportHandoff(options);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const secret = String(env.SUPPORT_PHONE_HANDOFF_TOKEN || '');
    const actual = String(req.headers.authorization || '');
    const expected = `Bearer ${secret}`;
    if (!service.enabled() || secret.length < 32) return res.status(503).json({ status: 'unavailable' });
    if (req.headers.origin || actual.length > 512 ||
        !crypto.timingSafeEqual(Buffer.from(hash(actual), 'hex'), Buffer.from(hash(expected), 'hex'))) return res.status(401).json({ status: 'unauthorized' });
    next();
  });
  router.post('/', express.json({ limit: '4kb', strict: true }), async (req, res) => {
    const input = validateHandoff(req.body);
    if (!input) return res.status(400).json({ status: 'invalid_request' });
    const result = await service.send(input, { channel: 'phone', requestKey: hash(JSON.stringify(input)) });
    res.status(result.status === 'accepted' ? 200 : result.status === 'invalid_request' ? 400 : 503).json(result);
  });
  router.use((_error, _req, res, _next) => res.status(400).json({ status: 'invalid_request' }));
  return router;
}

module.exports = { SUPPORT_TOOL, SUPPORT_FROM, SUPPORT_TO, validateHandoff, handoffEnabled, createSupportHandoff, createPhoneHandoffRouter };
