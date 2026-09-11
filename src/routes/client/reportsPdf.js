const router = require('express').Router();
const { htmlToPdf } = require('../../render/pdfRenderer');
const { buildCandidateReportHtml } = require('../../render/candidateReport');
const Sentry = require('@sentry/node');
const { supabaseAdmin } = require('../../clients/supabase');
const {
  normalizePrimitiveString,
  normalizeUuid,
} = require('../../services/strictRequestValidation');
const {
  ServiceRoleAuthorizationError,
  assertReportBindings,
} = require('../../services/serviceRoleAuthorization');

const REPORTS_BUCKET = process.env.REPORTS_BUCKET || 'reports';

// Signed URL defaults
const DEFAULT_SIGNED_SECS = 90; // short-lived; FE will open immediately
const MIN_SIGNED_SECS = 15;
const MAX_SIGNED_SECS = 600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return normalizeUuid(value) !== null;
}

function invalidUuidResponse(res, field) {
  return res.status(400).json({ error: 'bad_request', code: 'invalid_identifier', detail: `${field} must be a UUID.` });
}

function scopedClientIds(req) {
  return Array.from(new Set([
    ...(Array.isArray(req?.clientIds) ? req.clientIds : []),
    ...(Array.isArray(req?.client_memberships) ? req.client_memberships : []),
    ...(Array.isArray(req?.memberships) ? req.memberships.map((item) => item?.client_id) : []),
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

const RESUME_SCORE_FIELDS = [
  'resume_score',
  'skills_match_percent',
  'education_match_percent',
  'experience_match_percent',
  'overall_resume_match_percent',
];

function safeResumeScore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function sanitizeResumeBreakdown(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safe = {};
  for (const field of RESUME_SCORE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const score = safeResumeScore(value[field]);
    if (score !== null || value[field] === null) safe[field] = score;
  }
  if (Object.hasOwn(value, 'summary')) {
    const summary = normalizePrimitiveString(value.summary, {
      required: false,
      allowEmpty: true,
      maxCodePoints: 4000,
      maxBytes: 16000,
    });
    if (summary !== null && summary !== undefined) safe.summary = summary;
  }
  if (!Object.keys(safe).length) return null;
  return Buffer.byteLength(JSON.stringify(safe), 'utf8') <= 16384 ? safe : null;
}

// Extract a storage key from a Supabase public/signed URL or return as-is if already a key
function keyFromUrl(url) {
  if (!url) return null;
  try {
    // public: .../storage/v1/object/public/{bucket}/{key...}
    const pubMarker = `/storage/v1/object/public/${REPORTS_BUCKET}/`;
    const signMarker = `/storage/v1/object/sign/${REPORTS_BUCKET}/`;
    const pubIdx = url.indexOf(pubMarker);
    if (pubIdx !== -1) {
      return url.substring(pubIdx + pubMarker.length);
    }
    const signIdx = url.indexOf(signMarker);
    if (signIdx !== -1) {
      // strip any token/query after the key
      const after = url.substring(signIdx + signMarker.length);
      const q = after.indexOf('?');
      return q === -1 ? after : after.substring(0, q);
    }
    // If it looks like a bare key (no scheme and no storage path), just return it
    if (!/^https?:\/\//i.test(url)) return url;
  } catch (_) {}
  return null;
}

// Lightweight health check to verify router is mounted
router.get('/preview-health', (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

function extractData(body) {
  // Accept either { data: {...} } or raw {...}
  if (body && typeof body === 'object' && body.data && typeof body.data === 'object') {
    return body.data;
  }
  return body || {};
}

// HTML preview for quick layout checks (no PDF)
// POST /api/reports/preview-html
router.post('/preview-html', async (req, res) => {
  try {
    const data = extractData(req.body);
    const html = buildCandidateReportHtml(data);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[reports/html-preview] error:', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { endpoint: '/reports/preview-html' } });
    }
    return res.status(500).json({ error: 'HTML render failed' });
  }
});

router.post('/preview-pdf', async (req, res) => {
  try {
    const data = extractData(req.body);
    const html = buildCandidateReportHtml(data);
    const pdf = await htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="candidate-report.pdf"');
    return res.send(pdf);
  } catch (err) {
    console.error('[reports/preview-pdf] error:', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { endpoint: '/reports/preview-pdf' } });
    }
    res.status(500).json({ error: 'PDF render failed' });
  }
});

async function handleGenerate(req, res) {
  try {
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.setTag('endpoint', '/reports/generate');
      Sentry.addBreadcrumb({ category: 'reports', level: 'info', message: 'generate:start' });
    }
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Storage admin client is not configured' });
    }

    const body = req.body || {};
    const candidate_id = normalizeUuid(body.candidate_id, { required: false });
    const report_id = normalizeUuid(body.report_id, { required: false });
    const interview_id = normalizeUuid(body.interview_id, { required: false });
    for (const [field, value] of Object.entries({ candidate_id, report_id, interview_id })) {
      if (value === null) return invalidUuidResponse(res, field);
    }
    if (!candidate_id && !report_id && !interview_id) {
      return res.status(400).json({ error: 'candidate_id, report_id, or interview_id is required' });
    }

    // 1) Resolve an exact interview first when the caller supplies one. New
    // recovery attempts never pair a candidate-wide latest report with a
    // different interview.
    let latestInterview = null;
    let recoveryAttempt = false;
    if (interview_id) {
      const { data: ivById, error: ivByIdErr } = await supabaseAdmin
        .from('interviews')
        .select('id, created_at, candidate_id, client_id, role_id, attempt_number, attempt_mode, previous_attempt_id, replacement_authorization_id, status, video_url, transcript_url, transcript, analysis_url, analysis, transcript_scores, perception_scores, interview_summary, unanswered_candidate_questions')
        .eq('id', interview_id)
        .maybeSingle();
      if (ivByIdErr) throw ivByIdErr;
      if (!ivById) return res.status(404).json({ error: 'Interview not found' });
      if (!scopedClientIds(req).includes(String(ivById.client_id || ''))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (candidate_id && String(ivById.candidate_id) !== String(candidate_id)) {
        return res.status(409).json({ error: 'interview_candidate_mismatch' });
      }
      latestInterview = ivById;
      recoveryAttempt = !!ivById.replacement_authorization_id || Number(ivById.attempt_number || 0) > 1;
    }

    let reportRow = null;
    if (report_id) {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('id, created_at, candidate_id, client_id, role_id, interview_id, attempt_number, report_kind, resume_score, interview_score, overall_score, interview_breakdown, resume_breakdown, analysis, unanswered_candidate_questions')
        .eq('id', report_id)
        .maybeSingle();
      if (error) throw error;
      reportRow = data;
      if (!reportRow) return res.status(404).json({ error: 'No report found for given id' });
      if (!scopedClientIds(req).includes(String(reportRow.client_id || ''))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (candidate_id && String(reportRow.candidate_id) !== String(candidate_id)) {
        return res.status(409).json({ error: 'report_candidate_mismatch' });
      }
      if (latestInterview) {
        const exactReportBinding = reportRow.interview_id
          && String(reportRow.interview_id) === String(latestInterview.id)
          && String(reportRow.candidate_id || '') === String(latestInterview.candidate_id || '')
          && String(reportRow.client_id || '') === String(latestInterview.client_id || '')
          && String(reportRow.role_id || '') === String(latestInterview.role_id || '')
          && Number(reportRow.attempt_number) === Number(latestInterview.attempt_number)
          && (!recoveryAttempt || reportRow.report_kind === 'complete_interview');
        if (!exactReportBinding) {
          return res.status(409).json({ error: 'recovery_report_interview_mismatch' });
        }
      }
      // A bound report carries its own attempt identity. Resolve that exact
      // interview even when an older caller supplies only report_id.
      if (!latestInterview && reportRow.interview_id) {
        const { data: boundInterview, error: boundInterviewError } = await supabaseAdmin
          .from('interviews')
          .select('id, created_at, candidate_id, client_id, role_id, attempt_number, attempt_mode, previous_attempt_id, replacement_authorization_id, status, video_url, transcript_url, transcript, analysis_url, analysis, transcript_scores, perception_scores, interview_summary, unanswered_candidate_questions')
          .eq('id', reportRow.interview_id)
          .maybeSingle();
        if (boundInterviewError) throw boundInterviewError;
        if (!boundInterview) return res.status(409).json({ error: 'report_interview_binding_missing' });
        if (!scopedClientIds(req).includes(String(boundInterview.client_id || ''))
          || String(boundInterview.client_id || '') !== String(reportRow.client_id || '')
          || String(boundInterview.candidate_id || '') !== String(reportRow.candidate_id || '')
          || String(boundInterview.role_id || '') !== String(reportRow.role_id || '')) {
          return res.status(409).json({ error: 'report_interview_binding_mismatch' });
        }
        latestInterview = boundInterview;
        recoveryAttempt = !!boundInterview.replacement_authorization_id
          || Number(boundInterview.attempt_number || 0) > 1;
      }
    } else if (recoveryAttempt) {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('id, created_at, candidate_id, client_id, role_id, interview_id, attempt_number, report_kind, resume_score, interview_score, overall_score, interview_breakdown, resume_breakdown, analysis, unanswered_candidate_questions')
        .eq('interview_id', latestInterview.id)
        .eq('candidate_id', latestInterview.candidate_id)
        .eq('client_id', latestInterview.client_id)
        .eq('role_id', latestInterview.role_id)
        .eq('attempt_number', latestInterview.attempt_number)
        .eq('report_kind', 'complete_interview')
        .maybeSingle();
      if (error) throw error;
      reportRow = data;

      if (!reportRow) {
        // Resume-only data is the sole candidate-wide input allowed to seed a
        // new attempt report. No prior interview analysis is copied.
        const { data: resumeRows, error: resumeError } = await supabaseAdmin
          .from('reports')
          .select('id,created_at,resume_score,resume_breakdown')
          .eq('candidate_id', latestInterview.candidate_id)
          .eq('client_id', latestInterview.client_id)
          .eq('role_id', latestInterview.role_id)
          .eq('report_kind', 'resume_only')
          .is('interview_id', null)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1);
        if (resumeError) throw resumeError;
        const resumeOnly = (resumeRows || [])[0] || null;
        const { data: inserted, error: insertError } = await supabaseAdmin
          .from('reports')
          .insert({
            candidate_id: latestInterview.candidate_id,
            client_id: latestInterview.client_id,
            role_id: latestInterview.role_id,
            interview_id: latestInterview.id,
            attempt_number: latestInterview.attempt_number,
            report_kind: 'complete_interview',
            resume_score: safeResumeScore(resumeOnly?.resume_score),
            resume_breakdown: sanitizeResumeBreakdown(resumeOnly?.resume_breakdown),
          })
          .select('id, created_at, candidate_id, client_id, role_id, interview_id, attempt_number, report_kind, resume_score, interview_score, overall_score, interview_breakdown, resume_breakdown, analysis, unanswered_candidate_questions')
          .single();
        if (insertError) throw insertError;
        reportRow = inserted;
      }
    } else {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('id, created_at, candidate_id, client_id, role_id, interview_id, attempt_number, report_kind, resume_score, interview_score, overall_score, interview_breakdown, resume_breakdown, analysis, unanswered_candidate_questions')
        .eq('candidate_id', candidate_id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      reportRow = (data && data[0]) || null;
    }

    if (!reportRow) {
      return res.status(404).json({ error: 'No report found for given id' });
    }
    if (!scopedClientIds(req).includes(String(reportRow.client_id || ''))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'db', level: 'info', message: 'reports:loaded', data: { report_id: reportRow.id, candidate_id: reportRow.candidate_id } });
    }

    // Legacy report generation retains its historical latest-interview fallback.
    // Recovery attempts above are exact-ID-only.
    if (!latestInterview) {
        const { data: ivs, error: ivErr } = await supabaseAdmin
          .from('interviews')
          .select('id, created_at, candidate_id, client_id, role_id, attempt_number, attempt_mode, previous_attempt_id, replacement_authorization_id, status, video_url, transcript_url, transcript, analysis_url, analysis, transcript_scores, perception_scores, interview_summary, unanswered_candidate_questions')
          .eq('candidate_id', reportRow.candidate_id)
          .order('created_at', { ascending: false })
          .limit(1);
        if (ivErr) throw ivErr;
        latestInterview = (ivs && ivs[0]) || null;
    }
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'db', level: 'info', message: 'interviews:loaded', data: { latest_interview_id: latestInterview ? latestInterview.id : null } });
    }

    // 2) Load candidate + role
    const [{ data: cand, error: candErr }, { data: role, error: roleErr }] = await Promise.all([
      supabaseAdmin.from('candidates').select('id,name,email,client_id,role_id,analysis_summary').eq('id', reportRow.candidate_id).maybeSingle(),
      supabaseAdmin.from('roles').select('id,title,client_id').eq('id', reportRow.role_id).maybeSingle(),
    ]);
    if (candErr) throw candErr;
    if (roleErr) throw roleErr;
    try {
      assertReportBindings({
        report: reportRow,
        candidate: cand,
        role,
        interview: latestInterview,
        allowUnboundInterview: true,
      });
    } catch (bindingError) {
      if (bindingError instanceof ServiceRoleAuthorizationError) {
        return res.status(409).json({ error: 'report_resource_binding_mismatch' });
      }
      throw bindingError;
    }
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'db', level: 'info', message: 'candidate:loaded', data: { candidate_id: cand ? cand.id : null } });
      Sentry.addBreadcrumb({ category: 'db', level: 'info', message: 'role:loaded', data: { role_id: role ? role.id : null } });
    }

    let client = null;
    if (cand?.client_id) {
      const { data: clientRow, error: clientErr } = await supabaseAdmin
        .from('clients')
        .select('id,name')
        .eq('id', cand.client_id)
        .maybeSingle();
      if (clientErr) throw clientErr;
      client = clientRow || null;
    }

    // Normalize to the template contract (flat keys expected by candidate-report.hbs)
    const analysis = reportRow.analysis || {};
    const rbRaw = analysis.interview || reportRow.interview_breakdown || {};
    const resumeRaw = analysis.resume || reportRow.resume_breakdown || {};

    // If shape is { scores: {...}, summary }, flatten to a single object
    const rb = rbRaw?.scores ? { ...rbRaw.scores, summary: rbRaw.summary } : rbRaw;
    const resume = resumeRaw?.scores ? { ...resumeRaw.scores, summary: resumeRaw.summary } : resumeRaw;

    const ivAnalysis = latestInterview?.analysis || null;
    const ivScores = (ivAnalysis && ivAnalysis.scores) || {};
    const reportLevelSummary = typeof reportRow?.analysis?.summary === 'string'
      ? reportRow.analysis.summary.trim()
      : '';

    const name = (cand?.name && cand.name.trim()) || 'Unknown Candidate';
    const email = (cand?.email && cand.email.trim()) || '';

    function coerceNumber(val) {
      if (val === null || val === undefined) return null;
      if (typeof val === 'number' && Number.isFinite(val)) {
        // Normalize 0–1 to 0–100 if clearly intended as a percent
        if (val > 0 && val <= 1) return Math.round(val * 100);
        return val;
      }
      if (typeof val === 'string') {
        // If it already contains a %, parse the numeric part and return
        if (val.includes('%')) {
          const m = val.match(/-?\d+(?:\.\d+)?/);
          return m ? Number(m[0]) : null;
        }
        // Otherwise parse and normalize 0–1 style strings
        const m = val.match(/-?\d+(?:\.\d+)?/);
        if (!m) return null;
        const n = Number(m[0]);
        if (!Number.isFinite(n)) return null;
        return (n > 0 && n <= 1) ? Math.round(n * 100) : n;
      }
      return null;
    }

    function parseJsonObject(value) {
      if (!value) return null;
      if (typeof value === 'object' && !Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
      return null;
    }

    function pickScore(obj, keys = []) {
      if (!obj || typeof obj !== 'object') return null;
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          const n = coerceNumber(obj[k]);
          if (n !== null) return n;
        }
      }
      return null;
    }

    function pickScoreFromArray(arr, names = []) {
      if (!Array.isArray(arr)) return null;
      const keys = ['id','key','name','label','type'];
      for (const target of names) {
        for (const item of arr) {
          for (const k of keys) {
            if (item && typeof item === 'object' && typeof item[k] === 'string') {
              if (item[k].toLowerCase() === String(target).toLowerCase()) {
                const n = coerceNumber(item.score ?? item.value ?? item.percent ?? item.percentage);
                if (n !== null) return n;
              }
            }
          }
        }
      }
      return null;
    }

    // Deep search for a named score anywhere in a nested object/array
    function deepFindScore(source, names = []) {
      const seen = new Set();
      const targets = names.map((n) => String(n).toLowerCase());
      const valueAliases = ['score','value','percent','percentage','pct'];
      const idAliases = ['id','key','name','label','type'];
      const queue = [source];
      while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object') continue;
        if (seen.has(cur)) continue;
        seen.add(cur);

        // 1) Direct property match: { experience: 0.82 } or { experience: "82%" }
        for (const [k, v] of Object.entries(cur)) {
          if (targets.includes(String(k).toLowerCase())) {
            const n = coerceNumber(v);
            if (n !== null) return n;
          }
        }
        // 2) Array of objects with id/name/label matching and a score/value/percent
        if (Array.isArray(cur)) {
          for (const item of cur) {
            if (!item || typeof item !== 'object') continue;
            for (const idk of idAliases) {
              const idv = item[idk];
              if (typeof idv === 'string' && targets.includes(idv.toLowerCase())) {
                for (const vk of valueAliases) {
                  const n = coerceNumber(item[vk]);
                  if (n !== null) return n;
                }
              }
            }
          }
        }
        // 3) Recurse into nested objects/arrays
        for (const v of Object.values(cur)) {
          if (v && typeof v === 'object') queue.push(v);
        }
      }
      return null;
    }

    // Helper to fetch the dashboard-normalized row
    async function getDashboardRowNormalized(clientId, candidateId) {
      try {
        const port = process.env.PORT || 10000;
        const url = `http://localhost:${port}/dashboard/rows?client_id=${encodeURIComponent(clientId)}&candidate_id=${encodeURIComponent(candidateId)}`;
        const resp = await fetch(url, { method: 'GET' });
        if (!resp || !resp.ok) return null;
        const json = await resp.json().catch(() => null);
        if (!json) return null;
        const item = Array.isArray(json?.items) ? json.items[0] : (Array.isArray(json) ? json[0] : json);
        return item || null;
      } catch (_) {
        return null;
      }
    }

    // Summaries (prefer report analysis → report-level → interview analysis)
    const resume_summary = (typeof resume.summary === 'string' && resume.summary.trim())
      ? resume.summary.trim()
      : 'Summary not available';

    const interview_summary =
      (typeof rb.summary === 'string' && rb.summary.trim())
        ? rb.summary.trim()
        : (reportLevelSummary ||
           (typeof ivAnalysis?.summary === 'string' && ivAnalysis.summary.trim()) ||
           'Summary not available');

    // Breakdowns with numeric coercion AND embedded summaries (template expects nested .summary)
    const resumeScores = (resume && (resume.scores || resume)) || {};

    const experienceScore =
      pickScore(resumeScores, ['experience','exp','experience_score','experienceScore','experiencePercent','experience_percentage','experience_pct','exp_pct','experience_match_percent']) ??
      pickScore(resume,      ['experience','exp','experience_score','experienceScore','experiencePercent','experience_percentage','experience_pct','exp_pct','experience_match_percent']) ??
      pickScoreFromArray(resumeRaw.categories || resumeRaw.items || resumeRaw.metrics || [], ['experience','exp']) ??
      deepFindScore(analysis.resume || resumeRaw, ['experience','exp']) ??
      0;

    const skillsScore =
      pickScore(resumeScores, ['skills','skill','skills_score','skillsScore','skillsPercent','skills_percentage','skills_pct','skill_pct','skills_match_percent']) ??
      pickScore(resume,       ['skills','skill','skills_score','skillsScore','skillsPercent','skills_percentage','skills_pct','skill_pct','skills_match_percent']) ??
      pickScoreFromArray(resumeRaw.categories || resumeRaw.items || resumeRaw.metrics || [], ['skills','skill']) ??
      deepFindScore(analysis.resume || resumeRaw, ['skills','skill']) ??
      0;

    const educationScore =
      pickScore(resumeScores, ['education','edu','education_score','educationScore','educationPercent','education_percentage','education_pct','edu_pct','education_match_percent']) ??
      pickScore(resume,       ['education','edu','education_score','educationScore','educationPercent','education_percentage','education_pct','edu_pct','education_match_percent']) ??
      pickScoreFromArray(resumeRaw.categories || resumeRaw.items || resumeRaw.metrics || [], ['education','edu']) ??
      deepFindScore(analysis.resume || resumeRaw, ['education','edu']) ??
      0;

    const resume_breakdown = {
      experience: experienceScore,
      skills: skillsScore,
      education: educationScore,
      summary: resume_summary
    };
    const transcriptScores = parseJsonObject(latestInterview?.transcript_scores) || {};
    const evidenceStrengthFromTranscript = coerceNumber(transcriptScores.confidence);
    const aiAidedRiskFromTranscript = typeof transcriptScores.ai_aided_risk === 'string' ? transcriptScores.ai_aided_risk.trim().toLowerCase() : '';
    const aiAidedRiskReasonFromTranscript = typeof transcriptScores.ai_aided_risk_reason === 'string' ? transcriptScores.ai_aided_risk_reason.trim() : '';

    const clarityFromReport = coerceNumber(rb.clarity);
    const confidenceFromReport = coerceNumber(rb.confidence);
    const clarityFromIvScores = coerceNumber(ivScores.clarity);
    const confidenceFromIvScores = coerceNumber(ivScores.confidence);
    const interview_breakdown = {
      clarity: clarityFromReport !== null ? clarityFromReport : clarityFromIvScores,
      confidence: confidenceFromReport !== null ? confidenceFromReport : confidenceFromIvScores,
      evidence_strength: evidenceStrengthFromTranscript !== null ? evidenceStrengthFromTranscript : null,
      ai_aided_risk: aiAidedRiskFromTranscript,
      ai_aided_risk_reason: aiAidedRiskReasonFromTranscript,
      summary: interview_summary
    };

    let unansweredCandidateQuestions = Array.isArray(reportRow.unanswered_candidate_questions)
      ? reportRow.unanswered_candidate_questions.filter(q => typeof q === 'string' && q.trim())
      : [];

    // Use the same source-of-truth fields as /dashboard/rows.
    const candidateSummary = parseJsonObject(cand?.analysis_summary) || {};
    const resumeFromCandidate =
      coerceNumber(
        candidateSummary.resume_score ??
        candidateSummary.resume ??
        candidateSummary.resume_match_percent ??
        candidateSummary.resumeMatchPercent
      );
    const interviewFromTranscript = coerceNumber(transcriptScores.overall);
    const overallFromCurrent =
      (resumeFromCandidate !== null && interviewFromTranscript !== null)
        ? Math.round((resumeFromCandidate + interviewFromTranscript) / 2)
        : null;

    if (resumeFromCandidate !== null) reportRow.resume_score = resumeFromCandidate;
    if (interviewFromTranscript !== null) reportRow.interview_score = interviewFromTranscript;
    reportRow.overall_score = overallFromCurrent;

    const resumeSummaryFromCandidate =
      (typeof candidateSummary.summary === 'string' && candidateSummary.summary.trim()) ||
      (typeof candidateSummary.resume_summary === 'string' && candidateSummary.resume_summary.trim()) ||
      (typeof candidateSummary.resumeSummary === 'string' && candidateSummary.resumeSummary.trim()) ||
      (typeof candidateSummary.resume_analysis?.summary === 'string' && candidateSummary.resume_analysis.summary.trim()) ||
      '';
    if (resumeSummaryFromCandidate) {
      resume_breakdown.summary = resumeSummaryFromCandidate;
    }

    const experienceFromCandidate = coerceNumber(
      candidateSummary.experience_match_percent ?? candidateSummary.experienceMatchPercent
    );
    const skillsFromCandidate = coerceNumber(
      candidateSummary.skills_match_percent ?? candidateSummary.skillsMatchPercent
    );
    const educationFromCandidate = coerceNumber(
      candidateSummary.education_match_percent ?? candidateSummary.educationMatchPercent
    );
    if (experienceFromCandidate !== null) resume_breakdown.experience = experienceFromCandidate;
    if (skillsFromCandidate !== null) resume_breakdown.skills = skillsFromCandidate;
    if (educationFromCandidate !== null) resume_breakdown.education = educationFromCandidate;

    const perceptionScores = parseJsonObject(latestInterview?.perception_scores) || {};
    const clarityFromInterview = coerceNumber(perceptionScores.clarity);
    const confidenceFromInterview = coerceNumber(perceptionScores.confidence);
    const engagementFromInterview = coerceNumber(perceptionScores.engagement);
    if (clarityFromInterview !== null) interview_breakdown.clarity = clarityFromInterview;
    if (confidenceFromInterview !== null) interview_breakdown.confidence = confidenceFromInterview;
    if (engagementFromInterview !== null) {
      interview_breakdown.engagement = engagementFromInterview;
    }

    const interviewSummaryFromInterview = typeof latestInterview?.interview_summary === 'string'
      ? latestInterview.interview_summary.trim()
      : '';
    if (interviewSummaryFromInterview) {
      interview_breakdown.summary = interviewSummaryFromInterview;
    }

    if (Array.isArray(latestInterview?.unanswered_candidate_questions)) {
      const cleaned = latestInterview.unanswered_candidate_questions
        .map((q) => (q == null ? '' : String(q).trim()))
        .filter(Boolean);
      unansweredCandidateQuestions = cleaned;
    }

    const status = latestInterview?.video_url ? 'Interview Completed' : 'Pending';

    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'reports', level: 'info', message: 'payload:build' });
    }
    const payload = {
      name,
      email,
      company_name: typeof client?.name === 'string' ? client.name.trim() : '',
      role_name: typeof role?.title === 'string' ? role.title.trim() : '',
      status,
      resume_score: coerceNumber(reportRow.resume_score) ?? null,
      interview_score: coerceNumber(reportRow.interview_score) ?? null,
      overall_score: coerceNumber(reportRow.overall_score) ?? null,
      resume_breakdown,
      resume_summary: resume_breakdown.summary || resume_summary,
      interview_breakdown,
      interview_summary: interview_breakdown.summary || interview_summary,
      created_at: reportRow.created_at,
      unanswered_candidate_questions: unansweredCandidateQuestions
    };

    // 4) Render and convert to PDF
    const html = buildCandidateReportHtml(payload);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'render', level: 'info', message: 'html:built' });
    }
    const pdfBuffer = await htmlToPdf(html);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'render', level: 'info', message: 'pdf:generated', data: { bytes: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.length : undefined } });
    }

    // 5) Upload to Supabase Storage
    const safeCandidate = (cand?.name || reportRow.candidate_id || 'candidate')
      .toLowerCase().replace(/[^a-z0-9\-]+/g, '-');
    const key = `${reportRow.candidate_id}/${reportRow.id}-${Date.now()}-${safeCandidate}.pdf`;

    const { error: uploadErr } = await supabaseAdmin
      .storage
      .from(REPORTS_BUCKET)
      .upload(key, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw uploadErr;
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'storage', level: 'info', message: 'storage:uploaded', data: { key } });
    }

    // Create a short-lived signed URL for immediate download/open
    const expiresIn = Math.max(MIN_SIGNED_SECS, Math.min(MAX_SIGNED_SECS, Number(req.query.expires || DEFAULT_SIGNED_SECS)));
    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(key, expiresIn);
    if (signErr) throw signErr;
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'storage', level: 'info', message: 'storage:signedurl', data: { expiresIn } });
    }

    // 6) Best-effort: update reports row
    try {
      await supabaseAdmin
        .from('reports')
        .update({
          report_url: key,
          report_generated_at: new Date().toISOString()
        })
        .eq('id', reportRow.id);
    } catch (e) {
      if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
        Sentry.addBreadcrumb({ category: 'db', level: 'warning', message: 'reports:update_failed', data: { report_id: reportRow.id, error: String(e && e.message || e) } });
      }
    }

    return res.json({
      ok: true,
      report_id: reportRow.id,
      key,
      report_url: key,
      signed_url: signed?.signedUrl || null,
      expires_in: expiresIn
    });
  } catch (err) {
    console.error('[reports/generate] error', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, {
        tags: { endpoint: '/reports/generate' },
        extra: {
          candidate_id: (req.body && req.body.candidate_id) || null,
          report_id: (req.body && req.body.report_id) || null
        }
      });
    }
    return res.status(503).json({ error: 'temporary_service_error', detail: 'The report service is temporarily unavailable.' });
  }
}

