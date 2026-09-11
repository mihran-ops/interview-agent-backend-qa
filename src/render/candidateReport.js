const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const templatePath = path.join(__dirname, '..', '..', 'templates', 'pdf', 'candidate-report.hbs');
const templateSrc = fs.readFileSync(templatePath, 'utf8');
const template = Handlebars.compile(templateSrc);

const LOGO_FILENAME = 'alphascreen-mark-08-navy.svg';

let cachedLogoSrc = null;
let triedLogoLoad = false;

Handlebars.registerHelper('fallback', (v, d) => (v == null || v === '' ? d : v));
Handlebars.registerHelper('hasScore', (v) => coerceNumber(v) !== null);
Handlebars.registerHelper('scoreText', (v) => {
  const n = coerceNumber(v);
  if (n === null) return '—';
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`;
});
Handlebars.registerHelper('scoreBarWidth', (v) => {
  const n = coerceNumber(v);
  if (n === null) return '';
  return String(Math.max(0, Math.min(100, Math.round(n))));
});

function coerceNumber(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && Number.isFinite(val)) {
    if (val > 0 && val <= 1) return Math.round(val * 100);
    return val;
  }
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t) return null;
    const m = t.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) return null;
    if (n > 0 && n <= 1) return Math.round(n * 100);
    return n;
  }
  return null;
}

function nonEmptyString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const t = value.trim();
    return t || '';
  }
  return String(value).trim();
}

function safeParseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function normalizeBreakdown(input) {
  const obj = (input && typeof input === 'object') ? input : {};
  const src = (obj.scores && typeof obj.scores === 'object') ? obj.scores : obj;

  return {
    experience: coerceNumber(src.experience),
    skills: coerceNumber(src.skills),
    education: coerceNumber(src.education),

    confidence: coerceNumber(src.confidence),
    clarity: coerceNumber(src.clarity),
    engagement: coerceNumber(src.engagement),
    evidence_strength: coerceNumber(src.evidence_strength),
    ai_aided_risk: nonEmptyString(src.ai_aided_risk),
    ai_aided_risk_reason: nonEmptyString(src.ai_aided_risk_reason),

    summary: nonEmptyString(obj.summary || src.summary)
  };
}

function normalizeQuestions(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((q) => (q == null ? '' : String(q).trim())).filter(Boolean);
  }
  if (typeof value === 'string') {
    const parsed = safeParseJsonMaybe(value);
    if (Array.isArray(parsed)) {
      return parsed.map((q) => (q == null ? '' : String(q).trim())).filter(Boolean);
    }
    return value
      .split(/\r?\n/)
      .map((q) => q.trim())
      .filter(Boolean);
  }
  return [];
}

function readLogoAsDataUri() {
  if (process.env.PDF_LOGO_DATA_URI) return String(process.env.PDF_LOGO_DATA_URI);
  if (triedLogoLoad) return cachedLogoSrc || '';
  triedLogoLoad = true;

  const candidates = [
    path.join(__dirname, '..', '..', 'templates', 'pdf', 'assets', LOGO_FILENAME),
  ];

  for (const logoPath of candidates) {
    try {
      if (fs.existsSync(logoPath)) {
        const base64 = fs.readFileSync(logoPath).toString('base64');
        cachedLogoSrc = `data:image/svg+xml;base64,${base64}`;
        return cachedLogoSrc;
      }
    } catch (_) {}
  }

  cachedLogoSrc = '';
  return '';
}

function buildCandidateReportHtml(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};

  const analysisObj =
    (p.analysis && typeof p.analysis === 'object')
      ? p.analysis
      : (safeParseJsonMaybe(p.analysis) || {});

  const resumeBreakdown = normalizeBreakdown(
    p.resume_breakdown ||
    p.resumeBreakdown ||
    analysisObj.resume ||
    analysisObj.resume_breakdown
  );

  const interviewBreakdown = normalizeBreakdown(
    p.interview_breakdown ||
    p.interviewBreakdown ||
    analysisObj.interview ||
    analysisObj.interview_breakdown
  );

  const analysisSummary = nonEmptyString(
    analysisObj.summary ||
    p.analysis_summary ||
    p.interview_summary ||
    interviewBreakdown.summary
  );

  const resumeSummary = nonEmptyString(
    p.resume_summary ||
    analysisObj?.resume?.summary ||
    resumeBreakdown.summary
  );

  const interviewSummary = nonEmptyString(
    p.interview_summary ||
    analysisObj?.interview?.summary ||
    interviewBreakdown.summary ||
    analysisSummary
  );

  const renderData = {
    name: nonEmptyString(p.name),
    email: nonEmptyString(p.email),
    company_name: nonEmptyString(p.company_name ?? p.client_name),
    role_name: nonEmptyString(p.role_name),
    status: nonEmptyString(p.status),

    resume_score: coerceNumber(p.resume_score) ?? coerceNumber(p.resumeScore) ?? null,
    interview_score: coerceNumber(p.interview_score) ?? coerceNumber(p.interviewScore) ?? null,
    overall_score: coerceNumber(p.overall_score) ?? coerceNumber(p.overallScore) ?? null,

    resume_breakdown: resumeBreakdown,
    interview_breakdown: interviewBreakdown,

    resume_summary: resumeSummary,
    interview_summary: interviewSummary,

    analysis: { summary: analysisSummary },

    unanswered_candidate_questions: normalizeQuestions(
      p.unanswered_candidate_questions ?? p.unansweredCandidateQuestions
    ),

    logo_src: readLogoAsDataUri()
  };

  return template(renderData);
}

module.exports = { buildCandidateReportHtml };
