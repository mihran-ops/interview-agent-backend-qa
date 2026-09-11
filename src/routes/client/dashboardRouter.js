// routes/dashboard.js (drop in)
// Express router mounted at /dashboard

const express = require('express');
const Sentry = require('@sentry/node');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { supabase } = require('../../clients/supabase');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const { entityFieldsForClientId, loadEntityMap, resolveEntityFilter } = require('../../services/entityScopeFilter');
const { classifyInterviewDisplayState } = require('../../services/interviewDisplayState');


const router = express.Router();
const EXPOSE_INTERVIEW_ANALYSIS_V2 = process.env.EXPOSE_INTERVIEW_ANALYSIS_V2 === 'true';
const s3ClientsByRegion = new Map();

function getRequestId(req) {
  return (
    (req.headers['x-request-id'] || req.headers['x-correlation-id'] || req.headers['x-amzn-trace-id'] || null) &&
    String(req.headers['x-request-id'] || req.headers['x-correlation-id'] || req.headers['x-amzn-trace-id'])
  ) || null;
}

router.use((req, res, next) => {
  // Avoid cached dashboard payloads while we debug wiring.
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');

  next();
});

router.get('/ping', (req, res) => {
  return res.json({
    ok: true,
    ts: new Date().toISOString(),
    build_id: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null
  });
});

