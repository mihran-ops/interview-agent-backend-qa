'use strict';

const crypto = require('crypto');
const { normalizeStoredResumeIntegrity } = require('./resumeIntegrity');

function automationError(code, detail, status = 400, hint = null) {
  const err = new Error(detail || code);
  err.code = code;
  err.detail = detail || null;
  err.status = status;
  err.hint = hint;
  return err;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(value) {
  if (!value) return null;
  if (isPlainObject(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function optionalUuid(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw automationError(`${name}_required`, `${name} is required.`, 400);
  }
  return normalized;
}

function toScoreOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeThreshold(value, key) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw automationError(
      'invalid_criteria_config',
      `${key} must be a number between 0 and 100.`,
      400
    );
  }
  return n;
}

function normalizeBoolean(value, fallback, key) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  if (value === true || value === false) return value;
  const normalized = text.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw automationError('invalid_criteria_config', `${key} must be a boolean.`, 400);
}

function normalizeCriteriaConfig(criteriaConfig = {}) {
  if (!isPlainObject(criteriaConfig)) {
    throw automationError('invalid_criteria_config', 'criteria_config must be a JSON object.', 400);
  }
  return {
    min_overall_score: normalizeThreshold(criteriaConfig.min_overall_score, 'min_overall_score'),
    min_resume_score: normalizeThreshold(criteriaConfig.min_resume_score, 'min_resume_score'),
    min_interview_score: normalizeThreshold(criteriaConfig.min_interview_score, 'min_interview_score'),
    require_sufficient_content: normalizeBoolean(
      criteriaConfig.require_sufficient_content,
      true,
      'require_sufficient_content'
    ),
    allow_resume_only: normalizeBoolean(criteriaConfig.allow_resume_only, false, 'allow_resume_only')
  };
}

function getTranscriptOverall(interviewRow) {
  const scores = parseJsonObject(interviewRow?.transcript_scores);
  return scores ? toScoreOrNull(scores.overall) : null;
}

function getResumeAnalysisScore(candidate) {
  const resumeAnalysis = parseJsonObject(candidate?.analysis_summary) || {};
  return toScoreOrNull(
    resumeAnalysis.resume_score ??
    resumeAnalysis.resume ??
    resumeAnalysis.resume_match_percent ??
    resumeAnalysis.resumeMatchPercent
  );
}

function getResumeIntegrity(latestReport, candidate) {
  const reportBreakdown = parseJsonObject(latestReport?.resume_breakdown) || {};
  const candidateAnalysis = parseJsonObject(candidate?.analysis_summary) || {};
  return normalizeStoredResumeIntegrity(
    reportBreakdown.resume_integrity || candidateAnalysis.resume_integrity || null
  );
}

function automationIntegritySnapshot(integrity) {
  return {
    version: integrity.version,
    mode: integrity.mode,
    status: integrity.status,
    manual_review_required: integrity.manual_review_required,
    automation_eligible: integrity.automation_eligible,
    format_assessment: integrity.format_assessment,
    reason_codes: integrity.reason_codes
  };
}