// Register both endpoints to the same handler
router.post('/generate', handleGenerate);
router.post('/generate-and-store', handleGenerate);

// Production endpoint (stubbed until Step 3)
// POST /api/reports/pdf
router.post('/pdf', async (req, res) => {
  try {
    return res.status(501).json({ error: 'not_implemented', detail: 'PDF generation will be enabled after Step 3.' });
  } catch (err) {
    console.error('[reports/pdf] error:', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { endpoint: '/reports/pdf' } });
    }
    return res.status(500).json({ error: 'PDF endpoint error' });
  }
});

/**
 * GET /api/reports/interviews/:interviewId/url?expires=60
 * Exact-attempt URL for recovery-aware consumers. Legacy report-id URLs remain
 * available below.
 */
router.get('/interviews/:interviewId/url', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Storage admin client is not configured' });
    }
    const interviewId = normalizeUuid(req.params.interviewId);
    if (interviewId === null) return invalidUuidResponse(res, 'interview_id');
    const rawExpires = req.query.expires;
    if (rawExpires !== undefined && (typeof rawExpires !== 'string' || !/^\d{1,4}$/.test(rawExpires))) {
      return res.status(400).json({ error: 'bad_request', code: 'invalid_expiry', detail: 'expires must be an integer string.' });
    }
    const expiresParam = Number(rawExpires || DEFAULT_SIGNED_SECS);
    const expiresIn = Math.max(MIN_SIGNED_SECS, Math.min(MAX_SIGNED_SECS, expiresParam));

    const { data: interview, error: interviewError } = await supabaseAdmin
      .from('interviews')
      .select('id,candidate_id,client_id,role_id,attempt_number')
      .eq('id', interviewId)
      .maybeSingle();
    if (interviewError) throw interviewError;
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    if (!scopedClientIds(req).includes(String(interview.client_id || ''))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data: report, error } = await supabaseAdmin
      .from('reports')
      .select('id,candidate_id,client_id,role_id,report_url,interview_id,attempt_number,report_kind')
      .eq('interview_id', interviewId)
      .eq('candidate_id', interview.candidate_id)
      .eq('client_id', interview.client_id)
      .eq('role_id', interview.role_id)
      .eq('attempt_number', interview.attempt_number)
      .eq('report_kind', 'complete_interview')
      .maybeSingle();
    if (error) throw error;
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const key = keyFromUrl(report.report_url);
    if (!key) return res.status(404).json({ error: 'Report file not available' });
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(key, expiresIn);
    if (signErr) throw signErr;
    return res.json({
      ok: true,
      report_id: report.id,
      interview_id: report.interview_id,
      attempt_number: report.attempt_number,
      signed_url: signed?.signedUrl || null,
      expires_in: expiresIn,
    });
  } catch (err) {
    return res.status(503).json({ error: 'temporary_service_error', detail: 'The report service is temporarily unavailable.' });
  }
});

