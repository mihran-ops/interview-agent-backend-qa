'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const sg = require('@sendgrid/mail');
const { supabaseAdmin } = require('../../clients/supabase');
const { buildBrandedEmailShell, escapeHtml } = require('../../clients/sendgrid');

const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
const SEND_FROM = process.env.SENDGRID_FROM || 'no-reply@alphasourceai.com';
if (SENDGRID_KEY) {
  try { sg.setApiKey(SENDGRID_KEY); } catch (e) { console.error('[feedback] failed to set SendGrid key:', e?.message || e); }
} else {
  console.warn('[feedback] SENDGRID_API_KEY not set; feedback emails will be skipped');
}

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10MB, up to 5 screenshots
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    if (!ok.includes(ext)) return cb(new Error('Only image uploads are allowed.'));
    cb(null, true);
  }
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUCKET = process.env.SUPABASE_FEEDBACK_BUCKET || 'feedback-attachments';
const FEEDBACK_SUBMIT_RATE_WINDOW_MS = 60 * 60 * 1000;
const FEEDBACK_SUBMIT_RATE_MAX = 10;
const feedbackSubmitRateBuckets = new Map();

function feedbackSubmitRateLimit(req, res, next) {
  const now = Date.now();
  const ip = String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
  const current = feedbackSubmitRateBuckets.get(ip);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + FEEDBACK_SUBMIT_RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  feedbackSubmitRateBuckets.set(ip, bucket);
  if (bucket.count > FEEDBACK_SUBMIT_RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      detail: 'Too many requests. Please try again later.',
      request_id: req.request_id || null
    });
  }
  return next();
}

router.get('/options', async (_req, res) => {
  try {
    const issues = await supabaseAdmin
      .from('feedback_issues_catalog')
      .select('id,title,description,status')
      .eq('status', 'open');

    const suggestions = await supabaseAdmin
      .from('feedback_suggestions_catalog')
      .select('id,title,description,status')
      .eq('status', 'open');

    return res.json({
      issues: Array.isArray(issues.data) ? issues.data : [],
      suggestions: Array.isArray(suggestions.data) ? suggestions.data : []
    });
  } catch (e) {
    console.error('[feedback/options] error:', e?.message || e);
    return res.json({ issues: [], suggestions: [] });
  }
});