const DAILY_ROOM_RE = /(^https?:\/\/)?([a-z0-9-]+\.)?(tavus\.daily\.co|c\.daily\.co)(\/|\?|$)/i;
function isDailyRoomUrl(url) {
  return !!url && DAILY_ROOM_RE.test(String(url));
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

function normalizeUnansweredQuestions(primary, fallback) {
  const normalizeOne = (value) => {
    if (Array.isArray(value)) {
      return value.map(q => String(q || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return normalizeOne(parsed);
      } catch {}
      return [trimmed];
    }
    return [];
  };
  const primaryQuestions = normalizeOne(primary);
  return primaryQuestions.length ? primaryQuestions : normalizeOne(fallback);
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toScoreOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getScopedClientIds(req) {
  if (Array.isArray(req?.clientScope?.memberships)) {
    return req.clientScope.memberships.map(m => String(m?.client_id || '').trim()).filter(Boolean);
  }
  if (Array.isArray(req?.clientIds)) {
    return req.clientIds.map(id => String(id || '').trim()).filter(Boolean);
  }
  return [];
}

function getRecordingSignedUrlTtl() {
  const parsed = Number(process.env.S3_RECORDING_SIGNED_URL_TTL_SECONDS || 300);
  const ttl = Number.isFinite(parsed) ? Math.floor(parsed) : 300;
  return Math.max(60, Math.min(900, ttl));
}

function getS3Client(region) {
  if (!s3ClientsByRegion.has(region)) {
    s3ClientsByRegion.set(region, new S3Client({ region }));
  }
  return s3ClientsByRegion.get(region);
}

function recordingUnavailable(res, requestId, detail) {
  return res.status(409).json({
    error: 'recording_unavailable',
    code: 'RECORDING_UNAVAILABLE',
    detail,
    request_id: requestId || null
  });
}

function getTranscriptOverall(interviewRow) {
  const scores = parseJsonObject(interviewRow?.transcript_scores);
  return scores ? toScoreOrNull(scores.overall) : null;
}

function hasInsufficientInterviewSummary(summary) {
  const lower = String(summary || '').toLowerCase();
  return (
    lower.includes('before any substantive responses were recorded') ||
    lower.includes('before substantive responses were captured') ||
    lower.includes('insufficient data')
  );
}

function getPerceptionShape(interviewRow) {
  const scores = parseJsonObject(interviewRow?.perception_scores) || {};
  const clarity = toFiniteOrNull(scores.clarity);
  const confidence = toFiniteOrNull(scores.confidence);
  const engagementCanonical = toFiniteOrNull(scores.engagement);
  const engagementFallback = toFiniteOrNull(scores.body_language);
  const engagement = engagementCanonical !== null ? engagementCanonical : engagementFallback;
  const presentKeys = [];
  if (clarity !== null) presentKeys.push('clarity');
  if (confidence !== null) presentKeys.push('confidence');
  if (engagementCanonical !== null) presentKeys.push('engagement');
  else if (engagementFallback !== null) presentKeys.push('body_language');
  return { clarity, confidence, engagement, presentKeys, raw: scores };
}

function hasCanonicalAnalysis(interviewRow) {
  const transcriptOverall = getTranscriptOverall(interviewRow);
  if (transcriptOverall !== null) return true;
  const summary = typeof interviewRow?.interview_summary === 'string' ? interviewRow.interview_summary.trim() : '';
  if (summary) return true;
  const { clarity, confidence, engagement, raw } = getPerceptionShape(interviewRow);
  if (clarity !== null || confidence !== null || engagement !== null) return true;
  const legacyBody = toFiniteOrNull(raw?.body_language);
  return legacyBody !== null;
}

router.get('/interviews/:id/recording-url', requireAuth, withClientScope, async (req, res) => {
  const request_id = getRequestId(req);
  const interviewId = String(req.params?.id || '').trim();
  Sentry.setTag('route_name', 'dashboard_interview_recording_url');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));

  try {
    if (!interviewId) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'INTERVIEW_ID_REQUIRED',
        detail: 'Interview id is required.',
        request_id: request_id || null
      });
    }

    const { data: interview, error } = await supabase
      .from('interviews')
      .select('id, client_id, recording_status, recording_metadata, recording_ready_at')
      .eq('id', interviewId)
      .maybeSingle();

    if (error) {
      console.error('[dashboard/recording-url] interview lookup failed', {
        request_id: request_id || null,
        interview_id: interviewId,
        error: error.message || error,
        code: error.code || null
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'RECORDING_LOOKUP_FAILED',
        detail: 'Unable to load recording details.',
        request_id: request_id || null
      });
    }

    if (!interview) {
      return res.status(404).json({
        error: 'not_found',
        code: 'INTERVIEW_NOT_FOUND',
        detail: 'Interview not found.',
        request_id: request_id || null
      });
    }

    const clientId = String(interview.client_id || '').trim();
    const downloadRequested = String(req.query?.download || '').trim() === '1';
    const scopedIds = getScopedClientIds(req);
    if (!req.isGlobalAdmin && (!clientId || !scopedIds.includes(clientId))) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'INTERVIEW_FORBIDDEN',
        detail: 'You do not have access to this interview.',
        request_id: request_id || null
      });
    }

    if (String(interview.recording_status || '').toLowerCase() !== 'ready') {
      return recordingUnavailable(res, request_id, 'Recording is not ready.');
    }

    const metadata = parseJsonObject(interview.recording_metadata) || {};
    const bucketName = String(metadata.bucket_name || '').trim();
    const s3Key = String(metadata.s3_key || '').trim();
    if (!bucketName || !s3Key) {
      return recordingUnavailable(res, request_id, 'Recording metadata is incomplete.');
    }

    const region = String(process.env.AWS_REGION || process.env.TAVUS_RECORDING_S3_BUCKET_REGION || '').trim();
    if (!region) {
      return res.status(500).json({
        error: 'server_error',
        code: 'RECORDING_SIGNING_NOT_CONFIGURED',
        detail: 'Recording signing is not configured for this environment.',
        hint: 'Set AWS_REGION or TAVUS_RECORDING_S3_BUCKET_REGION and AWS credentials with S3 read access.',
        request_id: request_id || null
      });
    }

    const expiresIn = getRecordingSignedUrlTtl();
    let url;
    try {
      url = await getSignedUrl(
        getS3Client(region),
        new GetObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          ...(downloadRequested
            ? { ResponseContentDisposition: `attachment; filename="interview-recording-${interviewId}.mp4"` }
            : {})
        }),
        { expiresIn }
      );
    } catch (signErr) {
      console.error('[dashboard/recording-url] signing failed', {
        request_id: request_id || null,
        interview_id: interviewId,
        client_id: clientId || null,
        error: signErr?.message || signErr,
        name: signErr?.name || null
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'RECORDING_URL_SIGN_FAILED',
        detail: 'Unable to generate recording URL at this time.',
        hint: 'Verify AWS credentials and S3 read permissions.',
        request_id: request_id || null
      });
    }

    return res.json({
      ok: true,
      url,
      expires_in: expiresIn,
      recording_ready_at: interview.recording_ready_at || null,
      duration: toFiniteOrNull(metadata.duration)
    });
  } catch (e) {
    console.error('[dashboard/recording-url] unexpected', {
      request_id: request_id || null,
      interview_id: interviewId || null,
      error: e?.message || e
    });
    return res.status(500).json({
      error: 'server_error',
      code: 'RECORDING_URL_FAILED',
      detail: 'Unable to generate recording URL at this time.',
      request_id: request_id || null
    });
  }
});