/**
 * GET /api/reports/:id/url?expires=60
 * Returns a short-lived signed URL for an existing report PDF.
 */
router.get('/:id/url', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Storage admin client is not configured' });
    }
    const id = normalizeUuid(req.params.id);
    if (id === null) return invalidUuidResponse(res, 'report_id');
    const rawExpires = req.query.expires;
    if (rawExpires !== undefined && (typeof rawExpires !== 'string' || !/^\d{1,4}$/.test(rawExpires))) {
      return res.status(400).json({ error: 'bad_request', code: 'invalid_expiry', detail: 'expires must be an integer string.' });
    }
    const expiresParam = Number(rawExpires || DEFAULT_SIGNED_SECS);
    const expiresIn = Math.max(MIN_SIGNED_SECS, Math.min(MAX_SIGNED_SECS, expiresParam));

    // Load report row to find where the PDF lives
    const { data: report, error } = await supabaseAdmin
      .from('reports')
      .select('id, report_url, candidate_id, client_id, role_id')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const { data: candidate, error: candidateError } = await supabaseAdmin
      .from('candidates')
      .select('id,client_id,role_id')
      .eq('id', report.candidate_id)
      .maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate) return res.status(404).json({ error: 'Report owner not found' });
    const effectiveClientId = report.client_id || candidate.client_id;
    if (!effectiveClientId || !scopedClientIds(req).includes(String(effectiveClientId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if ((report.client_id && String(report.client_id) !== String(candidate.client_id || ''))
      || (report.role_id && String(report.role_id) !== String(candidate.role_id || ''))) {
      return res.status(409).json({ error: 'report_owner_binding_mismatch' });
    }

    const key = keyFromUrl(report.report_url);
    if (!key) return res.status(404).json({ error: 'Report file not available' });

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(key, expiresIn);
    if (signErr) throw signErr;

    return res.json({
      ok: true,
      report_id: report.id,
      signed_url: signed?.signedUrl || null,
      expires_in: expiresIn
    });
  } catch (err) {
    console.error('[reports/:id/url] error', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { endpoint: '/reports/:id/url' } });
    }
    return res.status(503).json({ error: 'temporary_service_error', detail: 'The report service is temporarily unavailable.' });
  }
});

router._handleGenerate = handleGenerate;
router._sanitizeResumeBreakdown = sanitizeResumeBreakdown;
module.exports = router;