router.post('/submit', feedbackSubmitRateLimit, upload.array('screenshots', 5), async (req, res) => {
  try {
    const {
      name,
      email,
      browser,
      deviceType,
      selectedIssueIds,
      selectedSuggestionIds,
      newIssueText,
      newSuggestionText
    } = req.body || {};

    if (!name || !email || !browser || !deviceType) {
      return res.status(400).json({
        error: 'validation_error',
        code: 'VALIDATION_ERROR',
        detail: 'name, email, browser, and deviceType are required.',
        hint: 'Provide required fields.',
        request_id: req.request_id || null
      });
    }
    if (!EMAIL_REGEX.test(String(email).trim())) {
      return res.status(400).json({
        error: 'invalid_email',
        code: 'VALIDATION_ERROR',
        detail: 'Email format is invalid.',
        hint: 'Use a valid email address.',
        request_id: req.request_id || null
      });
    }
    const device = deviceType === 'Desktop' || deviceType === 'Mobile' ? deviceType : null;
    if (!device) {
      return res.status(400).json({
        error: 'invalid_device',
        code: 'VALIDATION_ERROR',
        detail: 'deviceType must be Desktop or Mobile.',
        hint: 'Choose Desktop or Mobile.',
        request_id: req.request_id || null
      });
    }

    let issueIds = [];
    let suggestionIds = [];
    try { issueIds = JSON.parse(selectedIssueIds || '[]'); } catch {}
    try { suggestionIds = JSON.parse(selectedSuggestionIds || '[]'); } catch {}
    if (!Array.isArray(issueIds)) issueIds = [];
    if (!Array.isArray(suggestionIds)) suggestionIds = [];

    // Upload screenshots (optional)
    const screenshot_urls = [];
    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        try {
          const key = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${file.originalname}`;
          const up = await supabaseAdmin.storage.from(BUCKET).upload(key, file.buffer, {
            contentType: file.mimetype || 'application/octet-stream',
            upsert: true
          });
          if (up.error) {
            console.error('[feedback/upload] failed:', up.error.message);
            continue;
          }
          const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(key);
          screenshot_urls.push(pub?.publicUrl || `${BUCKET}/${key}`);
        } catch (e) {
          console.error('[feedback/upload] unexpected:', e?.message || e);
        }
      }
    }

    // Insert submission
    let submissionId = null;
    const insertResp = await supabaseAdmin
      .from('feedback_submissions')
      .insert({
        name,
        email,
        browser,
        device_type: device,
        selected_issue_ids: issueIds,
        selected_suggestion_ids: suggestionIds,
        new_issue_text: newIssueText || '',
        new_suggestion_text: newSuggestionText || '',
        screenshot_urls
      })
      .select('id')
      .single();

    if (insertResp.error) {
      console.error('[feedback/submit] insert error:', insertResp.error.message);
      return res.status(500).json({
        error: 'feedback_insert_failed',
        code: 'DB_ERROR',
        detail: insertResp.error.message,
        hint: 'Check database tables and permissions.',
        request_id: req.request_id || null
      });
    }
    submissionId = insertResp.data?.id || null;

    // Fetch titles for email context
    let issueTitles = [];
    let suggestionTitles = [];
    try {
      if (issueIds.length) {
        const q = await supabaseAdmin.from('feedback_issues_catalog').select('id,title').in('id', issueIds);
        if (!q.error && Array.isArray(q.data)) issueTitles = q.data.map((r) => r.title).filter(Boolean);
      }
      if (suggestionIds.length) {
        const q = await supabaseAdmin.from('feedback_suggestions_catalog').select('id,title').in('id', suggestionIds);
        if (!q.error && Array.isArray(q.data)) suggestionTitles = q.data.map((r) => r.title).filter(Boolean);
      }
    } catch (_) {}

    // Send email (best effort)
    if (SENDGRID_KEY) {
      const lines = [];
      lines.push(`Name: ${name}`);
      lines.push(`Email: ${email}`);
      lines.push(`Browser: ${browser}`);
      lines.push(`Device: ${device}`);
      lines.push('');
      lines.push('Issues:');
      if (issueTitles.length) issueTitles.forEach((t) => lines.push(`- ${t}`)); else lines.push('- (none selected)');
      if (newIssueText) {
        lines.push('Other Issue:');
        lines.push(newIssueText);
      }
      lines.push('');
      lines.push('Suggestions:');
      if (suggestionTitles.length) suggestionTitles.forEach((t) => lines.push(`- ${t}`)); else lines.push('- (none selected)');
      if (newSuggestionText) {
        lines.push('Other Suggestion:');
        lines.push(newSuggestionText);
      }
      if (screenshot_urls.length) {
        lines.push('');
        lines.push('Screenshots:');
        screenshot_urls.forEach((u) => lines.push(u));
      }
      const issuesHtml = issueTitles.length
        ? issueTitles.map((t) => `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;">${escapeHtml(t)}</li>`).join('')
        : '<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;">(none selected)</li>';
      const suggestionsHtml = suggestionTitles.length
        ? suggestionTitles.map((t) => `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;">${escapeHtml(t)}</li>`).join('')
        : '<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;">(none selected)</li>';
      const screenshotsHtml = screenshot_urls.length
        ? screenshot_urls.map((u) => `<li style="margin:0 0 6px 18px;font-size:13px;line-height:1.5;"><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">${escapeHtml(u)}</a></li>`).join('')
        : '';

      const msg = {
        to: 'info@alphasourceai.com',
        from: SEND_FROM,
        subject: `New Tester Feedback – ${browser} (${device})`,
        text: lines.join('\n'),
        html: buildBrandedEmailShell({
          title: 'New tester feedback',
          preheader: `New tester feedback from ${escapeHtml(browser)} (${escapeHtml(device)}).`,
          helpEmail: '',
          footerNote: 'Notification from alphaScreen feedback intake.',
          contentHtml: `
            <table role="presentation" width="100%" style="margin:0 0 14px;">
              <tr><td style="padding:5px 0;color:#9FB0FF;font-size:13px;line-height:1.4;width:120px;vertical-align:top;">Name</td><td style="padding:5px 0;color:#E6EBFF;font-size:13px;line-height:1.4;vertical-align:top;">${escapeHtml(name)}</td></tr>
              <tr><td style="padding:5px 0;color:#9FB0FF;font-size:13px;line-height:1.4;width:120px;vertical-align:top;">Email</td><td style="padding:5px 0;color:#E6EBFF;font-size:13px;line-height:1.4;vertical-align:top;">${escapeHtml(email)}</td></tr>
              <tr><td style="padding:5px 0;color:#9FB0FF;font-size:13px;line-height:1.4;width:120px;vertical-align:top;">Browser</td><td style="padding:5px 0;color:#E6EBFF;font-size:13px;line-height:1.4;vertical-align:top;">${escapeHtml(browser)}</td></tr>
              <tr><td style="padding:5px 0;color:#9FB0FF;font-size:13px;line-height:1.4;width:120px;vertical-align:top;">Device</td><td style="padding:5px 0;color:#E6EBFF;font-size:13px;line-height:1.4;vertical-align:top;">${escapeHtml(device)}</td></tr>
            </table>
            <p style="margin:0 0 6px;color:#9FB0FF;font-size:12px;line-height:1.4;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Issues</p>
            <ul style="margin:0 0 12px;padding:0;">
              ${issuesHtml}
            </ul>
            ${newIssueText ? `
              <p style="margin:0 0 6px;color:#9FB0FF;font-size:12px;line-height:1.4;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Other Issue</p>
              <p style="margin:0 0 12px;color:#E6EBFF;font-size:13px;line-height:1.6;">${escapeHtml(newIssueText).replace(/\n/g, '<br />')}</p>
            ` : ''}
            <p style="margin:0 0 6px;color:#9FB0FF;font-size:12px;line-height:1.4;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Suggestions</p>
            <ul style="margin:0 0 12px;padding:0;">
              ${suggestionsHtml}
            </ul>
            ${newSuggestionText ? `
              <p style="margin:0 0 6px;color:#9FB0FF;font-size:12px;line-height:1.4;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Other Suggestion</p>
              <p style="margin:0 0 12px;color:#E6EBFF;font-size:13px;line-height:1.6;">${escapeHtml(newSuggestionText).replace(/\n/g, '<br />')}</p>
            ` : ''}
            ${screenshotsHtml ? `
              <p style="margin:0 0 6px;color:#9FB0FF;font-size:12px;line-height:1.4;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Screenshots</p>
              <ul style="margin:0 0 12px;padding:0;">
                ${screenshotsHtml}
              </ul>
            ` : ''}
          `
        })
      };
      sg.send(msg).catch((err) => {
        console.error('[feedback/email] send error:', err?.message || err);
      });
    }

    return res.json({ success: true, submission_id: submissionId });
  } catch (e) {
    console.error('[feedback/submit] unexpected:', e?.message || e);
    return res.status(500).json({
      error: 'feedback_submit_failed',
      code: 'SERVER_ERROR',
      detail: e?.message || 'Server error',
      hint: 'Check server logs.',
      request_id: req.request_id || null
    });
  }
});

module.exports = router;