/**
 * GET /dashboard/rows
 * One row per candidate (for the scoped client).
 * - Top-level cells come from candidates (+ role title)
 * - Scores + analyses come from the latest report for that candidate
 * - Video/Transcript/Analysis URLs come from the latest interview for that candidate
 * - FE uses latest_interview_id for Transcript/PDF actions
 */
router.get('/rows', requireAuth, withClientScope, async (req, res) => {
  const request_id = getRequestId(req);
  let sentryClientId = null;
  Sentry.setTag('route_name', 'dashboard_rows');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const debug = String(req.query.debug || '') === '1';
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    sentryClientId = clientId ? String(clientId) : null;
    if (sentryClientId) Sentry.setTag('client_id', sentryClientId);
    Sentry.addBreadcrumb({
      category: 'dashboard',
      message: 'dashboard rows query started',
      level: 'info',
      data: { client_id: sentryClientId }
    });

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const entityScope = await resolveEntityFilter({
      db: supabase,
      req,
      clientId,
      entityFilter: req.query.entity_filter || req.query.entity_id || null,
      requestId: request_id
    });
    if (!entityScope.ok) return res.status(entityScope.status).json(entityScope.body);
    const scopedClientIds = entityScope.clientIds.length ? entityScope.clientIds : [clientId];

    // 1) Candidates for this client
    let candidateQuery = supabase
      .from('candidates')
      .select('id, first_name, last_name, name, email, role_id, created_at, client_id, analysis_summary, resume_url')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (scopedClientIds.length === 1) candidateQuery = candidateQuery.eq('client_id', scopedClientIds[0]);
    else candidateQuery = candidateQuery.in('client_id', scopedClientIds);

    const { data: cands, error: cErr } = await candidateQuery;

    if (cErr) {
      Sentry.addBreadcrumb({
        category: 'dashboard',
        message: 'dashboard rows query failed',
        level: 'warning',
        data: {
          stage: 'candidates',
          client_id: sentryClientId,
          error: cErr?.message || null
        }
      });
      console.error('[dashboard/rows] candidates error', cErr);
      return res.status(500).json({ error: 'query failed (candidates)' });
    }

    const candIds = Array.from(new Set((cands || []).map(c => c.id)));
    const roleIds = Array.from(new Set((cands || []).map(c => c.role_id).filter(Boolean)));

    // 2) Roles (title)
    let rolesById = {};
    if (roleIds.length) {
      let roleQuery = supabase
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds);
      if (scopedClientIds.length === 1) roleQuery = roleQuery.eq('client_id', scopedClientIds[0]);
      else roleQuery = roleQuery.in('client_id', scopedClientIds);

      const { data: roles, error: rErr } = await roleQuery;
      if (rErr) {
        console.error('[dashboard/rows] roles error', rErr);
      } else {
        rolesById = Object.fromEntries(
          (roles || []).map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
        );
      }
    }

    // 3) Latest interview per candidate (within same client)
    let latestInterviewByCand = {};
    if (candIds.length) {
      const interviewSelect = [
        'id',
        'candidate_id',
        'client_id',
        'created_at',
        'video_url',
        'transcript_url',
        'transcript',
        'analysis_url',
        'analysis',
        'perception_scores',
        'transcript_scores',
        'interview_summary',
        'recording_status',
        'recording_ready_at',
        'unanswered_candidate_questions',
        'status',
        'failure_code',
        'failure_stage',
        'retryable',
        'replacement_eligible',
        'client_end_reason',
        'conversation_progress_state',
        'has_substantive_response'
      ];
      if (EXPOSE_INTERVIEW_ANALYSIS_V2) interviewSelect.push('interview_analysis_v2');

      let interviewQuery = supabase
        .from('interviews')
        .select(interviewSelect.join(', '))
        .in('candidate_id', candIds)
        .order('created_at', { ascending: false });
      if (scopedClientIds.length === 1) interviewQuery = interviewQuery.eq('client_id', scopedClientIds[0]);
      else interviewQuery = interviewQuery.in('client_id', scopedClientIds);

      const { data: ivs, error: iErr } = await interviewQuery;

      if (iErr) {
        Sentry.addBreadcrumb({
          category: 'dashboard',
          message: 'interview fetch failed',
          level: 'warning',
          data: {
            client_id: sentryClientId,
            error: iErr?.message || null
          }
        });
        console.error('[dashboard/rows] interviews error', iErr);
      } else {
        for (const iv of ivs || []) {
          const k = iv.candidate_id;
          if (!latestInterviewByCand[k]) latestInterviewByCand[k] = iv;
          // first seen is latest because list is desc
        }
      }
    }

    // 4) Latest report per candidate (within same client)
    // If your reports table uses different column names, adjust here.
    let latestReportByCand = {};
    if (candIds.length) {
      let reportQuery = supabase
        .from('reports')
        .select([
          'id',
          'created_at',
          'client_id',
          'candidate_id',
          'role_id',
          'resume_score',
          'interview_score',
          'overall_score',
          'resume_breakdown',
          'interview_breakdown',
          'analysis',
          'report_url',
          'unanswered_candidate_questions',
          'candidate_external_id',
        ].join(', '))
        .in('candidate_id', candIds)
        .order('created_at', { ascending: false });
      if (scopedClientIds.length === 1) reportQuery = reportQuery.eq('client_id', scopedClientIds[0]);
      else reportQuery = reportQuery.in('client_id', scopedClientIds);

      const { data: reps, error: repErr } = await reportQuery;

      if (repErr) {
        Sentry.addBreadcrumb({
          category: 'dashboard',
          message: 'report fetch failed',
          level: 'warning',
          data: {
            client_id: sentryClientId,
            error: repErr?.message || null
          }
        });
        console.error('[dashboard/rows] reports error', {
          request_id,
          client_id: clientId,
          code: repErr.code,
          message: repErr.message,
          details: repErr.details,
          hint: repErr.hint
        });
      } else {
        for (const r of reps || []) {
          const k = r.candidate_id;
          if (!latestReportByCand[k]) latestReportByCand[k] = r; // first is latest
        }
      }
    }

    // 5) Normalize: one row per candidate
    const entityClientIds = [
      ...(cands || []).map((candidate) => candidate.client_id),
      ...Object.values(rolesById).map((role) => role?.client_id)
    ];
    const entityMap = {
      ...(entityScope.entitiesById || {}),
      ...(await loadEntityMap(supabase, entityClientIds))
    };

    const items = (cands || []).map(c => {
      const fullName =
        c.name ||
        [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
        '';

      const role = c.role_id ? (rolesById[c.role_id] || null) : null;
      const iv = latestInterviewByCand[c.id] || null;
      const rep = latestReportByCand[c.id] || null;
      const entityClientId = role?.client_id || c.client_id;
      const entityFields = entityFieldsForClientId(entityMap, entityClientId);

      const parsed = parseJsonObject(c?.analysis_summary) || {};
      const rs = parsed.resume_score ?? parsed.resume ?? parsed.resume_match_percent ?? parsed.resumeMatchPercent ?? null;
      const resume_score = toScoreOrNull(rs);

      const resume_summary =
        (typeof parsed.summary === 'string' && parsed.summary) ||
        (typeof parsed.resume_summary === 'string' && parsed.resume_summary) ||
        (typeof parsed.resumeSummary === 'string' && parsed.resumeSummary) ||
        (typeof parsed.resume_analysis?.summary === 'string' && parsed.resume_analysis.summary) ||
        '';
      const resume_analysis = {
        experience: Number.isFinite(Number(parsed.experience_match_percent ?? parsed.experienceMatchPercent)) ? Number(parsed.experience_match_percent ?? parsed.experienceMatchPercent) : null,
        skills:     Number.isFinite(Number(parsed.skills_match_percent ?? parsed.skillsMatchPercent)) ? Number(parsed.skills_match_percent ?? parsed.skillsMatchPercent) : null,
        education:  Number.isFinite(Number(parsed.education_match_percent ?? parsed.educationMatchPercent)) ? Number(parsed.education_match_percent ?? parsed.educationMatchPercent) : null,
        summary: resume_summary
      };
      const perception = getPerceptionShape(iv);
      const interviewSummary = typeof iv?.interview_summary === 'string' ? iv.interview_summary : '';
      const transcriptOverall = getTranscriptOverall(iv);
      const insufficientInterview =
        hasInsufficientInterviewSummary(interviewSummary) ||
        iv?.has_substantive_response === false ||
        String(iv?.failure_code || '').trim().toUpperCase() === 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE';
      const interview_analysis = {
        clarity: insufficientInterview ? null : perception.clarity,
        confidence: insufficientInterview ? null : perception.confidence,
        engagement: insufficientInterview ? null : perception.engagement,
        summary: interviewSummary
      };

      // PDF URL preference: explicit latest_report_url, else report_url
      const latest_report_url = rep?.latest_report_url || rep?.report_url || null;
      const safeVideoUrl = iv?.video_url && !isDailyRoomUrl(iv.video_url) ? iv.video_url : null;
      const hasTranscript = !!iv?.transcript;
      const interviewScore = insufficientInterview ? null : (Number.isFinite(transcriptOverall) ? transcriptOverall : null);
      const interviewDisplayState = classifyInterviewDisplayState(iv, { hasScore: Number.isFinite(interviewScore) });
      const overall_score =
        Number.isFinite(resume_score) && Number.isFinite(interviewScore)
          ? Math.max(0, Math.min(100, Math.round((resume_score + interviewScore) / 2)))
          : null;
      const canonicalHasAnalysis = hasCanonicalAnalysis(iv);
      const transcriptScores = parseJsonObject(iv?.transcript_scores) || null;
      const exposedTranscriptScores = insufficientInterview && transcriptScores
        ? { ...transcriptScores, overall: null, confidence: null, ai_aided_risk: null, ai_aided_risk_reason: null }
        : transcriptScores;
      const perceptionScores = parseJsonObject(iv?.perception_scores) || null;
      const exposedPerceptionScores = insufficientInterview && perceptionScores
        ? { ...perceptionScores, clarity: null, confidence: null, engagement: null, body_language: null }
        : perceptionScores;

      return {
        // row identity is the candidate (FE now uses latest_interview_id for actions)
        id: c.id,
        created_at: c.created_at,
        client_id: c.client_id,
        ...entityFields,

        candidate: { id: c.id, name: fullName, email: c.email || '', resume_url: c.resume_url || null },
        role: role ? { ...role, ...entityFieldsForClientId(entityMap, role.client_id) } : null, // { id, title, client_id } | null

        // latest interview bits for the expanded area + transcript button
        latest_interview_id: iv?.id || null,
        recording_status: iv?.recording_status || null,
        recording_ready_at: iv?.recording_ready_at || null,
        video_url: safeVideoUrl,
        transcript_url: iv?.transcript_url || null,
        analysis_url: iv?.analysis_url || null,
        transcript_scores: exposedTranscriptScores,
        perception_scores: exposedPerceptionScores,
        interview_summary: interviewSummary || '',
        unanswered_candidate_questions: normalizeUnansweredQuestions(iv?.unanswered_candidate_questions),
        transcript: typeof iv?.transcript === 'string' ? iv.transcript : '',
        has_video: !!safeVideoUrl,
        has_transcript: hasTranscript,
        has_analysis: canonicalHasAnalysis,

        // report-driven bits
        resume_score,
        interview_score: interviewScore,
        interview_state: interviewDisplayState.state,
        interview_state_label: interviewDisplayState.label,
        overall_score,
        resume_analysis,
        interview_analysis,
        interview_analysis_v2: EXPOSE_INTERVIEW_ANALYSIS_V2 ? (parseJsonObject(iv?.interview_analysis_v2) || null) : undefined,
        latest_report_url,
        report_generated_at: rep?.created_at || null,
      };
    });

    return res.json({ items });
  } catch (e) {
    Sentry.captureException(e, {
      tags: {
        route_name: 'dashboard_rows',
        surface: 'backend',
        request_id: request_id || undefined,
        client_id: sentryClientId || undefined
      },
      extra: {
        request_id,
        client_id: sentryClientId
      }
    });
    console.error('[dashboard/rows] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * (Keep these existing endpoints in case other pages still use them)
 */
router.get('/interviews', requireAuth, withClientScope, async (req, res) => {
  const request_id = getRequestId(req);
  let sentryClientId = null;
  Sentry.setTag('route_name', 'dashboard_interviews');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    sentryClientId = clientId ? String(clientId) : null;
    if (sentryClientId) Sentry.setTag('client_id', sentryClientId);
    Sentry.addBreadcrumb({
      category: 'dashboard',
      message: 'dashboard interviews query started',
      level: 'info',
      data: { client_id: sentryClientId }
    });

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const interviewSelect = 'id, created_at, client_id, candidate_id, role_id, video_url, transcript_url, transcript, analysis_url, resume_score, interview_score, overall_score, resume_analysis, interview_analysis, latest_report_url, report_generated_at, perception_scores, transcript_scores, interview_summary, recording_status, recording_ready_at, unanswered_candidate_questions' +
      (EXPOSE_INTERVIEW_ANALYSIS_V2 ? ', interview_analysis_v2' : '');

    const { data: rows, error: iErr } = await supabase
      .from('interviews')
      .select(interviewSelect)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (iErr) {
      Sentry.addBreadcrumb({
        category: 'dashboard',
        message: 'dashboard interviews query failed',
        level: 'warning',
        data: {
          client_id: sentryClientId,
          error: iErr?.message || null
        }
      });
      console.error('[dashboard/interviews] supabase error', iErr);
      return res.status(500).json({ error: 'query failed' });
    }

    const candIds = Array.from(new Set((rows || []).map(r => r.candidate_id).filter(Boolean)));
    const roleIds = Array.from(new Set((rows || []).map(r => r.role_id).filter(Boolean)));

    let candidatesById = {};
    if (candIds.length) {
      const { data: cands, error: cErr } = await supabase
        .from('candidates')
        .select('id, first_name, last_name, name, email, client_id')
        .in('id', candIds)
        .eq('client_id', clientId);
      if (!cErr) {
        candidatesById = Object.fromEntries(
          (cands || []).map(c => {
            const fullName =
              c.name ||
              [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
              '';
            return [c.id, { id: c.id, name: fullName, email: c.email || '' }];
          })
        );
      }
    }

    let rolesById = {};
    if (roleIds.length) {
      const { data: roles } = await supabase
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds)
        .eq('client_id', clientId);
      rolesById = Object.fromEntries(
        (roles || []).map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
      );
    }

    const items = (rows || [])
      .filter(r => r.candidate_id && candidatesById[r.candidate_id])
      .map(r => {
        const safeVideoUrl = r.video_url && !isDailyRoomUrl(r.video_url) ? r.video_url : null;
        const hasTranscript = !!r.transcript_url || !!r.transcript;
        const transcriptOverall = getTranscriptOverall(r);
        const interviewSummary = typeof r?.interview_summary === 'string' ? r.interview_summary : '';
        const insufficientInterview = hasInsufficientInterviewSummary(interviewSummary);
        const interviewScore = insufficientInterview ? null : (Number.isFinite(transcriptOverall) ? transcriptOverall : null);
        const resumeScore = toScoreOrNull(r.resume_score);
        const overallScore =
          Number.isFinite(resumeScore) && Number.isFinite(interviewScore)
            ? Math.max(0, Math.min(100, Math.round((resumeScore + interviewScore) / 2)))
            : null;
        const perception = getPerceptionShape(r);
        const canonicalHasAnalysis = hasCanonicalAnalysis(r);
        const transcriptScores = parseJsonObject(r.transcript_scores) || null;
        const exposedTranscriptScores = insufficientInterview && transcriptScores
          ? { ...transcriptScores, overall: null, confidence: null, ai_aided_risk: null, ai_aided_risk_reason: null }
          : transcriptScores;
        const perceptionScores = parseJsonObject(r.perception_scores) || null;
        const exposedPerceptionScores = insufficientInterview && perceptionScores
          ? { ...perceptionScores, clarity: null, confidence: null, engagement: null, body_language: null }
          : perceptionScores;
        return {
        id: r.id,
        created_at: r.created_at,
        client_id: r.client_id,
        candidate: candidatesById[r.candidate_id],
        role: r.role_id ? (rolesById[r.role_id] || null) : null,
        recording_status: r.recording_status || null,
        recording_ready_at: r.recording_ready_at || null,
        video_url: safeVideoUrl,
        transcript_url: r.transcript_url || null,
        transcript_scores: exposedTranscriptScores,
        perception_scores: exposedPerceptionScores,
        interview_summary: interviewSummary || '',
        unanswered_candidate_questions: Array.isArray(r.unanswered_candidate_questions) ? r.unanswered_candidate_questions : [],
        analysis_url: r.analysis_url || null,
        has_video: !!safeVideoUrl,
        has_transcript: hasTranscript,
        has_analysis: canonicalHasAnalysis,
        resume_score: resumeScore,
        interview_score: interviewScore,
        overall_score: overallScore,
        resume_analysis: r.resume_analysis || { experience: null, skills: null, education: null, summary: '' },
        interview_analysis: {
          clarity: insufficientInterview ? null : perception.clarity,
          confidence: insufficientInterview ? null : perception.confidence,
          engagement: insufficientInterview ? null : perception.engagement,
          summary: interviewSummary
        },
        interview_analysis_v2: EXPOSE_INTERVIEW_ANALYSIS_V2 ? (parseJsonObject(r?.interview_analysis_v2) || null) : undefined,
        latest_report_url: r.latest_report_url || null,
        report_generated_at: r.report_generated_at || null,
      };
      });

    return res.json({ items });
  } catch (e) {
    Sentry.captureException(e, {
      tags: {
        route_name: 'dashboard_interviews',
        surface: 'backend',
        request_id: request_id || undefined,
        client_id: sentryClientId || undefined
      },
      extra: {
        request_id,
        client_id: sentryClientId
      }
    });
    console.error('[dashboard/interviews] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/candidates', requireAuth, withClientScope, async (req, res) => {
  const request_id = getRequestId(req);
  let sentryClientId = null;
  Sentry.setTag('route_name', 'dashboard_candidates');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    sentryClientId = clientId ? String(clientId) : null;
    if (sentryClientId) Sentry.setTag('client_id', sentryClientId);
    Sentry.addBreadcrumb({
      category: 'dashboard',
      message: 'dashboard candidates query started',
      level: 'info',
      data: { client_id: sentryClientId }
    });

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const { data: rows, error } = await supabase
      .from('candidates')
      .select('id, first_name, last_name, email, role_id, analysis_summary, resume_url, interview_video_url, created_at, status')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      Sentry.addBreadcrumb({
        category: 'dashboard',
        message: 'dashboard candidates query failed',
        level: 'warning',
        data: {
          client_id: sentryClientId,
          error: error?.message || null
        }
      });
      console.error('[dashboard/candidates] supabase error', error);
      return res.status(500).json({ error: 'query failed' });
    }

    const roleIds = Array.from(new Set((rows || []).map(r => r.role_id).filter(Boolean)));
    let rolesById = {};
    if (roleIds.length) {
      const { data: roles } = await supabase
        .from('roles')
        .select('id, title')
        .in('id', roleIds)
        .eq('client_id', clientId);
      rolesById = Object.fromEntries((roles || []).map(r => [r.id, r.title]));
    }

    const items = (rows || []).map(r => {
      let resumeScore = null, interviewScore = null, overallScore = null;
      try {
        const a = r.analysis_summary || {};
        resumeScore    = a.resume_score ?? a.resume ?? a.resume_match_percent ?? null;
      } catch {}
      const resumeScoreNumber = isFinite(resumeScore) ? Number(resumeScore) : null;
      const interviewScoreNumber = Number.isFinite(interviewScore) ? Number(interviewScore) : null;
      overallScore =
        Number.isFinite(resumeScoreNumber) && Number.isFinite(interviewScoreNumber)
          ? Math.max(0, Math.min(100, Math.round((resumeScoreNumber + interviewScoreNumber) / 2)))
          : null;

      return {
        id: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || '—',
        email: r.email || '—',
        role: rolesById[r.role_id] || '—',
        resume_score: resumeScoreNumber,
        interview_score: interviewScoreNumber,
        overall_score: overallScore,
        created_at: r.created_at,
        resume_url: r.resume_url || null,
        interview_video_url: r.interview_video_url || null,
        analysis_summary: r.analysis_summary || {},
      };
    });

    res.json({ items });
  } catch (e) {
    Sentry.captureException(e, {
      tags: {
        route_name: 'dashboard_candidates',
        surface: 'backend',
        request_id: request_id || undefined,
        client_id: sentryClientId || undefined
      },
      extra: {
        request_id,
        client_id: sentryClientId
      }
    });
    console.error('[dashboard/candidates] unexpected', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