function clampScore(value) {
  if (!Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return Math.max(0, Math.min(100, n));
}

function hasInsufficientInterviewSummary(summary) {
  const lower = String(summary || '').toLowerCase();
  return (
    lower.includes('before any substantive responses were recorded') ||
    lower.includes('before substantive responses were captured') ||
    lower.includes('insufficient data') ||
    lower.includes('insufficient candidate content') ||
    lower.includes('no substantive responses')
  );
}

function getContentSufficiency(interviewRow) {
  const summary = typeof interviewRow?.interview_summary === 'string'
    ? interviewRow.interview_summary.trim()
    : '';

  if (hasInsufficientInterviewSummary(summary)) {
    return {
      insufficient_content: true,
      source: 'interview_summary',
      reason: 'existing_interview_summary_indicates_insufficient_content'
    };
  }

  // Phase 1 intentionally uses only existing explicit no-content signals.
  // Missing video, perception, recording, or transcript fields are not treated
  // as insufficient because text/accommodation interviews legitimately lack
  // those video-specific artifacts.
  return {
    insufficient_content: false,
    source: null,
    reason: null
  };
}

function candidateName(candidate) {
  return (
    String(candidate?.name || '').trim() ||
    'Unnamed Candidate'
  );
}

async function loadEvaluationInputs({ db, clientId, roleId, candidateId }) {
  const { data: role, error: roleErr } = await db
    .from('roles')
    .select('id,client_id,title')
    .eq('id', roleId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (roleErr) {
    throw automationError('role_lookup_failed', roleErr.message || 'Role lookup failed.', 500, roleErr.hint || null);
  }
  if (!role) {
    throw automationError('role_not_found', 'Role not found.', 404);
  }

  const { data: candidate, error: candidateErr } = await db
    .from('candidates')
    .select('id,client_id,role_id,name,email,interview_status,analysis_summary')
    .eq('id', candidateId)
    .eq('client_id', clientId)
    .eq('role_id', roleId)
    .maybeSingle();

  if (candidateErr) {
    throw automationError('candidate_lookup_failed', candidateErr.message || 'Candidate lookup failed.', 500, candidateErr.hint || null);
  }
  if (!candidate) {
    throw automationError('candidate_not_found', 'Candidate not found.', 404);
  }

  const { data: reports, error: reportErr } = await db
    .from('reports')
    .select('id,created_at,client_id,candidate_id,role_id,resume_score,interview_score,overall_score,resume_breakdown')
    .eq('client_id', clientId)
    .eq('candidate_id', candidateId)
    .eq('role_id', roleId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (reportErr) {
    throw automationError('report_lookup_failed', reportErr.message || 'Report lookup failed.', 500, reportErr.hint || null);
  }

  const { data: interviews, error: interviewErr } = await db
    .from('interviews')
    .select('id,created_at,client_id,candidate_id,role_id,transcript_scores,interview_summary')
    .eq('client_id', clientId)
    .eq('candidate_id', candidateId)
    .eq('role_id', roleId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (interviewErr) {
    throw automationError('interview_lookup_failed', interviewErr.message || 'Interview lookup failed.', 500, interviewErr.hint || null);
  }

  return {
    role,
    candidate,
    latestReport: Array.isArray(reports) ? reports[0] || null : null,
    latestInterview: Array.isArray(interviews) ? interviews[0] || null : null
  };
}

function evaluateThreshold({ label, score, min, matchReasons, nonMatchReasons }) {
  if (min === null || min === undefined) return;
  if (score === null || score === undefined) {
    nonMatchReasons.push({
      code: `${label}_missing`,
      detail: `${label} is required by criteria but is not available.`,
      threshold: min
    });
    return;
  }
  if (score < min) {
    nonMatchReasons.push({
      code: `${label}_below_threshold`,
      detail: `${label} is below the configured threshold.`,
      score,
      threshold: min
    });
    return;
  }
  matchReasons.push({
    code: `${label}_meets_threshold`,
    detail: `${label} meets the configured threshold.`,
    score,
    threshold: min
  });
}

function buildScoreSnapshotHash(snapshot) {
  return sha256(stableStringify({
    candidate_id: snapshot.candidate_id,
    client_id: snapshot.client_id,
    role_id: snapshot.role_id,
    report_id: snapshot.report_id,
    interview_id: snapshot.interview_id,
    overall_score: snapshot.overall_score,
    resume_score: snapshot.resume_score,
    interview_score: snapshot.interview_score,
    interview_status: snapshot.interview_status,
    content_sufficiency: snapshot.content_sufficiency,
    resume_integrity: snapshot.resume_integrity
  }));
}

async function evaluateCandidateAutomation(input = {}) {
  const db = input.db || input.supabase || input.supabaseAdmin;
  if (!db || typeof db.from !== 'function') {
    throw automationError('db_required', 'A Supabase client is required.', 500);
  }

  const clientId = optionalUuid(input.clientId || input.client_id, 'client_id');
  const roleId = optionalUuid(input.roleId || input.role_id, 'role_id');
  const candidateId = optionalUuid(input.candidateId || input.candidate_id, 'candidate_id');
  const triggerSource = String(input.triggerSource || input.trigger_source || 'dry_run').trim() || 'dry_run';
  const criteriaConfigSnapshot = normalizeCriteriaConfig(input.criteriaConfig || input.criteria_config || {});
  const ruleId = String(input.ruleId || input.rule_id || '').trim() || null;
  const ruleVersion = Number.isFinite(Number(input.ruleVersion || input.rule_version))
    ? Math.max(1, Math.floor(Number(input.ruleVersion || input.rule_version)))
    : null;

  const { role, candidate, latestReport, latestInterview } = await loadEvaluationInputs({
    db,
    clientId,
    roleId,
    candidateId
  });

  const contentSufficiency = getContentSufficiency(latestInterview);
  const resumeIntegrity = getResumeIntegrity(latestReport, candidate);
  const resumeIntegritySnapshot = automationIntegritySnapshot(resumeIntegrity);
  const reportResumeScore = toScoreOrNull(latestReport?.resume_score);
  const reportInterviewScore = toScoreOrNull(latestReport?.interview_score);
  const reportOverallScore = toScoreOrNull(latestReport?.overall_score);
  const rawResumeScore = reportResumeScore !== null ? reportResumeScore : getResumeAnalysisScore(candidate);
  const resumeScore = resumeIntegrity.automation_eligible ? rawResumeScore : null;
  const transcriptOverall = contentSufficiency.insufficient_content ? null : getTranscriptOverall(latestInterview);
  const interviewScore = reportInterviewScore !== null ? reportInterviewScore : transcriptOverall;
  const calculatedOverallScore =
    Number.isFinite(resumeScore) && Number.isFinite(interviewScore)
      ? Math.round((clampScore(resumeScore) + clampScore(interviewScore)) / 2)
      : null;
  const overallScore = resumeIntegrity.automation_eligible
    ? (reportOverallScore !== null ? reportOverallScore : calculatedOverallScore)
    : null;

  const normalizedCandidateSnapshot = {
    candidate_id: candidate.id,
    candidate_name: candidateName(candidate),
    candidate_email: String(candidate.email || '').trim() || null,
    client_id: candidate.client_id,
    role_id: role.id,
    role_title: String(role.title || '').trim() || 'Untitled Role',
    overall_score: overallScore,
    resume_score: resumeScore,
    interview_score: interviewScore,
    interview_status: String(candidate.interview_status || '').trim() || null,
    report_id: latestReport?.id || null,
    interview_id: latestInterview?.id || null,
    content_sufficiency: contentSufficiency,
    resume_integrity: resumeIntegritySnapshot
  };

  const matchReasons = [];
  const nonMatchReasons = [];
  const configuredThresholds = [
    criteriaConfigSnapshot.min_overall_score,
    criteriaConfigSnapshot.min_resume_score,
    criteriaConfigSnapshot.min_interview_score
  ].filter((value) => value !== null && value !== undefined);

  if (!configuredThresholds.length) {
    nonMatchReasons.push({
      code: 'no_score_thresholds_configured',
      detail: 'At least one score threshold is required for Phase 1 matching.'
    });
  }

  if (!resumeIntegrity.automation_eligible) {
    nonMatchReasons.push({
      code: resumeIntegrity.status === 'suspicious'
        ? 'resume_integrity_manual_review_required'
        : 'resume_integrity_unassessed',
      detail: 'Resume-derived scores cannot drive automation until document integrity review is complete.',
      integrity_status: resumeIntegrity.status,
      integrity_version: resumeIntegrity.version
    });
  }

  if (
    !criteriaConfigSnapshot.allow_resume_only &&
    criteriaConfigSnapshot.min_overall_score === null &&
    criteriaConfigSnapshot.min_interview_score === null
  ) {
    nonMatchReasons.push({
      code: 'interview_or_overall_threshold_required',
      detail: 'Rules with resume-only matching disabled must include an overall or interview score threshold.'
    });
  }

  if (criteriaConfigSnapshot.require_sufficient_content && contentSufficiency.insufficient_content) {
    nonMatchReasons.push({
      code: 'interview_content_insufficient',
      detail: 'Existing interview data indicates insufficient candidate content.',
      source: contentSufficiency.source,
      reason: contentSufficiency.reason
    });
  }

  if (!criteriaConfigSnapshot.allow_resume_only && interviewScore === null) {
    nonMatchReasons.push({
      code: 'resume_only_not_allowed',
      detail: 'Interview score is not available and resume-only matching is disabled.'
    });
  } else if (criteriaConfigSnapshot.allow_resume_only && interviewScore === null && resumeScore !== null) {
    matchReasons.push({
      code: 'resume_only_allowed',
      detail: 'Resume-only matching is enabled for this evaluation.'
    });
  }

  evaluateThreshold({
    label: 'overall_score',
    score: overallScore,
    min: criteriaConfigSnapshot.min_overall_score,
    matchReasons,
    nonMatchReasons
  });
  evaluateThreshold({
    label: 'resume_score',
    score: resumeScore,
    min: criteriaConfigSnapshot.min_resume_score,
    matchReasons,
    nonMatchReasons
  });
  evaluateThreshold({
    label: 'interview_score',
    score: interviewScore,
    min: criteriaConfigSnapshot.min_interview_score,
    matchReasons,
    nonMatchReasons
  });

  const matched = nonMatchReasons.length === 0;
  const evaluationStatus = matched ? 'matched' : 'not_matched';
  const scoreSnapshotHash = buildScoreSnapshotHash(normalizedCandidateSnapshot);
  const criteriaConfigHash = sha256(stableStringify(criteriaConfigSnapshot));
  const idempotencyKey = sha256(stableStringify({
    phase: 'candidate_automation_phase1',
    trigger_source: triggerSource,
    rule_id: ruleId,
    rule_version: ruleVersion,
    client_id: clientId,
    role_id: roleId,
    candidate_id: candidateId,
    report_id: normalizedCandidateSnapshot.report_id,
    interview_id: normalizedCandidateSnapshot.interview_id,
    score_snapshot_hash: scoreSnapshotHash,
    criteria_config_hash: criteriaConfigHash
  }));

  return {
    matched,
    evaluationStatus,
    normalizedCandidateSnapshot,
    criteriaConfigSnapshot,
    scoreSnapshotHash,
    matchReasons,
    nonMatchReasons,
    reportId: normalizedCandidateSnapshot.report_id,
    interviewId: normalizedCandidateSnapshot.interview_id,
    idempotencyKey
  };
}

module.exports = {
  evaluateCandidateAutomation,
  normalizeCriteriaConfig,
  stableStringify
};
