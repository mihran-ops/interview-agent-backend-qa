'use strict';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_INTERVIEW_ANALYSIS_V2_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const { excludeWarmupFromTranscript } = require('./warmupExclusion');

const SCORE_KEYS = [
  'response_specificity',
  'answer_directness',
  'answer_consistency',
  'communication_structure'
];
const EVALUATION_CONDITIONS = new Set(['good', 'mixed', 'limited', 'unavailable']);
const ISSUE_LEVELS = new Set(['none', 'low', 'medium', 'high', 'unavailable']);
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'unavailable']);

function clampScore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}

function truncate(value, limit) {
  const text = String(value || '').trim();
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[Truncated]`;
}

function cleanString(value, limit) {
  return truncate(value == null ? '' : value, limit).replace(/\s+/g, ' ').trim();
}

function cleanStringArray(value, limit, itemLimit) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item, itemLimit))
    .filter(Boolean)
    .slice(0, limit);
}

function enumOrUnavailable(value, allowed) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : 'unavailable';
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeResult(parsed) {
  const obj = toPlainObject(parsed);
  const rawScores = toPlainObject(obj.scores);
  const scores = {};
  for (const key of SCORE_KEYS) {
    scores[key] = clampScore(rawScores[key]);
  }

  const rawConditions = toPlainObject(obj.conditions);
  const rawRisk = toPlainObject(obj.risk);
  const out = {
    version: 'path_a_v1',
    scores,
    conditions: {
      evaluation_conditions: enumOrUnavailable(rawConditions.evaluation_conditions, EVALUATION_CONDITIONS),
      audio_quality_issues: enumOrUnavailable(rawConditions.audio_quality_issues, ISSUE_LEVELS),
      distraction_risk: enumOrUnavailable(rawConditions.distraction_risk, RISK_LEVELS),
      signal_confidence: enumOrUnavailable(rawConditions.signal_confidence, RISK_LEVELS)
    },
    risk: {
      integrity_risk: enumOrUnavailable(rawRisk.integrity_risk, RISK_LEVELS),
      reason: cleanString(rawRisk.reason, 700)
    },
    evidence_summary: cleanString(obj.evidence_summary, 1200),
    evidence: cleanStringArray(obj.evidence, 12, 260),
    limitations: cleanStringArray(obj.limitations, 8, 260)
  };
  const hasAnyNumericScore = Object.values(out.scores).some((value) => Number.isFinite(value));
  if (hasAnyNumericScore && (!out.evidence_summary || out.evidence.length === 0)) {
    for (const key of SCORE_KEYS) out.scores[key] = null;
    out.conditions = {
      evaluation_conditions: 'unavailable',
      audio_quality_issues: 'unavailable',
      distraction_risk: 'unavailable',
      signal_confidence: 'unavailable'
    };
    out.risk = {
      integrity_risk: 'unavailable',
      reason: 'Model did not provide evidence for scored analysis.'
    };
    out.evidence_summary = '';
    out.evidence = [];
    out.limitations = [
      ...out.limitations,
      'Model did not provide evidence for scored analysis.'
    ].slice(0, 8);
  }
  return out;
}

function safeJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback, null, 2);
  } catch {
    return JSON.stringify(fallback, null, 2);
  }
}

function buildPrompt(input) {
  const roleContext = toPlainObject(input.role_context);
  const payload = {
    transcript_scores: toPlainObject(input.transcript_scores),
    perception_scores: toPlainObject(input.perception_scores),
    perception_analysis_text: truncate(input.perception_analysis_text, 5000),
    unanswered_candidate_questions: Array.isArray(input.unanswered_candidate_questions)
      ? input.unanswered_candidate_questions.slice(0, 20)
      : [],
    interview_summary: truncate(input.interview_summary, 2000),
    role_context: {
      title: truncate(roleContext.title, 300),
      description: truncate(roleContext.description, 4000),
      job_description_text: truncate(roleContext.job_description_text, 6000),
      job_description_url: truncate(roleContext.job_description_url, 800),
      rubric: roleContext.rubric || null,
      rubric_questions: roleContext.rubric_questions || null,
      manual_questions: truncate(roleContext.manual_questions, 4000)
    }
  };

  return `You are generating a backend-only v2 interview analysis from reliable end-of-call data.
Return strict JSON only. Do not include markdown, prose, comments, or extra keys.

Use exactly this JSON shape:
{
  "version": "path_a_v1",
  "scores": {
    "response_specificity": number_or_null,
    "answer_directness": number_or_null,
    "answer_consistency": number_or_null,
    "communication_structure": number_or_null
  },
  "conditions": {
    "evaluation_conditions": "good|mixed|limited|unavailable",
    "audio_quality_issues": "none|low|medium|high|unavailable",
    "distraction_risk": "low|medium|high|unavailable",
    "signal_confidence": "low|medium|high|unavailable"
  },
  "risk": {
    "integrity_risk": "low|medium|high|unavailable",
    "reason": "short evidence-backed reason"
  },
  "evidence_summary": "concise evidence-backed summary",
  "evidence": ["short direct evidence item"],
  "limitations": ["short limitation item"]
}

Rules:
- The introductory warm-up and its response are unscored. They have been removed from the transcript and must never be inferred, reconstructed, summarized, or used as evidence.
- Do not use favorite-season preferences or sensitive/personal information from pre-screening conversation in analysis, risk, evidence, or comparisons.
- Use transcript/content evidence first.
- Use final Tavus perception only as supporting context.
- Do not infer honesty, truthfulness, deception, trustworthiness, motivation, likability, personality, or personality judgments.
- Do not infer from gaze, pauses, accent, nervousness, appearance, camera quality, lighting, disability-related behavior, or protected traits.
- Do not include gaze inference, appearance commentary, protected-trait commentary, honesty claims, truthfulness claims, deception claims, trustworthiness claims, motivation judgments, likability judgments, or personality judgments.
- integrity_risk means only observable content/process concerns such as highly generic answers, repeated evasiveness, inconsistent claims, or signs of scripted/read-aloud delivery already grounded in transcript evidence.
- If evidence is insufficient, return null for numeric scores and "unavailable" for condition/risk enums, not 0.
- Scores are 0-100 when there is sufficient transcript evidence.
- If any numeric score is non-null, evidence_summary must be non-empty.
- If any numeric score is non-null, evidence must contain 2-6 short transcript-grounded evidence items.
- Evidence and limitations must cite observable transcript/content/process facts only.
- If evidence cannot be provided, return null for numeric scores and "unavailable" for condition/risk enums.

Context JSON:
${safeJson(payload, {})}

Transcript:
"""${truncate(excludeWarmupFromTranscript(input.transcript), 16000)}"""`;
}

async function generateInterviewAnalysisV2(input = {}) {
  const transcript = excludeWarmupFromTranscript(input.transcript);
  if (!transcript) throw new Error('missing_transcript');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const fetchImpl = typeof fetch === 'function' ? fetch : require('node-fetch');
  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'Return only strict JSON for Interview Analysis v2.' },
        { role: 'user', content: buildPrompt(input) }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI ${response.status}: ${text}`);
  }

  const data = await response.json();
  let parsed = {};
  try {
    parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
  } catch {
    parsed = {};
  }
  return normalizeResult(parsed);
}

module.exports = {
  buildInterviewAnalysisV2Prompt: buildPrompt,
  generateInterviewAnalysisV2,
  normalizeInterviewAnalysisV2Result: normalizeResult
};
