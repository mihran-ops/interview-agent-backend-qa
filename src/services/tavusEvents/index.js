'use strict';

// The Tavus event pipeline. This was the body of routes/webhook.js, which carried
// sixty-eight helpers behind two endpoints; the router now keeps only the express
// wiring and delegates here.


const Sentry = require('@sentry/node');
const crypto = require('node:crypto');
const { TIMEOUT_PROFILES } = require('../../clients/http');
const { supabaseAdmin: defaultSupabaseAdmin } = require('../../clients/supabase');
const { analyzeInterviewTranscriptById } = require('../../../scripts/backfillInterviews.js');
const { generateInterviewAnalysisV2 } = require('../interviewAnalysisV2');
const { INSUFFICIENT_SUMMARY, isSubstantiveTranscript, scoreInterview } = require('../interviewScoring');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../roleInterviewAvailability');
const { transcriptCompletionTransition } = require('../interviewLifecycle');
const { classifyCandidateUtterance } = require('../interviewUtteranceClassifier');
const { excludeWarmupFromTranscript, excludeWarmupFromTranscriptItems } = require('../warmupExclusion');
const {
  buildEvidenceSnapshot,
  projectReconciliationLog,
  validateTranscriptScores,
} = require('../finalTranscriptReconciliation');
const {
  extractCandidateQuestions,
} = require('../unansweredCandidateQuestions');
const { isTerminalInterviewToolName } = require('../tavusTerminalTool');
const { authenticateTavusWebhookRequest } = require('../tavusWebhookAuth');
const { tavusHttpClient: defaultTavusHttpClient } = require('../../clients/tavus');
const {
  buildTavusWebhookValidationTelemetry,
  getOwnPath,
  validateTavusWebhookPayload,
} = require('../tavusWebhookPayload');

let activeTavusHttpClient = defaultTavusHttpClient;

let supabaseAdmin = defaultSupabaseAdmin;

const TRANSCRIPTS_BUCKET = process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts';

const DAILY_ROOM_RE = /(^https?:\/\/)?([a-z0-9-]+\.)?(tavus\.daily\.co|c\.daily\.co)(\/|\?|$)/i;
const ANALYSIS_TRIGGER_TTL_MS = 2 * 60 * 1000;
const ENABLE_TAVUS_PERCEPTION_EVENTS = process.env.ENABLE_TAVUS_PERCEPTION_EVENTS === 'true';
const ENABLE_INTERVIEW_ANALYSIS_V2 = process.env.ENABLE_INTERVIEW_ANALYSIS_V2 === 'true';
const analysisTriggerGuard = new Map();
const roleScoringContextCache = new Map();

// --- utilities ---
function pickFirst(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function fromAny(obj, ...paths) {
  for (const p of paths) {
    const result = getOwnPath(obj, p);
    if (result.found) return result.value;
  }
  return undefined;
}

async function recordLifecycleEvent({ interview, body, eventType, receivedAt }) {
  if (!supabaseAdmin || !interview?.id || !interview?.client_id) return false;
  const rawRole = String(pickFirst(
    fromAny(body, 'properties.role'), fromAny(body, 'role'), fromAny(body, 'payload.properties.role'), fromAny(body, 'payload.role')
  ) || '').toLowerCase();
  const speakerRole = /candidate|user|participant/.test(rawRole)
    ? 'candidate'
    : (/replica|assistant|agent|ai/.test(rawRole) ? 'ai' : 'system');
  const utterance = String(pickFirst(
    fromAny(body, 'properties.speech'), fromAny(body, 'properties.text'), fromAny(body, 'speech'), fromAny(body, 'text'), fromAny(body, 'payload.properties.speech'), fromAny(body, 'payload.properties.text')
  ) || '');
  const classification = speakerRole === 'candidate' ? classifyCandidateUtterance(utterance) : null;
  const vendorEventId = String(pickFirst(
    fromAny(body, 'event_id'), fromAny(body, 'id'), fromAny(body, 'payload.event_id'), fromAny(body, 'payload.id')
  ) || '').trim() || null;
  const observedAt = pickFirst(fromAny(body, 'timestamp'), fromAny(body, 'created_at'), fromAny(body, 'payload.timestamp'), receivedAt);
  const dedupeKey = vendorEventId || require('crypto').createHash('sha256')
    .update(`${eventType}|${speakerRole}|${observedAt || ''}|${utterance.slice(0, 200)}`)
    .digest('hex');
  const { data, error } = await supabaseAdmin.rpc('record_interview_lifecycle_event', {
    p_interview_id: interview.id,
    p_client_id: interview.client_id,
    p_event_type: eventType || 'unknown',
    p_vendor_event_id: vendorEventId,
    p_dedupe_key: dedupeKey,
    p_speaker_role: speakerRole,
    p_utterance_classification: classification?.classification || null,
    p_observed_at: observedAt || null,
    // Avoid full transcript/utterance storage in telemetry.
    p_metadata: { word_count: classification?.wordCount || 0 },
  });
  if (error) {
    console.warn('[webhook] lifecycle_event_not_recorded', { interview_id: interview.id, event_type: eventType, error: error.message || error });
    return false;
  }
  return data === true;
}

function fromAnyPathList(obj, paths) {
  for (const p of paths) {
    const value = fromAny(obj, p);
    if (value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())) return value;
  }
  return undefined;
}

function collectValues(obj, ...paths) {
  const out = [];
  for (const p of paths) {
    const v = fromAny(obj, p);
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== undefined && item !== null) out.push(item);
      }
    } else {
      out.push(v);
    }
  }
  return out;
}

function isDailyRoomUrl(url) {
  return !!url && DAILY_ROOM_RE.test(String(url));
}

function isDownloadableRecordingUrl(url) {
  if (!url) return false;
  if (!/^https?:\/\//i.test(String(url))) return false;
  if (isDailyRoomUrl(url)) return false;
  return true;
}

function isMissingColumnError(error) {
  const msg = String(error?.message || '');
  return /column .* does not exist/i.test(msg) || /could not find .* column .* schema cache/i.test(msg);
}

function pruneMetadata(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    out[key] = value;
  }
  return out;
}

function hasColumn(row, key) {
  return Object.prototype.hasOwnProperty.call(row || {}, key);
}

function looksLikeJson(value) {
  if (value == null) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function clampScore(value) {
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}

function plainObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function averageClampedScores(values) {
  const nums = (values || [])
    .map((value) => clampScore(value))
    .filter((value) => value !== null);
  if (!nums.length) return null;
  return clampScore(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function safeTopKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

const PERCEPTION_EVENT_PAYLOAD_DROP_KEYS = new Set([
  'image',
  'images',
  'frame',
  'frames',
  'screenshot',
  'screenshots',
  'base64',
  'image_base64',
  'media',
  'binary',
  'blob',
  'data_url'
]);

function sanitizePerceptionEventPayload(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizePerceptionEventPayload(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PERCEPTION_EVENT_PAYLOAD_DROP_KEYS.has(String(key).toLowerCase())) continue;
    out[key] = sanitizePerceptionEventPayload(item);
  }
  return out;
}

function normalizeOptionalTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isDuplicateInsertError(error) {
  const msg = String(error?.message || '');
  return error?.code === '23505' || /duplicate key/i.test(msg);
}

function buildPerceptionEventNormalized(body, eventType, toolName) {
  const properties = fromAny(body, 'properties') || fromAny(body, 'payload.properties') || {};
  const seq = pickFirst(
    fromAny(body, 'seq'),
    fromAny(body, 'sequence'),
    fromAny(body, 'properties.seq'),
    fromAny(body, 'properties.sequence'),
    fromAny(body, 'payload.seq'),
    fromAny(body, 'payload.sequence'),
    fromAny(body, 'payload.properties.seq'),
    fromAny(body, 'payload.properties.sequence')
  );
  const turnIdx = pickFirst(
    fromAny(body, 'turn_idx'),
    fromAny(body, 'turnIndex'),
    fromAny(body, 'turn.index'),
    fromAny(body, 'properties.turn_idx'),
    fromAny(body, 'properties.turnIndex'),
    fromAny(body, 'payload.turn_idx'),
    fromAny(body, 'payload.turnIndex'),
    fromAny(body, 'payload.properties.turn_idx'),
    fromAny(body, 'payload.properties.turnIndex')
  );
  const messageType = pickFirst(
    fromAny(body, 'message_type'),
    fromAny(body, 'messageType'),
    fromAny(body, 'message.type'),
    fromAny(body, 'properties.message_type'),
    fromAny(body, 'properties.messageType'),
    fromAny(body, 'payload.message_type'),
    fromAny(body, 'payload.messageType'),
    fromAny(body, 'payload.message.type')
  );
  const modalityRaw = pickFirst(
    fromAny(body, 'modality'),
    fromAny(body, 'properties.modality'),
    fromAny(body, 'payload.modality'),
    fromAny(body, 'payload.properties.modality')
  );
  const hasUserAudioAnalysis = !!pickFirst(
    fromAny(body, 'user_audio_analysis'),
    fromAny(body, 'userAudioAnalysis'),
    fromAny(body, 'properties.user_audio_analysis'),
    fromAny(body, 'properties.userAudioAnalysis'),
    fromAny(body, 'payload.user_audio_analysis'),
    fromAny(body, 'payload.userAudioAnalysis'),
    fromAny(body, 'payload.properties.user_audio_analysis'),
    fromAny(body, 'payload.properties.userAudioAnalysis')
  );
  const hasUserVisualAnalysis = !!pickFirst(
    fromAny(body, 'user_visual_analysis'),
    fromAny(body, 'userVisualAnalysis'),
    fromAny(body, 'properties.user_visual_analysis'),
    fromAny(body, 'properties.userVisualAnalysis'),
    fromAny(body, 'payload.user_visual_analysis'),
    fromAny(body, 'payload.userVisualAnalysis'),
    fromAny(body, 'payload.properties.user_visual_analysis'),
    fromAny(body, 'payload.properties.userVisualAnalysis')
  );
  const modality = modalityRaw
    ? String(modalityRaw)
    : hasUserAudioAnalysis && hasUserVisualAnalysis
      ? 'audio_visual'
      : hasUserAudioAnalysis
        ? 'audio'
        : hasUserVisualAnalysis
          ? 'visual'
          : null;

  const normalized = {
    event_type: eventType,
    has_user_audio_analysis: hasUserAudioAnalysis,
    has_user_visual_analysis: hasUserVisualAnalysis,
    payload_top_keys: safeTopKeys(body),
    properties_top_keys: safeTopKeys(properties)
  };
  if (messageType !== undefined && messageType !== null) normalized.message_type = String(messageType);
  if (seq !== undefined && seq !== null) normalized.seq = seq;
  if (turnIdx !== undefined && turnIdx !== null) normalized.turn_idx = turnIdx;
  if (modality) normalized.modality = modality;
  if (toolName) normalized.tool_name = toolName;
  return normalized;
}

function getPerceptionEventIds(body, eventType, conversationId, eventReceivedAtIso) {
  const eventId = pickFirst(
    fromAny(body, 'event_id'),
    fromAny(body, 'eventId'),
    fromAny(body, 'event.id'),
    fromAny(body, 'properties.event_id'),
    fromAny(body, 'properties.eventId'),
    fromAny(body, 'properties.event.id'),
    fromAny(body, 'payload.event_id'),
    fromAny(body, 'payload.eventId'),
    fromAny(body, 'payload.event.id')
  );
  const tavusCreatedAt = normalizeOptionalTimestamp(pickFirst(
    fromAny(body, 'tavus_created_at'),
    fromAny(body, 'created_at'),
    fromAny(body, 'createdAt'),
    fromAny(body, 'timestamp'),
    fromAny(body, 'event_created_at'),
    fromAny(body, 'properties.tavus_created_at'),
    fromAny(body, 'properties.created_at'),
    fromAny(body, 'properties.createdAt'),
    fromAny(body, 'properties.timestamp'),
    fromAny(body, 'payload.tavus_created_at'),
    fromAny(body, 'payload.created_at'),
    fromAny(body, 'payload.createdAt'),
    fromAny(body, 'payload.timestamp')
  ));
  const seq = pickFirst(
    fromAny(body, 'seq'),
    fromAny(body, 'sequence'),
    fromAny(body, 'properties.seq'),
    fromAny(body, 'properties.sequence'),
    fromAny(body, 'payload.seq'),
    fromAny(body, 'payload.sequence')
  );
  const turnIdx = pickFirst(
    fromAny(body, 'turn_idx'),
    fromAny(body, 'turnIndex'),
    fromAny(body, 'properties.turn_idx'),
    fromAny(body, 'properties.turnIndex'),
    fromAny(body, 'payload.turn_idx'),
    fromAny(body, 'payload.turnIndex')
  );
  const timestampForDedupe = tavusCreatedAt || eventReceivedAtIso;
  const dedupeKey = eventId
    ? null
    : [eventType || 'unknown', conversationId || 'unknown', timestampForDedupe || 'unknown', seq ?? '', turnIdx ?? ''].join('|');
  return {
    event_id: eventId === undefined || eventId === null || String(eventId).trim() === '' ? null : String(eventId),
    tavus_created_at: tavusCreatedAt,
    dedupe_key: dedupeKey
  };
}

async function ingestPerceptionEvent({ interview, body, eventType, requestId, conversationId, eventReceivedAtIso, toolName }) {
  const eventIds = getPerceptionEventIds(body, eventType, conversationId, eventReceivedAtIso);
  const normalized = buildPerceptionEventNormalized(body, eventType, toolName);
  const logBase = {
    request_id: requestId || null,
    event_type: eventType || null,
    interview_id: interview?.id || null,
    conversation_id: conversationId || null,
    event_id: eventIds.event_id,
    dedupe_key: eventIds.dedupe_key,
    payload_top_keys: normalized.payload_top_keys
  };

  try {
    const { error } = await supabaseAdmin
      .from('interview_perception_events')
      .insert({
        interview_id: interview.id,
        client_id: interview.client_id || null,
        conversation_id: conversationId || interview.tavus_application_id || interview.conversation_id || null,
        event_type: eventType,
        event_id: eventIds.event_id,
        tavus_created_at: eventIds.tavus_created_at,
        payload: sanitizePerceptionEventPayload(body || {}),
        normalized,
        dedupe_key: eventIds.dedupe_key
      });
    if (error) {
      if (isDuplicateInsertError(error)) {
        console.log('[webhook] perception_event skipped duplicate', logBase);
        return { inserted: false, duplicate: true };
      }
      console.error('[webhook] perception_event insert failed', {
        ...logBase,
        error: error.message || error,
        details: error.details || null,
        hint: error.hint || null
      });
      Sentry.captureException(new Error(error.message || 'perception_event_insert_failed'), {
        tags: {
          route_name: 'tavus_webhook',
          surface: 'backend',
          event_type: eventType || undefined,
          interview_id: interview?.id || undefined,
          conversation_id: conversationId || undefined
        },
        extra: {
          ...logBase,
          error_code: error.code || null,
          error_details: error.details || null,
          error_hint: error.hint || null
        }
      });
      return { inserted: false, error };
    }
    console.log('[webhook] perception_event inserted', logBase);
    return { inserted: true };
  } catch (err) {
    console.error('[webhook] perception_event insert failed', {
      ...logBase,
      error: err?.message || err
    });
    Sentry.captureException(err, {
      tags: {
        route_name: 'tavus_webhook',
        surface: 'backend',
        event_type: eventType || undefined,
        interview_id: interview?.id || undefined,
        conversation_id: conversationId || undefined
      },
      extra: logBase
    });
    return { inserted: false, error: err };
  }
}

function elapsedSecondsSince(isoLike, endAt) {
  if (!isoLike) return null;
  const started = new Date(isoLike);
  if (Number.isNaN(started.getTime())) return null;
  const ended = endAt instanceof Date ? endAt : new Date(endAt || Date.now());
  if (Number.isNaN(ended.getTime())) return null;
  return Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000));
}

function extractPerceptionScores(payload) {
  if (!payload || typeof payload !== 'object') return {};

  const clarityRaw = fromAnyPathList(payload, [
    'clarity',
    'scores.clarity',
    'analysis.clarity',
    'analysis.scores.clarity',
    'perception_analysis.clarity',
    'perception_analysis.scores.clarity'
  ]);
  const confidenceRaw = fromAnyPathList(payload, [
    'confidence',
    'scores.confidence',
    'analysis.confidence',
    'analysis.scores.confidence',
    'perception_analysis.confidence',
    'perception_analysis.scores.confidence'
  ]);
  const engagementRaw = fromAnyPathList(payload, [
    'engagement',
    'engagement_score',
    'scores.engagement',
    'analysis.engagement',
    'analysis.scores.engagement',
    'perception_analysis.engagement',
    'perception_analysis.engagement_score',
    'perception_analysis.scores.engagement'
  ]);
  const bodyLanguageRaw = fromAnyPathList(payload, [
    'body_language',
    'bodyLanguage',
    'body_language_score',
    'bodyLanguageScore',
    'nonverbal',
    'non_verbal',
    'nonVerbal',
    'nonverbal_score',
    'nonVerbalScore',
    'scores.body_language',
    'scores.bodyLanguage',
    'scores.bodyLanguageScore',
    'scores.nonverbal',
    'scores.nonVerbal',
    'analysis.body_language',
    'analysis.bodyLanguage',
    'analysis.bodyLanguageScore',
    'analysis.nonverbal',
    'analysis.nonVerbal',
    'analysis.scores.body_language',
    'analysis.scores.bodyLanguage',
    'analysis.scores.bodyLanguageScore',
    'analysis.scores.nonverbal',
    'analysis.scores.nonVerbal',
    'perception_analysis.body_language',
    'perception_analysis.bodyLanguage',
    'perception_analysis.body_language_score',
    'perception_analysis.bodyLanguageScore',
    'perception_analysis.nonverbal',
    'perception_analysis.non_verbal',
    'perception_analysis.nonVerbal',
    'perception_analysis.nonverbal_score',
    'perception_analysis.nonVerbalScore',
    'perception_analysis.scores.body_language',
    'perception_analysis.scores.bodyLanguage',
    'perception_analysis.scores.bodyLanguageScore',
    'perception_analysis.scores.nonverbal',
    'perception_analysis.scores.nonVerbal'
  ]);

  const out = {};
  const clarity = clampScore(clarityRaw);
  const confidence = clampScore(confidenceRaw);
  const engagement = clampScore(engagementRaw !== undefined ? engagementRaw : bodyLanguageRaw);
  if (clarity !== null) out.clarity = clarity;
  if (confidence !== null) out.confidence = confidence;
  if (engagement !== null) out.engagement = engagement;
  return out;
}

function extractPerceptionScoresFromText(text) {
  if (!text || typeof text !== 'string') return {};
  const markdownNormalized = String(text)
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*/g, '')
    .replace(/`/g, '');
  const readNum = (re) => {
    const direct = re.exec(text);
    if (direct) return clampScore(direct[1]);
    const normalized = re.exec(markdownNormalized);
    if (!normalized) return null;
    return clampScore(normalized[1]);
  };
  const clarity = readNum(/CLARITY\s*[:=]\s*(\d{1,3})/i);
  const confidence = readNum(/CONFIDENCE\s*[:=]\s*(\d{1,3})/i);
  let engagement = readNum(/ENGAGEMENT\s*[:=]\s*(\d{1,3})/i);
  if (engagement === null) engagement = readNum(/BODY[_\s-]*LANGUAGE\s*[:=]\s*(\d{1,3})/i);
  if (engagement === null) engagement = readNum(/NONVERBAL\s*[:=]\s*(\d{1,3})/i);

  const out = {};
  if (clarity !== null) out.clarity = clarity;
  if (confidence !== null) out.confidence = confidence;
  if (engagement !== null) out.engagement = engagement;
  return out;
}

function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || null;
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const snippet = text.slice(first, last + 1);
    try {
      return JSON.parse(snippet);
    } catch {
      return null;
    }
  }
  return null;
}

function sanitizePerceptionText(text) {
  if (!text) return '';
  let out = String(text);
  const patterns = [
    /\b(\d{1,2}\s*-\s*year\s*-\s*old|\d{1,2}\s*year\s*old|\d{2}s|teen(ager|age)?|young|younger|middle[-\s]?aged|elderly|senior|old|older)\b/gi,
    /\b(male|female|man|woman|boy|girl|nonbinary|non-binary|transgender|cisgender|trans|cis)\b/gi,
    /\b(white|black|african\s*american|asian|latino|latina|latinx|hispanic|indigenous|native\s*american|middle\s*eastern|arab|pacific\s*islander)\b/gi,
    /\b(christian|muslim|jewish|hindu|buddhist|sikh|atheist|agnostic|catholic|protestant|mormon)\b/gi,
    /\b(disabled|disability|wheelchair|blind|deaf|autistic|adhd|amputee|bipolar|schizophrenia|ptsd|paralyzed)\b/gi,
    /\b(pregnant|pregnancy)\b/gi,
    /\b(in|around)\s+(his|her|their)\s+\d{2}s\b/gi,
    /\b(appears|appeared|seems|seemed|looks|looked)\s+(?:to\s+be\s+)?(young|older|middle[-\s]?aged|elderly|\d{2}s)\b/gi
  ];
  for (const re of patterns) {
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(/\[REDACTED\](\s+\[REDACTED\])+/g, '[REDACTED]');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

function hasAnalysisResult(interview) {
  if (!interview) return false;
  if (interview.analysis) {
    if (typeof interview.analysis === 'object') {
      if (Array.isArray(interview.analysis)) return interview.analysis.length > 0;
      return Object.keys(interview.analysis).length > 0;
    }
    return true;
  }
  if (interview.analysis_url) return true;
  if (interview.interview_analysis) return true;
  if (interview.report_url) return true;
  if (interview.overall_score !== undefined && interview.overall_score !== null) return true;
  return false;
}

function hasTranscriptAnalysis(interview) {
  if (!interview || !interview.analysis || typeof interview.analysis !== 'object' || Array.isArray(interview.analysis)) {
    return false;
  }
  const summary = typeof interview.analysis.summary === 'string' ? interview.analysis.summary.trim() : '';
  const transcriptScores = interview.analysis.transcript_scores && typeof interview.analysis.transcript_scores === 'object'
    ? Object.keys(interview.analysis.transcript_scores).length > 0
    : false;
  const legacyScores = interview.analysis.scores && typeof interview.analysis.scores === 'object'
    ? Object.keys(interview.analysis.scores).length > 0
    : false;
  return !!summary && (transcriptScores || legacyScores);
}

function isTranscriptAnalysisComplete(analysis) {
  if (!analysis) return false;
  let obj = analysis;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return false;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const overallNew = obj.transcript_scores && typeof obj.transcript_scores === 'object'
    ? obj.transcript_scores.overall
    : undefined;
  const overallLegacy = obj.scores && typeof obj.scores === 'object'
    ? obj.scores.overall
    : undefined;
  return Number.isFinite(overallNew) || Number.isFinite(overallLegacy);
}

function isTranscriptAnalysisCompleteForRow(row) {
  if (!row) return false;
  if (row.transcript_scores && typeof row.transcript_scores === 'object') {
    if (Number.isFinite(row.transcript_scores.overall)) return true;
  }
  return isTranscriptAnalysisComplete(row.analysis);
}

function hasNoSubstantiveInterviewSummary(summary) {
  const lower = String(summary || '').toLowerCase();
  return (
    lower.includes('before any substantive responses were recorded') ||
    lower.includes('before substantive responses were captured') ||
    lower.includes('before a substantive candidate response was recorded') ||
    lower.includes('insufficient data')
  );
}

function analysisV2Eligibility(row) {
  const evaluativeTranscript = excludeWarmupFromTranscript(row?.transcript);
  if (!evaluativeTranscript) {
    return { eligible: false, reason: 'missing_evaluative_transcript' };
  }

  const hasCurrentSubstantiveEvidence = row?.has_substantive_response === true;
  const explicitlyNonSubstantive =
    row?.has_substantive_response === false ||
    String(row?.conversation_progress_state || '').trim() === 'NoSubstantiveCandidateResponse' ||
    (
      !hasCurrentSubstantiveEvidence &&
      String(row?.failure_code || '').trim().toUpperCase() === 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE'
    ) ||
    hasNoSubstantiveInterviewSummary(row?.interview_summary);
  if (explicitlyNonSubstantive) {
    return { eligible: false, reason: 'no_substantive_responses' };
  }

  const evidence = isSubstantiveTranscript(evaluativeTranscript);
  if (!evidence?.ok) {
    return { eligible: false, reason: 'no_substantive_responses' };
  }
  return { eligible: true, reason: null };
}

function hasExistingPerceptionScores(scores) {
  const obj = plainObject(scores);
  return clampScore(obj.clarity) !== null ||
    clampScore(obj.confidence) !== null ||
    clampScore(obj.engagement) !== null ||
    clampScore(obj.body_language) !== null;
}

function hasSubstantiveTranscriptScores(row) {
  if (hasNoSubstantiveInterviewSummary(row?.interview_summary)) return false;
  const scores = plainObject(row?.transcript_scores);
  return clampScore(scores.overall) !== null ||
    clampScore(scores.role_fit ?? scores.roleFit) !== null ||
    clampScore(scores.communication_quality ?? scores.communicationQuality) !== null ||
    clampScore(scores.technical_strength ?? scores.technicalStrength) !== null;
}

function buildTranscriptPerceptionFallback(row) {
  const transcriptScores = plainObject(row?.transcript_scores);
  const v2 = plainObject(row?.interview_analysis_v2);
  const v2Scores = plainObject(v2.scores);
  const v2Average = averageClampedScores([
    v2Scores.answer_directness,
    v2Scores.response_specificity,
    v2Scores.answer_consistency
  ]);
  const clarity = clampScore(v2Scores.communication_structure) ??
    clampScore(transcriptScores.communication_quality ?? transcriptScores.communicationQuality);
  const confidence = v2Average ?? clampScore(transcriptScores.confidence);
  const engagement = v2Average ??
    clampScore(transcriptScores.role_fit ?? transcriptScores.roleFit) ??
    clampScore(transcriptScores.communication_quality ?? transcriptScores.communicationQuality);

  if (clarity === null || confidence === null || engagement === null) return null;
  return {
    clarity,
    confidence,
    engagement,
    source: 'transcript_fallback',
    fallback: true,
    fallback_reason: 'tavus_perception_empty_analysis',
    modality: 'transcript_only',
    visual_signal_available: false
  };
}

function logPerceptionFallback(event, details) {
  console.log(`[webhook] ${event}`, {
    request_id: details?.request_id || null,
    interview_id: details?.interview_id || null,
    conversation_id: details?.conversation_id || null,
    source: details?.source || null,
    fallback_reason: details?.fallback_reason || null,
    reason: details?.reason || null
  });
}

async function maybeStoreTranscriptPerceptionFallback(interview, requestId, conversationId) {
  const baseLog = {
    request_id: requestId || null,
    interview_id: interview?.id || null,
    conversation_id: conversationId || null,
    source: 'transcript_fallback',
    fallback_reason: 'tavus_perception_empty_analysis'
  };
  try {
    if (!supabaseAdmin || !interview?.id) {
      logPerceptionFallback('tavus_perception_empty_fallback_skipped', { ...baseLog, reason: 'missing_db_or_interview_id' });
      return { stored: false };
    }

    const { data: row, error } = await supabaseAdmin
      .from('interviews')
      .select('id,transcript_scores,interview_analysis_v2,interview_summary,perception_scores')
      .eq('id', interview.id)
      .maybeSingle();
    if (error || !row) {
      logPerceptionFallback('tavus_perception_empty_fallback_skipped', { ...baseLog, reason: error?.message || 'interview_not_found' });
      return { stored: false };
    }
    if (hasNoSubstantiveInterviewSummary(row.interview_summary)) {
      logPerceptionFallback('tavus_perception_empty_fallback_skipped', { ...baseLog, reason: 'no_substantive_responses' });
      return { stored: false };
    }
    if (!hasSubstantiveTranscriptScores(row)) {
      logPerceptionFallback('tavus_perception_empty_fallback_skipped', { ...baseLog, reason: 'missing_substantive_transcript_scores' });
      return { stored: false };
    }

    const existingScores = plainObject(row.perception_scores);
    if (hasExistingPerceptionScores(existingScores) && existingScores.source !== 'transcript_fallback') {
      logPerceptionFallback('tavus_perception_empty_fallback_skipped', { ...baseLog, reason: 'existing_perception_scores' });
      return { stored: false };
    }

    const fallbackScores = buildTranscriptPerceptionFallback(row);
    if (!fallbackScores) {
      logPerceptionFallback('tavus_perception_empty_fallback_skipped', { ...baseLog, reason: 'unable_to_derive_scores' });
      return { stored: false };
    }

    const { error: updateErr } = await supabaseAdmin
      .from('interviews')
      .update({ perception_scores: { ...existingScores, ...fallbackScores } })
      .eq('id', row.id);
    if (updateErr) {
      logPerceptionFallback('tavus_perception_empty_fallback_skipped', { ...baseLog, reason: updateErr.message || 'update_failed' });
      return { stored: false };
    }

    logPerceptionFallback('tavus_perception_empty_fallback_stored', baseLog);
    return { stored: true, perception_scores: fallbackScores };
  } catch (err) {
    logPerceptionFallback('tavus_perception_empty_fallback_skipped', { ...baseLog, reason: err?.message || String(err || 'unknown_error') });
    return { stored: false };
  }
}

function logInterviewAnalysisV2(level, event, details) {
  const payload = details?.source === 'final_transcript_reconciliation' ? {
    source: 'final_transcript_reconciliation',
    reason: details?.reason || null,
  } : {
    request_id: details?.request_id || null,
    interview_id: details?.interview_id || null,
    conversation_id: details?.conversation_id || null,
    candidate_id: details?.candidate_id || null,
    role_id: details?.role_id || null,
    reason: details?.reason || null
  };
  const message = `[interview-analysis-v2] ${event}`;
  if (level === 'error') console.error(message, payload);
  else if (level === 'warn') console.warn(message, payload);
  else console.log(message, payload);
}

async function getRoleContextForInterviewAnalysisV2(
  roleId,
  requestId,
  interviewId,
  candidateId,
  conversationId,
  boundedTelemetry = false,
) {
  if (!roleId) return null;
  const { data, error } = await supabaseAdmin
    .from('roles')
    .select('id,title,description,interview_type,job_description_text,job_description_url,rubric,rubric_questions,manual_questions')
    .eq('id', roleId)
    .maybeSingle();
  if (error) {
    logInterviewAnalysisV2('warn', 'skip', boundedTelemetry ? {
      source: 'final_transcript_reconciliation',
      reason: 'role_context_lookup_failed',
    } : {
      request_id: requestId || null,
      interview_id: interviewId || null,
      conversation_id: conversationId || null,
      candidate_id: candidateId || null,
      role_id: roleId || null,
      reason: 'role_context_lookup_failed'
    });
    return null;
  }
  return data || null;
}

function hasInterviewAnalysisV2PerceptionInput(row) {
  const hasText = typeof row?.perception_analysis_text === 'string' && row.perception_analysis_text.trim().length > 0;
  const scores = row?.perception_scores;
  const hasScores = scores && typeof scores === 'object' && !Array.isArray(scores) && Object.keys(scores).length > 0;
  return hasText || hasScores;
}

function interviewAnalysisV2IndicatesMissingPerception(analysis) {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return false;
  const parts = [];
  const collect = (value) => {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
  };
  collect(analysis.limitations);
  collect(analysis.evidence);
  collect(analysis.evidence_summary);
  const text = parts.join(' ').toLowerCase();
  return (
    /no (?:supporting )?(?:tavus )?perception (?:data|context|analysis)/.test(text) ||
    /perception (?:data|context|analysis) (?:was |is )?(?:not provided|not available|unavailable|missing)/.test(text) ||
    /without (?:supporting )?(?:tavus )?perception/.test(text)
  );
}

function hasExactObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index]);
}

function isValidInterviewAnalysisV2Payload(analysis) {
  if (!hasExactObjectKeys(analysis, [
    'version',
    'scores',
    'conditions',
    'risk',
    'evidence_summary',
    'evidence',
    'limitations',
  ])) return false;
  if (analysis.version !== 'path_a_v1' ||
      Buffer.byteLength(JSON.stringify(analysis), 'utf8') > 32_768) return false;

  if (!hasExactObjectKeys(analysis.scores, [
    'response_specificity',
    'answer_directness',
    'answer_consistency',
    'communication_structure',
  ])) return false;
  const scores = Object.values(analysis.scores);
  if (scores.some((score) => score !== null &&
      (!Number.isFinite(score) || score < 0 || score > 100))) return false;

  if (!hasExactObjectKeys(analysis.conditions, [
    'evaluation_conditions',
    'audio_quality_issues',
    'distraction_risk',
    'signal_confidence',
  ])) return false;
  if (!new Set(['good', 'mixed', 'limited', 'unavailable'])
    .has(analysis.conditions.evaluation_conditions) ||
      !new Set(['none', 'low', 'medium', 'high', 'unavailable'])
        .has(analysis.conditions.audio_quality_issues) ||
      !new Set(['low', 'medium', 'high', 'unavailable'])
        .has(analysis.conditions.distraction_risk) ||
      !new Set(['low', 'medium', 'high', 'unavailable'])
        .has(analysis.conditions.signal_confidence)) return false;

  if (!hasExactObjectKeys(analysis.risk, ['integrity_risk', 'reason']) ||
      !new Set(['low', 'medium', 'high', 'unavailable'])
        .has(analysis.risk.integrity_risk) ||
      typeof analysis.risk.reason !== 'string' ||
      analysis.risk.reason.length > 700 ||
      typeof analysis.evidence_summary !== 'string' ||
      analysis.evidence_summary.length > 1_200 ||
      !Array.isArray(analysis.evidence) ||
      analysis.evidence.length > 12 ||
      !Array.isArray(analysis.limitations) ||
      analysis.limitations.length > 8) return false;

  if (analysis.evidence.some((item) =>
    typeof item !== 'string' || item.length < 1 || item.length > 260) ||
      analysis.limitations.some((item) =>
        typeof item !== 'string' || item.length < 1 || item.length > 260)) return false;

  return !scores.some(Number.isFinite) ||
    (analysis.evidence_summary.trim().length > 0 && analysis.evidence.length > 0);
}

async function releaseInterviewAnalysisV2Claim({
  interviewId,
  analysisClaimToken,
  analysisClaimVersion,
  failureCategory,
}) {
  if (!analysisClaimToken || !Number.isInteger(Number(analysisClaimVersion))) return true;
  try {
    const { error } = await supabaseAdmin.rpc('release_interview_analysis_v2_claim', {
      p_interview_id: interviewId,
      p_analysis_claim_token: analysisClaimToken,
      p_analysis_claim_version: Number(analysisClaimVersion),
      p_failure_category: failureCategory,
    });
    return !error;
  } catch {
    // The bounded analysis lease is the fallback. Never log ownership,
    // transcript identity, database diagnostics, or generated analysis.
    return false;
  }
}

async function maybeGenerateInterviewAnalysisV2({
  interview,
  requestId,
  conversationId,
  refreshOnMissingPerception = false,
  boundedTelemetry = false,
  authoritativeTranscriptClaimVersion = null,
  authoritativeTranscriptHash = null,
}) {
  const baseLog = boundedTelemetry ? {
    source: 'final_transcript_reconciliation',
  } : {
    request_id: requestId || null,
    interview_id: interview?.id || null,
    conversation_id: conversationId || null,
    candidate_id: interview?.candidate_id || null,
    role_id: interview?.role_id || null
  };

  if (!ENABLE_INTERVIEW_ANALYSIS_V2) {
    logInterviewAnalysisV2('info', 'skip', { ...baseLog, reason: 'disabled' });
    return;
  }
  if (!supabaseAdmin || !interview?.id) {
    logInterviewAnalysisV2('warn', 'skip', { ...baseLog, reason: 'missing_db_or_interview_id' });
    return;
  }

  let analysisOwnership = null;
  if (boundedTelemetry) {
    if (!Number.isInteger(authoritativeTranscriptClaimVersion) ||
        authoritativeTranscriptClaimVersion < 0 ||
        typeof authoritativeTranscriptHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(authoritativeTranscriptHash)) {
      logInterviewAnalysisV2('error', 'failure', {
        ...baseLog,
        reason: 'analysis_claim_failed',
      });
      captureSanitizedFinalTranscriptFailure('analysis_claim_failed', {
        stage: 'downstream_analysis',
        retryable: false,
        httpClass: '2xx',
      });
      return;
    }

    try {
      const { data, error } = await supabaseAdmin.rpc(
        'claim_interview_analysis_v2_if_authoritative',
        {
          p_interview_id: interview.id,
          p_expected_transcript_claim_version: authoritativeTranscriptClaimVersion,
          p_expected_transcript_hash: authoritativeTranscriptHash,
          p_lease_seconds: 300,
        },
      );
      if (error) throw new Error('analysis_claim_failed');
      const claim = firstRpcRow(data);
      if (!claim?.outcome) throw new Error('analysis_claim_failed');
      if (['claimed', 'recovered_expired_claim'].includes(claim.outcome)) {
        if (!claim.analysis_claim_token ||
            !Number.isInteger(Number(claim.analysis_claim_version))) {
          throw new Error('analysis_claim_failed');
        }
        analysisOwnership = {
          token: claim.analysis_claim_token,
          version: Number(claim.analysis_claim_version),
        };
      } else if ([
        'already_current',
        'busy',
        'superseded',
        'analysis_present_unversioned',
        'interview_not_found',
        'invalid_request',
      ].includes(claim.outcome)) {
        logInterviewAnalysisV2('info', 'skip', {
          ...baseLog,
          reason: claim.outcome,
        });
        return;
      } else {
        throw new Error('analysis_claim_failed');
      }
    } catch {
      logInterviewAnalysisV2('error', 'failure', {
        ...baseLog,
        reason: 'analysis_claim_failed',
      });
      captureSanitizedFinalTranscriptFailure('analysis_claim_failed', {
        stage: 'downstream_analysis',
        retryable: false,
        httpClass: '2xx',
      });
      return;
    }
  }

  let boundedFailureCategory = 'analysis_generation_failed';
  try {
    const { data: row, error } = await supabaseAdmin
      .from('interviews')
      .select('id,candidate_id,role_id,status,failure_code,conversation_progress_state,has_substantive_response,substantive_response_count,candidate_utterance_count,transcript,transcript_scores,perception_scores,perception_analysis_text,unanswered_candidate_questions,interview_summary,interview_analysis_v2')
      .eq('id', interview.id)
      .maybeSingle();
    if (error || !row) {
      if (boundedTelemetry) throw new Error('analysis_input_lookup_failed');
      logInterviewAnalysisV2('warn', 'skip', {
        ...baseLog,
        reason: error?.message || 'interview_not_found',
      });
      return;
    }

    const logBase = boundedTelemetry ? baseLog : {
      request_id: requestId || null,
      interview_id: row.id,
      conversation_id: conversationId || null,
      candidate_id: row.candidate_id || null,
      role_id: row.role_id || null
    };
    let startReason = refreshOnMissingPerception ? 'perception_analysis_stored' : 'eligible';
    if (boundedTelemetry) {
      const selectedTranscriptHash = crypto
        .createHash('sha256')
        .update(String(row.transcript || ''))
        .digest('hex');
      if (selectedTranscriptHash !== authoritativeTranscriptHash) {
        await releaseInterviewAnalysisV2Claim({
          interviewId: interview.id,
          analysisClaimToken: analysisOwnership.token,
          analysisClaimVersion: analysisOwnership.version,
          failureCategory: 'analysis_superseded',
        });
        logInterviewAnalysisV2('info', 'skip', {
          ...logBase,
          reason: 'superseded',
        });
        return;
      }
    } else if (row.interview_analysis_v2 && typeof row.interview_analysis_v2 === 'object') {
      if (refreshOnMissingPerception) {
        if (!hasInterviewAnalysisV2PerceptionInput(row)) {
          logInterviewAnalysisV2('info', 'skip', { ...logBase, reason: 'missing_perception_context' });
          return;
        }
        if (interviewAnalysisV2IndicatesMissingPerception(row.interview_analysis_v2)) {
          startReason = 'refresh_missing_perception_context';
        } else {
          logInterviewAnalysisV2('info', 'skip', { ...logBase, reason: 'already_includes_perception_context' });
          return;
        }
      } else {
        logInterviewAnalysisV2('info', 'skip', { ...logBase, reason: 'already_exists' });
        return;
      }
    } else if (refreshOnMissingPerception && !hasInterviewAnalysisV2PerceptionInput(row)) {
      logInterviewAnalysisV2('info', 'skip', { ...logBase, reason: 'missing_perception_context' });
      return;
    }

    const eligibility = analysisV2Eligibility(row);
    if (!eligibility.eligible) {
      if (boundedTelemetry && analysisOwnership) {
        const released = await releaseInterviewAnalysisV2Claim({
          interviewId: interview.id,
          analysisClaimToken: analysisOwnership.token,
          analysisClaimVersion: analysisOwnership.version,
          failureCategory: 'analysis_superseded',
        });
        if (!released) {
          logInterviewAnalysisV2('error', 'failure', {
            ...logBase,
            reason: 'analysis_claim_release_failed',
          });
          captureSanitizedFinalTranscriptFailure('analysis_claim_release_failed', {
            stage: 'downstream_analysis',
            retryable: true,
            httpClass: '2xx',
          });
          return { skipped: false, reason: 'analysis_claim_release_failed' };
        }
      }
      logInterviewAnalysisV2('info', 'skip', { ...logBase, reason: eligibility.reason });
      return { skipped: true, reason: eligibility.reason };
    }
    if (!row.transcript_scores || typeof row.transcript_scores !== 'object' || Array.isArray(row.transcript_scores) || !Object.keys(row.transcript_scores).length) {
      if (boundedTelemetry) throw new Error('analysis_input_missing');
      logInterviewAnalysisV2('info', 'skip', { ...logBase, reason: 'missing_transcript_scores' });
      return;
    }

    logInterviewAnalysisV2('info', 'start', { ...logBase, reason: startReason });
    const roleContext = await getRoleContextForInterviewAnalysisV2(
      row.role_id,
      requestId,
      row.id,
      row.candidate_id,
      conversationId,
      boundedTelemetry,
    );
    const analysis = await generateInterviewAnalysisV2({
      transcript: row.transcript,
      transcript_scores: row.transcript_scores,
      perception_scores: row.perception_scores,
      perception_analysis_text: row.perception_analysis_text,
      unanswered_candidate_questions: row.unanswered_candidate_questions,
      interview_summary: row.interview_summary,
      role_context: roleContext,
      request_id: requestId || null,
      conversation_id: conversationId || null
    });

    if (boundedTelemetry) {
      if (!isValidInterviewAnalysisV2Payload(analysis)) {
        throw new Error('analysis_output_invalid');
      }
      boundedFailureCategory = 'analysis_finalize_failed';
      const { data, error: finalizeError } = await supabaseAdmin.rpc(
        'finalize_interview_analysis_v2_if_authoritative',
        {
          p_interview_id: interview.id,
          p_analysis_claim_token: analysisOwnership.token,
          p_analysis_claim_version: analysisOwnership.version,
          p_expected_transcript_claim_version: authoritativeTranscriptClaimVersion,
          p_expected_transcript_hash: authoritativeTranscriptHash,
          p_analysis: analysis,
        },
      );
      if (finalizeError) throw new Error('analysis_finalize_failed');
      const finalized = firstRpcRow(data);
      if (!finalized?.outcome) throw new Error('analysis_finalize_failed');
      if (['stored', 'already_current'].includes(finalized.outcome)) {
        logInterviewAnalysisV2('info', 'success', {
          ...logBase,
          reason: finalized.outcome,
        });
        return;
      }
      if (['superseded', 'stale_claim', 'interview_not_found'].includes(finalized.outcome)) {
        logInterviewAnalysisV2('info', 'skip', {
          ...logBase,
          reason: finalized.outcome,
        });
        return;
      }
      throw new Error('analysis_finalize_failed');
    } else {
      const { error: updateError } = await supabaseAdmin
        .from('interviews')
        .update({ interview_analysis_v2: analysis })
        .eq('id', row.id);
      if (updateError) throw updateError;
      logInterviewAnalysisV2('info', 'success', {
        ...logBase,
        reason: refreshOnMissingPerception ? 'refreshed_with_perception' : 'stored',
      });
    }
  } catch (err) {
    logInterviewAnalysisV2('error', 'failure', boundedTelemetry ? {
      source: 'final_transcript_reconciliation',
      reason: boundedFailureCategory,
    } : {
      ...baseLog,
      reason: err?.message || String(err || 'unknown_error')
    });
    if (boundedTelemetry) {
      await releaseInterviewAnalysisV2Claim({
        interviewId: interview.id,
        analysisClaimToken: analysisOwnership?.token,
        analysisClaimVersion: analysisOwnership?.version,
        failureCategory: boundedFailureCategory,
      });
      captureSanitizedFinalTranscriptFailure(boundedFailureCategory, {
        stage: 'downstream_analysis',
        retryable: false,
        httpClass: '2xx',
      });
    } else {
      Sentry.captureException(err, {
        tags: {
          route_name: 'tavus_webhook',
          surface: 'backend',
          task: 'interview_analysis_v2',
          interview_id: interview?.id || undefined
        },
        extra: {
          request_id: requestId || null,
          interview_id: interview?.id || null,
          candidate_id: interview?.candidate_id || null,
          role_id: interview?.role_id || null,
          conversation_id: conversationId || null
        }
      });
    }
  }
}

function queueInterviewAnalysisV2(input) {
  if (input?.substantiveEvidence === false) {
    logInterviewAnalysisV2('info', 'skip', input?.boundedTelemetry ? {
      source: 'final_transcript_reconciliation',
      reason: input?.skipReason || 'no_substantive_responses',
    } : {
      request_id: input?.requestId || null,
      interview_id: input?.interview?.id || null,
      conversation_id: input?.conversationId || null,
      candidate_id: input?.interview?.candidate_id || null,
      role_id: input?.interview?.role_id || null,
      reason: input?.skipReason || 'no_substantive_responses',
    });
    return false;
  }
  setImmediate(() => {
    maybeGenerateInterviewAnalysisV2(input).catch((err) => {
      logInterviewAnalysisV2('error', 'failure', input?.boundedTelemetry ? {
        source: 'final_transcript_reconciliation',
        reason: 'post_processing_failed',
      } : {
        request_id: input?.requestId || null,
        interview_id: input?.interview?.id || null,
        conversation_id: input?.conversationId || null,
        candidate_id: input?.interview?.candidate_id || null,
        role_id: input?.interview?.role_id || null,
        reason: err?.message || String(err || 'unknown_error')
      });
    });
  });
  return true;
}

function extractAnswerScoresFromAnalysis(analysis) {
  let obj = analysis;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const src = obj.transcript_scores && typeof obj.transcript_scores === 'object'
    ? obj.transcript_scores
    : obj.scores && typeof obj.scores === 'object'
      ? obj.scores
      : null;
  if (!src) return {};
  const out = {};
  if (Number.isFinite(src.overall)) out.overall = src.overall;
  if (Number.isFinite(src.role_fit ?? src.roleFit)) out.role_fit = Number.isFinite(src.role_fit) ? src.role_fit : src.roleFit;
  if (Number.isFinite(src.technical_strength ?? src.technicalStrength)) {
    out.technical_strength = Number.isFinite(src.technical_strength) ? src.technical_strength : src.technicalStrength;
  }
  if (Number.isFinite(src.communication_quality ?? src.communicationQuality)) {
    out.communication_quality = Number.isFinite(src.communication_quality) ? src.communication_quality : src.communicationQuality;
  }
  return out;
}

function getRequestId(req, body) {
  const existing = pickFirst(
    req?.request_id,
    req?.headers?.['x-request-id'],
    req?.headers?.['x-requestid'],
    req?.headers?.['x-correlation-id'],
    fromAny(body, 'request_id'),
    fromAny(body, 'requestId'),
    fromAny(body, 'metadata.request_id'),
    fromAny(body, 'metadata.requestId'),
    fromAny(body, 'properties.request_id'),
    fromAny(body, 'payload.request_id')
  );
  if (existing !== undefined && existing !== null && String(existing).trim()) return String(existing).trim();
  return `tavus_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function shouldTriggerAnalysis(interviewId, requestId) {
  if (!interviewId) return false;
  const now = Date.now();
  const last = analysisTriggerGuard.get(interviewId);
  if (last && now - last < ANALYSIS_TRIGGER_TTL_MS) {
    console.log('[analysis-trigger] dedupe', {
      request_id: requestId || null,
      interview_id: interviewId
    });
    return false;
  }
  analysisTriggerGuard.set(interviewId, now);
  if (analysisTriggerGuard.size > 1000) {
    for (const [id, ts] of analysisTriggerGuard.entries()) {
      if (now - ts > ANALYSIS_TRIGGER_TTL_MS) analysisTriggerGuard.delete(id);
    }
  }
  return true;
}

async function getRoleScoringContext(roleId, requestId, interviewId, conversationId, options = {}) {
  if (!roleId) return null;
  const cacheKey = String(roleId);
  if (roleScoringContextCache.has(cacheKey)) return roleScoringContextCache.get(cacheKey);

  const { data, error } = await supabaseAdmin
    .from('roles')
    .select('id,title,description,interview_type,job_description_text,job_description_url,rubric,rubric_questions,manual_questions')
    .eq('id', roleId)
    .maybeSingle();

  if (error) {
    console.error('[webhook] role jd lookup failed', options.sanitized ? {
      outcome: 'role_context_unavailable',
    } : {
      request_id: requestId || null,
      interview_id: interviewId || null,
      conversation_id: conversationId || null,
      role_id: roleId || null,
      error: error.message || error,
      details: error.details || null,
      hint: error.hint || null
    });
    roleScoringContextCache.set(cacheKey, null);
    return null;
  }

  const context = data || null;
  roleScoringContextCache.set(cacheKey, context);
  return context;
}

function getJdTextFromRoleContext(roleContext) {
  return typeof roleContext?.job_description_text === 'string' && roleContext.job_description_text.trim()
    ? roleContext.job_description_text.trim()
    : (typeof roleContext?.job_description_url === 'string' ? roleContext.job_description_url.trim() : '');
}

async function applyTranscriptScoringForInterview({ interview, fresh, transcriptText, requestId, conversationId }) {
  const transcript = excludeWarmupFromTranscript(transcriptText);
  const substantiveCheck = isSubstantiveTranscript(transcript);
  const transcriptWordCount = transcript ? transcript.split(/\s+/).filter(Boolean).length : 0;
  const candidateResponseTurns = (transcript.match(/^(CANDIDATE|USER)\s*:/gim) || []).length;
  const disconnectedLevel = !substantiveCheck.ok && (
    substantiveCheck.reason === 'empty_transcript' ||
    transcriptWordCount <= 10 ||
    (candidateResponseTurns === 0 && transcriptWordCount <= 30)
  );
  const disconnectedSummary = 'Interview ended before substantive responses were captured.';
  const disconnectedRiskReason = 'No substantive interview response was available to assess.';
  const existingTopScores =
    fresh?.transcript_scores && typeof fresh.transcript_scores === 'object'
      ? fresh.transcript_scores
      : {};
  const existingSummary = typeof fresh?.interview_summary === 'string' ? fresh.interview_summary.trim() : '';
  const existingOverall = existingTopScores.overall;
  const existingConfidence = existingTopScores.confidence;
  const hasInsufficientSummary = existingSummary === INSUFFICIENT_SUMMARY ||
    existingSummary.includes('Interview ended before any substantive responses were recorded.');

  // Phase B is a hard evidence gate.  A transcript may be retained for audit,
  // but it may never be scored or promoted unless the deterministic candidate
  // utterance classifier found a substantive answer.
  if (!substantiveCheck.ok) {
    const transition = transcriptCompletionTransition(substantiveCheck);
    const { error: gateError } = await supabaseAdmin
      .from('interviews')
      .update({
        status: transition.status,
        failure_code: transition.failure_code,
        failure_stage: transition.failure_stage,
        failure_summary: transition.failure_summary,
        failure_at: new Date().toISOString(),
        retryable: transition.retryable,
        replacement_eligible: transition.replacement_eligible,
        has_substantive_response: false,
        substantive_response_count: substantiveCheck.substantiveResponseCount || 0,
        candidate_utterance_count: substantiveCheck.candidateUtteranceCount || 0,
        utterance_classification_counts: substantiveCheck.counts || {},
        conversation_progress_state: 'NoSubstantiveCandidateResponse',
        interview_summary: 'Interview ended before a substantive candidate response was recorded.',
        transcript_scores: {
          ...existingTopScores,
          overall: null,
          role_fit: null,
          technical_strength: null,
          communication_quality: null,
          confidence: 0,
          ai_aided_risk: 'low',
          ai_aided_risk_reason: disconnectedRiskReason,
        },
      })
      .eq('id', interview.id);
    if (gateError) {
      console.error('[webhook] transcript evidence gate update failed', { request_id: requestId || null, interview_id: interview?.id || null, error: gateError.message || gateError });
      return { updated: false, substantive: false, reason: substantiveCheck.reason };
    }
    return { updated: true, substantive: false, reason: substantiveCheck.reason, evidence: substantiveCheck };
  }

  if (substantiveCheck.ok && Number.isFinite(existingOverall) && Number.isFinite(existingConfidence) && existingSummary) {
    return { updated: false, substantive: true, reason: 'already_scored' };
  }

  const roleId = fresh?.role_id || interview?.role_id || null;
  const roleContext = await getRoleScoringContext(roleId, requestId, interview?.id, conversationId);
  const jdText = getJdTextFromRoleContext(roleContext);
  const perceptionScores =
    fresh?.perception_scores && typeof fresh.perception_scores === 'object'
      ? fresh.perception_scores
      : (
        interview?.perception_scores && typeof interview.perception_scores === 'object'
          ? interview.perception_scores
          : {}
      );

  const scored = await scoreInterview({
      transcriptText: transcript,
      jdText,
      roleContext,
      perceptionScores,
      mode: 'webhook',
      request_id: requestId || null
    });

  const updateFields = {
    transcript_scores: {
      ...existingTopScores,
      ...(scored?.transcript_scores || {})
    }
  };
  if (substantiveCheck.ok) {
    if (!existingSummary || existingSummary === INSUFFICIENT_SUMMARY) {
      updateFields.interview_summary = scored.summary;
    }
  }

  const { error: scoreErr } = await supabaseAdmin
    .from('interviews')
    .update(updateFields)
    .eq('id', interview.id);
  if (scoreErr) {
    console.error('[webhook] transcript_scores update failed', {
      request_id: requestId || null,
      interview_id: interview.id,
      conversation_id: conversationId || null,
      error: scoreErr.message || scoreErr,
      details: scoreErr.details || null,
      hint: scoreErr.hint || null
    });
    return { updated: false, substantive: substantiveCheck.ok, reason: 'update_failed' };
  }

  const roleIdForAvailability = fresh?.role_id || interview?.role_id || null;
  const clientIdForAvailability = fresh?.client_id || interview?.client_id || null;
  if (roleIdForAvailability && clientIdForAvailability) {
    try {
      const availability = await getRoleInterviewAvailability({
        db: supabaseAdmin,
        roleId: roleIdForAvailability,
        clientId: clientIdForAvailability
      });
      await syncRoleInterviewLimitNotification({
        db: supabaseAdmin,
        roleId: roleIdForAvailability,
        clientId: clientIdForAvailability,
        remainingInterviews: availability.remaining_interviews,
        roleTitle: ''
      });
    } catch (syncErr) {
      console.error('[webhook] role limit sync failed', {
        request_id: requestId || null,
        interview_id: interview?.id || null,
        conversation_id: conversationId || null,
        role_id: roleIdForAvailability,
        client_id: clientIdForAvailability,
        error: syncErr?.message || syncErr
      });
    }
  }

  return { updated: true, substantive: substantiveCheck.ok, reason: substantiveCheck.reason };
}

function isEmptyQuestionList(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return !value.trim();
  return false;
}

const MAX_UNANSWERED_QUESTION_COUNT = 10;
const MAX_UNANSWERED_QUESTION_LENGTH = 1000;
const MAX_UNANSWERED_QUESTIONS_JSON_BYTES = 10000;

function isValidUnansweredQuestionPayload(value) {
  if (!Array.isArray(value) ||
      value.length < 1 ||
      value.length > MAX_UNANSWERED_QUESTION_COUNT) {
    return false;
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') >
      MAX_UNANSWERED_QUESTIONS_JSON_BYTES) {
    return false;
  }
  const seen = new Set();
  for (const question of value) {
    if (typeof question !== 'string' ||
        question !== question.trim() ||
        [...question].length < 1 ||
        [...question].length > MAX_UNANSWERED_QUESTION_LENGTH ||
        seen.has(question)) {
      return false;
    }
    seen.add(question);
  }
  return true;
}

async function applyInterviewUpdates(interviewId, updates, recordingMeta, options = {}) {
  const baseUpdates = updates && Object.keys(updates).length ? updates : null;
  const cleanedMeta = pruneMetadata(recordingMeta);
  const hasMeta = Object.keys(cleanedMeta).length > 0;
  const skipRecordingUpdates = options.preserveRecordingState === true || options.suppressRecordingReadyState === true;

  if (!hasMeta || skipRecordingUpdates) {
    if (!baseUpdates) return;
    const { error } = await supabaseAdmin.from('interviews').update(baseUpdates).eq('id', interviewId);
    if (error) throw error;
    return;
  }

  const recordingUpdates = {
    recording_metadata: cleanedMeta,
    recording_status: 'ready',
    recording_ready_at: new Date().toISOString()
  };
  const combined = { ...(baseUpdates || {}), ...recordingUpdates };
  let { error } = await supabaseAdmin.from('interviews').update(combined).eq('id', interviewId);
  if (!error) return;

  if (!isMissingColumnError(error)) throw error;

  if (baseUpdates) {
    const { error: baseErr } = await supabaseAdmin.from('interviews').update(baseUpdates).eq('id', interviewId);
    if (baseErr) throw baseErr;
  }

  ({ error } = await supabaseAdmin
    .from('interviews')
    .update({ recording_metadata: cleanedMeta })
    .eq('id', interviewId));
  if (!error) return;
  if (!isMissingColumnError(error)) throw error;

  const pathName = `interviews/${interviewId}-recording-metadata.json`;
  const stored = await putJsonToStorage(TRANSCRIPTS_BUCKET, pathName, cleanedMeta);

  const { error: urlErr } = await supabaseAdmin
    .from('interviews')
    .update({ recording_metadata_url: stored })
    .eq('id', interviewId);
  if (urlErr && !isMissingColumnError(urlErr)) throw urlErr;
}

async function updatePerceptionAnalysis(interview, analysisText, requestId, extraScoreSources = []) {
  let rawText;
  if (analysisText && typeof analysisText === 'object') {
    try {
      rawText = JSON.stringify(analysisText);
    } catch {
      rawText = String(analysisText);
    }
  } else {
    rawText = String(analysisText || '');
  }
  rawText = String(rawText || '').trim();
  const sanitizedText = rawText ? sanitizePerceptionText(rawText) : '';
  const conversationId = interview?.tavus_application_id || interview?.conversation_id || null;

  let perceptionScores = {};
  let parsedDirect = null;
  if (analysisText && typeof analysisText === 'object') {
    parsedDirect = analysisText;
  } else if (looksLikeJson(rawText)) {
    try {
      parsedDirect = JSON.parse(rawText);
    } catch (err) {
      console.error('[webhook] perception_analysis JSON parse failed', {
        request_id: requestId || null,
        interview_id: interview.id,
        conversation_id: conversationId,
        error: err?.message || err,
        details: err?.details || null,
        hint: err?.hint || null
      });
    }
  }

  if (parsedDirect) {
    perceptionScores = extractPerceptionScores(parsedDirect);
  }

  if (!Object.keys(perceptionScores).length) {
    const blockJson = extractJsonFromText(rawText);
    if (blockJson) {
      perceptionScores = extractPerceptionScores(blockJson);
    }
  }

  if (!Object.keys(perceptionScores).length) {
    perceptionScores = extractPerceptionScoresFromText(rawText);
  }

  if (!Object.keys(perceptionScores).length) {
    for (const source of extraScoreSources || []) {
      perceptionScores = extractPerceptionScores(source);
      if (Object.keys(perceptionScores).length) break;
    }
  }

  const updates = {};
  if (sanitizedText) updates.perception_analysis_text = sanitizedText;
  if (Object.keys(perceptionScores).length) {
    const existingScores = plainObject(interview.perception_scores);
    updates.perception_scores = {
      ...existingScores,
      ...perceptionScores,
      source: 'tavus_perception_analysis',
      fallback: false,
      fallback_reason: null,
      modality: null,
      visual_signal_available: null
    };
  }
  if (!Object.keys(updates).length) return { stored: false, perception_scores: {} };

  const { error } = await supabaseAdmin
    .from('interviews')
    .update(updates)
    .eq('id', interview.id);
  if (error) {
    console.error('[webhook] perception_analysis update failed', {
      request_id: requestId || null,
      interview_id: interview.id,
      conversation_id: conversationId,
      error: error.message || error,
      details: error.details || null,
      hint: error.hint || null
    });
    return { stored: false, perception_scores: perceptionScores };
  }

  return { stored: true, perception_scores: perceptionScores };
}

async function getInterviewByIds(interviewId, conversationId) {
  if (conversationId) {
    let { data, error } = await supabaseAdmin
      .from('interviews')
      .select('*')
      .eq('tavus_application_id', conversationId)
      .maybeSingle();
    if (error) {
      return {
        interview: null,
        bindingError: { code: 'binding_lookup_failed', retryable: true },
      };
    }
    if (data) {
      if (interviewId && String(data.id || '') !== String(interviewId || '')) {
        return {
          interview: null,
          bindingError: {
            code: 'interview_conversation_mismatch',
            resolved_interview_id: data.id || null
          }
        };
      }
      return { interview: data, bindingError: null };
    }

    ({ data, error } = await supabaseAdmin
      .from('interviews')
      .select('*')
      .eq('conversation_id', conversationId)
      .maybeSingle());
    if (error) {
      return {
        interview: null,
        bindingError: { code: 'binding_lookup_failed', retryable: true },
      };
    }
    if (data) {
      if (interviewId && String(data.id || '') !== String(interviewId || '')) {
        return {
          interview: null,
          bindingError: {
            code: 'interview_conversation_mismatch',
            resolved_interview_id: data.id || null
          }
        };
      }
      return { interview: data, bindingError: null };
    }

    return { interview: null, bindingError: null };
  }

  if (interviewId) {
    return {
      interview: null,
      bindingError: { code: 'missing_conversation_id_interview_id_only' }
    };
  }

  return { interview: null, bindingError: null };
}

async function ensureBucket(name) {
  const { data: list } = await supabaseAdmin.storage.listBuckets();
  if (!list?.find(b => b.name === name)) {
    try {
      await supabaseAdmin.storage.createBucket(name, { public: false });
    } catch {}
  }
}

async function putJsonToStorage(bucket, pathName, jsonOrUrl) {
  await ensureBucket(bucket);

  let buf;
  let contentType = 'application/json';

  if (typeof jsonOrUrl === 'string' && /^https?:\/\//i.test(jsonOrUrl)) {
    const r = await fetch(jsonOrUrl, {
      signal: AbortSignal.timeout(TIMEOUT_PROFILES.read.requestMs),
    });
    if (!r.ok) throw new Error(`fetch ${jsonOrUrl} failed: ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    contentType = ct || contentType;
    const ab = await r.arrayBuffer();
    buf = Buffer.from(ab);
  } else if (typeof jsonOrUrl === 'string') {
    buf = Buffer.from(jsonOrUrl, 'utf8');
  } else {
    buf = Buffer.from(JSON.stringify(jsonOrUrl ?? {}), 'utf8');
  }

  const { error } = await supabaseAdmin
    .storage
    .from(bucket)
    .upload(pathName, buf, { upsert: true, contentType });
  if (error) throw new Error(error.message);

  return `${bucket}/${pathName}`;
}

async function putContentAddressedTranscriptToStorage(bucket, pathName, transcriptText) {
  await ensureBucket(bucket);
  const { error } = await supabaseAdmin
    .storage
    .from(bucket)
    .upload(pathName, Buffer.from(transcriptText, 'utf8'), {
      // The path is the SHA-256 of these exact bytes. Repeating an upload for
      // the same path therefore cannot replace it with different content.
      upsert: true,
      contentType: 'text/plain; charset=utf-8',
    });
  if (error) throw new Error('final_transcript_storage_failed');
  return `${bucket}/${pathName}`;
}

function firstRpcRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data && typeof data === 'object' ? data : null;
}

function finalTranscriptEventKey(body, conversationId, transcriptHash) {
  const providerEventId = pickFirst(
    fromAny(body, 'event_id'),
    fromAny(body, 'id'),
    fromAny(body, 'payload.event_id'),
    fromAny(body, 'payload.id'),
  );
  return crypto.createHash('sha256')
    .update(String(providerEventId || `application.transcription_ready|${conversationId}|${transcriptHash}`))
    .digest('hex');
}

async function releaseFinalTranscriptClaim({ interviewId, claimToken, claimVersion, failureCategory }) {
  if (!claimToken || !Number.isInteger(Number(claimVersion))) return;
  try {
    await supabaseAdmin.rpc('release_interview_final_transcript_reconciliation', {
      p_interview_id: interviewId,
      p_claim_token: claimToken,
      p_claim_version: Number(claimVersion),
      p_failure_category: failureCategory,
    });
  } catch {
    // The bounded lease is the fallback recovery path. Do not log the token,
    // identity, provider payload, or raw failure.
  }
}

function finalTranscriptResponse(status, outcome, options = {}) {
  return {
    status,
    headers: options.headers || {},
    body: {
      ok: status >= 200 && status < 300,
      outcome,
      retryable: options.retryable === true,
    },
  };
}

const FINAL_TRANSCRIPT_FAILURE_CATEGORIES = new Set([
  'binding_lookup_failed',
  'claim_failed',
  'scoring_failed',
  'invalid_transcript_scores',
  'storage_failed',
  'finalize_failed',
  'post_processing_failed',
  'analysis_claim_failed',
  'analysis_claim_release_failed',
  'analysis_generation_failed',
  'analysis_finalize_failed',
  'unexpected_failure',
]);

const FINAL_TRANSCRIPT_FAILURE_STAGES = new Set([
  'binding',
  'claim',
  'scoring',
  'upload',
  'finalize',
  'downstream_analysis',
  'downstream_questions',
  'unexpected',
]);

const FINAL_TRANSCRIPT_HTTP_CLASSES = new Set(['2xx', '4xx', '5xx']);

function captureSanitizedFinalTranscriptFailure(category, details = {}) {
  const boundedCategory = FINAL_TRANSCRIPT_FAILURE_CATEGORIES.has(category)
    ? category
    : 'unexpected_failure';
  const boundedStage = FINAL_TRANSCRIPT_FAILURE_STAGES.has(details.stage)
    ? details.stage
    : 'unexpected';
  const boundedHttpClass = FINAL_TRANSCRIPT_HTTP_CLASSES.has(details.httpClass)
    ? details.httpClass
    : '5xx';
  const retryable = details.retryable === true;
  const boundedMessage = `final_transcript_reconciliation_failed:${boundedCategory}`;
  const boundedTags = {
    operation: 'final_transcript_reconciliation',
    failure_category: boundedCategory,
    stage: boundedStage,
    retryable: retryable ? 'true' : 'false',
    http_class: boundedHttpClass,
  };
  const projectEvent = (event) => ({
    event_id: event?.event_id,
    timestamp: event?.timestamp,
    platform: 'node',
    level: 'error',
    exception: {
      values: [{
        type: 'FinalTranscriptReconciliationFailure',
        value: boundedMessage,
        mechanism: {
          type: 'generic',
          handled: true,
        },
      }],
    },
    tags: boundedTags,
    fingerprint: [
      'final_transcript_reconciliation',
      boundedCategory,
    ],
  });

  let privacyClient = null;
  try {
    const sourceClient = typeof Sentry.getClient === 'function'
      ? Sentry.getClient()
      : null;
    if (!sourceClient ||
        typeof sourceClient.getOptions !== 'function' ||
        typeof Sentry.NodeClient !== 'function' ||
        typeof Sentry.Scope !== 'function' ||
        typeof Sentry.withIsolationScope !== 'function') {
      throw new Error('sentry_isolation_unavailable');
    }

    const sourceOptions = sourceClient.getOptions();
    privacyClient = new Sentry.NodeClient({
      ...sourceOptions,
      defaultIntegrations: [],
      integrations: [],
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      sendClientReports: false,
      beforeSend: projectEvent,
      beforeSendTransaction: undefined,
      beforeSendSpan: undefined,
      initialScope: undefined,
    });
    privacyClient.init();
    privacyClient.on('afterSendEvent', () => {
      Promise.resolve(privacyClient.close(2_000)).catch(() => {});
    });

    const isolatedRequestScope = new Sentry.Scope();
    const isolatedEventScope = new Sentry.Scope();
    isolatedEventScope.setClient(privacyClient);
    Sentry.withIsolationScope(isolatedRequestScope, () => {
      privacyClient.captureEvent(projectEvent({}), {}, isolatedEventScope);
    });
  } catch {
    if (privacyClient && typeof privacyClient.close === 'function') {
      Promise.resolve(privacyClient.close(2_000)).catch(() => {});
    }
    console.error('[webhook] final_transcript_sentry_capture_failed', {
      outcome: 'failed',
      operation: 'final_transcript_reconciliation',
      stage: 'telemetry',
    });
  }
}

function queueFinalTranscriptPostProcessing({
  interview,
  requestId,
  conversationId,
  transcriptItems,
  evidence,
  reconciliationOutcome,
  claimVersion,
  transcriptHash,
}) {
  if (reconciliationOutcome !== 'finalized') return;

  if (evidence?.ok) {
    queueInterviewAnalysisV2({
      interview,
      requestId,
      conversationId,
      boundedTelemetry: true,
      authoritativeTranscriptClaimVersion: claimVersion,
      authoritativeTranscriptHash: transcriptHash,
    });
  }

  let questions;
  try {
    questions = extractCandidateQuestions(excludeWarmupFromTranscriptItems(transcriptItems));
  } catch {
    console.error('[webhook] final_transcript_post_processing', {
      outcome: 'failed',
      retryable: false,
      stage: 'question_extract',
    });
    return;
  }
  if (!questions.length) return;
  if (!isValidUnansweredQuestionPayload(questions) ||
      !Number.isInteger(claimVersion) ||
      claimVersion < 0 ||
      typeof transcriptHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(transcriptHash)) {
    console.error('[webhook] final_transcript_post_processing', {
      outcome: 'invalid_questions',
      retryable: false,
      stage: 'question_validate',
    });
    return;
  }

  setImmediate(async () => {
    try {
      const { data, error } = await supabaseAdmin.rpc(
        'persist_interview_unanswered_questions_if_authoritative',
        {
          p_interview_id: interview.id,
          p_expected_claim_version: claimVersion,
          p_expected_transcript_hash: transcriptHash,
          p_questions: questions,
        },
      );
      if (error) {
        console.error('[webhook] final_transcript_post_processing', {
          outcome: 'failed',
          retryable: false,
          stage: 'question_persist',
        });
        return;
      }
      const persistence = firstRpcRow(data);
      const outcome = persistence?.outcome;
      if (outcome === 'stored') {
        console.log('[webhook] final_transcript_post_processing', {
          outcome: 'questions_captured',
          count: questions.length,
        });
        return;
      }
      if (outcome === 'already_present' || outcome === 'superseded') {
        console.log('[webhook] final_transcript_post_processing', {
          outcome,
          stage: 'question_persist',
        });
        return;
      }
      if (outcome === 'interview_not_found' || outcome === 'invalid_questions') {
        console.error('[webhook] final_transcript_post_processing', {
          outcome,
          retryable: false,
          stage: 'question_persist',
        });
        return;
      }
      throw new Error('question_persistence_result_invalid');
    } catch {
      console.error('[webhook] final_transcript_post_processing', {
        outcome: 'failed',
        retryable: false,
        stage: 'question_capture',
      });
    }
  });
}

async function reconcileFinalTranscript({ body, interview, requestId, conversationId }) {
  const rawTranscript = pickFirst(
    fromAny(body, 'properties.transcript'),
    fromAny(body, 'transcript'),
    fromAny(body, 'payload.transcript'),
  );
  const transcriptItems = Array.isArray(rawTranscript)
    ? rawTranscript
    : Array.isArray(rawTranscript?.messages)
      ? rawTranscript.messages
      : Array.isArray(fromAny(body, 'messages'))
        ? fromAny(body, 'messages')
        : null;
  if (!transcriptItems) {
    console.warn('[webhook] final_transcript_reconciliation', {
      outcome: 'invalid_snapshot',
      retryable: false,
      stage: 'normalize',
    });
    return finalTranscriptResponse(422, 'invalid_snapshot');
  }

  const transcriptText = sanitizeTranscriptArray(transcriptItems).join('\n\n').trim();
  const evidence = isSubstantiveTranscript(transcriptText);
  let evidenceSnapshot;
  try {
    evidenceSnapshot = buildEvidenceSnapshot(evidence);
  } catch {
    console.warn('[webhook] final_transcript_reconciliation', {
      outcome: 'invalid_snapshot',
      retryable: false,
      stage: 'classify',
    });
    return finalTranscriptResponse(422, 'invalid_snapshot');
  }

  const transcriptHash = crypto.createHash('sha256').update(transcriptText).digest('hex');
  const providerEventKey = finalTranscriptEventKey(body, conversationId, transcriptHash);
  let claim;
  try {
    const { data, error } = await supabaseAdmin.rpc(
      'claim_interview_final_transcript_reconciliation',
      {
        p_interview_id: interview.id,
        p_provider_conversation_id: String(conversationId),
        p_provider_event_key: providerEventKey,
        p_transcript_hash: transcriptHash,
        p_evidence_snapshot: evidenceSnapshot,
        p_lease_seconds: 120,
      },
    );
    if (error) throw error;
    claim = firstRpcRow(data);
    if (!claim?.outcome) throw new Error('final_transcript_claim_result_invalid');
  } catch {
    captureSanitizedFinalTranscriptFailure('claim_failed', {
      stage: 'claim',
      retryable: true,
      httpClass: '5xx',
    });
    console.error('[webhook] final_transcript_reconciliation', {
      outcome: 'failed',
      retryable: true,
      stage: 'claim',
    });
    return finalTranscriptResponse(503, 'claim_failed', { retryable: true });
  }

  if (claim.outcome === 'busy') {
    console.warn('[webhook] final_transcript_reconciliation', projectReconciliationLog({
      outcome: 'busy',
      claimVersion: Number(claim.claim_version),
      classificationCounts: evidenceSnapshot.classification_counts,
      retryable: true,
    }));
    return finalTranscriptResponse(503, 'busy', {
      retryable: true,
      headers: { 'Retry-After': '5' },
    });
  }
  if (claim.outcome === 'already_reconciled' ||
      claim.outcome === 'superseded_by_stronger_evidence') {
    console.log('[webhook] final_transcript_reconciliation', projectReconciliationLog({
      outcome: claim.outcome,
      claimVersion: Number(claim.claim_version),
      classificationCounts: evidenceSnapshot.classification_counts,
      retryable: false,
    }));
    return finalTranscriptResponse(200, claim.outcome);
  }
  if (claim.outcome === 'invalid_snapshot') {
    return finalTranscriptResponse(422, 'invalid_snapshot');
  }
  if (claim.outcome === 'binding_not_found') {
    return finalTranscriptResponse(409, 'binding_not_found');
  }
  if (!['claimed', 'recovered_expired_claim'].includes(claim.outcome) ||
      !claim.claim_token ||
      !Number.isInteger(Number(claim.claim_version)) ||
      claim.scoring_required !== true) {
    captureSanitizedFinalTranscriptFailure('claim_failed', {
      stage: 'claim',
      retryable: true,
      httpClass: '5xx',
    });
    console.error('[webhook] final_transcript_reconciliation', {
      outcome: 'failed',
      retryable: true,
      stage: 'claim_contract',
    });
    return finalTranscriptResponse(503, 'claim_failed', { retryable: true });
  }

  let transcriptScores = null;
  let interviewSummary = null;
  let scoringPerformed = false;
  try {
    scoringPerformed = true;
    if (evidence.ok) {
      const roleContext = await getRoleScoringContext(interview.role_id, null, null, null, { sanitized: true });
      const jdText = getJdTextFromRoleContext(roleContext);
      const scored = await scoreInterview({
        transcriptText,
        jdText,
        roleContext,
        perceptionScores: interview.perception_scores || {},
        mode: 'webhook',
        request_id: null,
      });
      transcriptScores = scored?.transcript_scores || null;
      interviewSummary = scored?.summary || null;
    } else {
      transcriptScores = {
        overall: null,
        role_fit: null,
        technical_strength: null,
        communication_quality: null,
        confidence: 0,
        ai_aided_risk: 'low',
        ai_aided_risk_reason: 'Insufficient transcript to assess.',
      };
      interviewSummary = 'Interview ended before a substantive candidate response was recorded.';
    }
    if (!transcriptScores || !interviewSummary) throw new Error('final_transcript_scoring_result_invalid');
  } catch {
    await releaseFinalTranscriptClaim({
      interviewId: interview.id,
      claimToken: claim.claim_token,
      claimVersion: Number(claim.claim_version),
      failureCategory: 'scoring_failed',
    });
    captureSanitizedFinalTranscriptFailure('scoring_failed', {
      stage: 'scoring',
      retryable: true,
      httpClass: '5xx',
    });
    console.error('[webhook] final_transcript_reconciliation', {
      outcome: 'failed',
      retryable: true,
      stage: 'scoring',
    });
    return finalTranscriptResponse(503, 'scoring_failed', { retryable: true });
  }

  const transcriptScoreValidation = validateTranscriptScores(transcriptScores);
  if (!transcriptScoreValidation.valid) {
    await releaseFinalTranscriptClaim({
      interviewId: interview.id,
      claimToken: claim.claim_token,
      claimVersion: Number(claim.claim_version),
      failureCategory: 'scoring_failed',
    });
    captureSanitizedFinalTranscriptFailure('invalid_transcript_scores', {
      stage: 'scoring',
      retryable: true,
      httpClass: '5xx',
    });
    console.error('[webhook] final_transcript_reconciliation', {
      outcome: 'failed',
      retryable: true,
      stage: 'score_contract',
    });
    return finalTranscriptResponse(503, 'invalid_transcript_scores', { retryable: true });
  }

  const pathName = `interviews/${interview.id}/final-transcripts/${transcriptHash}.txt`;
  let transcriptStorageRef;
  try {
    transcriptStorageRef = await putContentAddressedTranscriptToStorage(
      TRANSCRIPTS_BUCKET,
      pathName,
      transcriptText,
    );
  } catch {
    await releaseFinalTranscriptClaim({
      interviewId: interview.id,
      claimToken: claim.claim_token,
      claimVersion: Number(claim.claim_version),
      failureCategory: 'storage_failed',
    });
    captureSanitizedFinalTranscriptFailure('storage_failed', {
      stage: 'upload',
      retryable: true,
      httpClass: '5xx',
    });
    console.error('[webhook] final_transcript_reconciliation', {
      outcome: 'failed',
      retryable: true,
      stage: 'storage',
    });
    return finalTranscriptResponse(503, 'storage_failed', { retryable: true });
  }

  let finalized;
  try {
    const { data, error } = await supabaseAdmin.rpc(
      'finalize_interview_final_transcript_reconciliation',
      {
        p_interview_id: interview.id,
        p_provider_conversation_id: String(conversationId),
        p_claim_token: claim.claim_token,
        p_claim_version: Number(claim.claim_version),
        p_provider_event_key: providerEventKey,
        p_transcript_hash: transcriptHash,
        p_transcript_storage_ref: transcriptStorageRef,
        p_normalized_transcript: transcriptText,
        p_evidence_snapshot: evidenceSnapshot,
        p_transcript_scores: transcriptScores,
        p_interview_summary: interviewSummary,
      },
    );
    if (error) throw error;
    finalized = firstRpcRow(data);
    if (!finalized?.outcome) throw new Error('final_transcript_finalize_result_invalid');
  } catch {
    await releaseFinalTranscriptClaim({
      interviewId: interview.id,
      claimToken: claim.claim_token,
      claimVersion: Number(claim.claim_version),
      failureCategory: 'finalize_failed',
    });
    captureSanitizedFinalTranscriptFailure('finalize_failed', {
      stage: 'finalize',
      retryable: true,
      httpClass: '5xx',
    });
    console.error('[webhook] final_transcript_reconciliation', {
      outcome: 'failed',
      retryable: true,
      stage: 'finalize',
    });
    return finalTranscriptResponse(503, 'finalize_failed', { retryable: true });
  }

  if (!['finalized', 'already_reconciled', 'superseded_by_stronger_evidence'].includes(finalized.outcome)) {
    captureSanitizedFinalTranscriptFailure('finalize_failed', {
      stage: 'finalize',
      retryable: true,
      httpClass: '5xx',
    });
    return finalTranscriptResponse(503, 'finalize_failed', { retryable: true });
  }

  console.log('[webhook] final_transcript_reconciliation', projectReconciliationLog({
    outcome: finalized.outcome,
    claimVersion: Number(claim.claim_version),
    scoringPerformed,
    canonicalRepair: finalized.canonical_repair_applied === true,
    authoritativeSnapshotSource: finalized.authoritative_snapshot_source,
    statusBefore: finalized.status_before,
    statusAfter: finalized.status_after,
    progressBefore: finalized.progress_before,
    progressAfter: finalized.progress_after,
    classificationCounts: evidenceSnapshot.classification_counts,
    retryable: false,
  }));
  queueFinalTranscriptPostProcessing({
    interview,
    requestId,
    conversationId,
    transcriptItems,
    evidence,
    reconciliationOutcome: finalized.outcome,
    claimVersion: Number(claim.claim_version),
    transcriptHash,
  });
  return finalTranscriptResponse(200, finalized.outcome);
}

function extractSanitizedContent(item, options = {}) {
  if (!item) return null;

  const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
  if (!role || role === 'system') return null;

  let content = item.content ?? item.text ?? item.message ?? item.value;
  if (content == null) return null;
  if (typeof content !== 'string') {
    try {
      content = JSON.stringify(content);
    } catch {
      content = String(content);
    }
  }

  let text = String(content).trim();
  if (!text) return null;

  // Strip the "unanswered" marker artifacts so they don't appear in stored transcripts or get read aloud in reports.
  // NOTE: We still capture unanswered questions via `extractCandidateQuestions(...)` using refusal heuristics.
  if (!options.preserveQuestionMarkers) {
    text = text
      .replace(/\[\[UNANSWERED_QUESTION:[^\]]*\]\]/g, '')
      .replace(/\[\s*\]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  if (!text) return null;

  if (role === 'user') {
    return `CANDIDATE: ${text}`;
  }

  if (role === 'assistant' || role === 'interviewer' || role === 'agent') {
    return `INTERVIEWER: ${text}`;
  }

  return null;
}

function sanitizeTranscriptArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const line = extractSanitizedContent(item);
    if (line) out.push(line);
  }
  return out;
}


// The Tavus webhook handler, unchanged apart from becoming a named function.
async function handleTavusWebhookEvent(req, res) {
  let requestId = null;
  let eventType = null;
  let interviewId = null;
  let conversationId = null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  let isFinalTranscriptEvent = false;
  try {
    const body = req.body;
    const validation = validateTavusWebhookPayload(body);
    if (!validation.ok) {
      console.warn(
        '[webhook] tavus_webhook_payload_rejected',
        buildTavusWebhookValidationTelemetry(validation),
      );
      return res.status(400).json({
        ok: false,
        error: 'invalid_webhook_payload',
      });
    }

    requestId = getRequestId(req, body);
    Sentry.setTag('route_name', 'tavus_webhook');
    Sentry.setTag('surface', 'backend');
    const eventReceivedAt = new Date();
    const eventReceivedAtIso = eventReceivedAt.toISOString();

    eventType = validation.eventType;
    const isTranscriptionReady = eventType === 'application.transcription_ready';
    isFinalTranscriptEvent = isTranscriptionReady;
    if (!isTranscriptionReady && requestId) {
      Sentry.setTag('request_id', String(requestId));
    }
    const isRecordingReady = eventType === 'application.recording_ready';
    const isPerceptionAnalysis =
      eventType === 'conversation.perception_analysis' ||
      eventType === 'application.perception_analysis';
    const isPerceptionEventIngestion =
      ENABLE_TAVUS_PERCEPTION_EVENTS &&
      (
        eventType === 'conversation.utterance' ||
        eventType === 'conversation.perception_tool_call'
      );
    const isToolCall = eventType === 'conversation.tool_call';
    const isReplicaJoined = eventType === 'system.replica_joined';
    const isShutdown = eventType === 'system.shutdown';
    const isLifecycleEvent = [
      'conversation.utterance',
      'conversation.started_speaking',
      'conversation.stopped_speaking',
      'conversation.connected',
      'conversation.disconnected',
    ].includes(eventType);
    const isKnownEvent = isReplicaJoined || isShutdown || isTranscriptionReady || isRecordingReady || isPerceptionAnalysis || isToolCall || isPerceptionEventIngestion || isLifecycleEvent;

    interviewId = pickFirst(
      fromAny(body, 'interview_id'),
      fromAny(body, 'interviewId'),
      fromAny(body, 'metadata.interview_id'),
      fromAny(body, 'properties.interview_id'),
      fromAny(body, 'properties.interviewId'),
      fromAny(body, 'payload.interview_id'),
      fromAny(body, 'payload.interviewId'),
      fromAny(body, 'payload.metadata.interview_id')
    );

    conversationId = validation.conversationId;
    Sentry.addBreadcrumb({
      category: 'webhook',
      message: 'tavus webhook event received',
      level: 'info',
      data: isTranscriptionReady ? {
        event_type: eventType || null,
      } : {
        request_id: requestId || null,
        event_type: eventType || null,
        interview_id: interviewId || null,
        conversation_id: conversationId || null
      }
    });

    const recordingUrls = collectValues(
      body,
      'properties.recording_url',
      'recording_url',
      'payload.recording_url'
    );
    const videoUrls = collectValues(
      body,
      'properties.video_url',
      'video_url',
      'payload.video_url',
      'output.video_url'
    );
    console.log('[webhook] received', isTranscriptionReady ? {
      event_type: 'application.transcription_ready',
      has_binding_ids: !!(interviewId || conversationId),
      has_transcript_signal: !!pickFirst(
        fromAny(body, 'properties.transcript'),
        fromAny(body, 'transcript'),
        fromAny(body, 'payload.transcript'),
      ),
    } : {
      request_id: requestId || null,
      received_at: eventReceivedAtIso,
      event_type: eventType || null,
      interview_id: interviewId || null,
      conversation_id: conversationId || null,
      has_recording_url: recordingUrls.length > 0,
      recording_url_count: recordingUrls.length,
      has_video_url: videoUrls.length > 0,
      video_url_count: videoUrls.length
    });

    if (!isKnownEvent) {
      console.log('[webhook] unknown_event_ignored', {
        request_id: requestId || null,
        event_type: eventType || null,
        identifier_present: true,
      });
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!supabaseAdmin) {
      console.error('[webhook] fatal missing supabase admin credentials', isTranscriptionReady ? {
        event_type: 'application.transcription_ready',
      } : {
        request_id: requestId || null,
        interview_id: interviewId || null,
        conversation_id: conversationId || null
      });
      return isTranscriptionReady
        ? res.status(503).json({ ok: false, outcome: 'service_unavailable', retryable: true })
        : res.status(200).json({ ok: true });
    }

    const { interview, bindingError } = await getInterviewByIds(interviewId, conversationId);
    if (bindingError) {
      if (isTranscriptionReady && bindingError.code === 'binding_lookup_failed') {
        captureSanitizedFinalTranscriptFailure('binding_lookup_failed', {
          stage: 'binding',
          retryable: true,
          httpClass: '5xx',
        });
        console.error('[webhook] final_transcript_reconciliation', {
          outcome: 'failed',
          retryable: true,
          stage: 'binding_lookup',
        });
        return res.status(503).json({
          ok: false,
          outcome: 'binding_lookup_failed',
          retryable: true,
        });
      }
      console.warn('[webhook] unsafe_event_ignored', isTranscriptionReady ? {
        event_type: 'application.transcription_ready',
        reason: bindingError.code || 'unsafe_binding',
      } : {
        request_id: requestId || null,
        event_type: eventType || null,
        reason: bindingError.code || 'unsafe_binding',
        interview_id: interviewId || null,
        resolved_interview_id: bindingError.resolved_interview_id || null,
        conversation_id: conversationId || null
      });
      return isTranscriptionReady
        ? res.status(409).json({ ok: false, outcome: 'binding_not_found', retryable: false })
        : res.status(200).json({ ok: true, ignored: true });
    }
    if (!interview) {
      console.warn('[webhook] interview not found', isTranscriptionReady ? {
        event_type: 'application.transcription_ready',
        reason: 'binding_not_found',
      } : {
        request_id: requestId || null,
        event_type: eventType || null,
        interview_id: interviewId || null,
        conversation_id: conversationId || null,
        ignored: true,
        has_interview_id: !!interviewId,
        has_conversation_id: !!conversationId
      });
      return isTranscriptionReady
        ? res.status(404).json({ ok: false, outcome: 'binding_not_found', retryable: false })
        : res.status(200).json({ ok: true, ignored: true });
    }
    if (!isTranscriptionReady && interview?.id) Sentry.setTag('interview_id', String(interview.id));
    sentryCandidateId = interview?.candidate_id || null;
    sentryRoleId = interview?.role_id || null;
    sentryClientId = interview?.client_id || null;
    if (!isTranscriptionReady && sentryCandidateId) Sentry.setTag('candidate_id', String(sentryCandidateId));
    if (!isTranscriptionReady && sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));
    if (!isTranscriptionReady && sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    Sentry.addBreadcrumb({
      category: 'webhook',
      message: 'tavus webhook processing started',
      level: 'info',
      data: isTranscriptionReady ? {
        event_type: 'application.transcription_ready',
      } : {
        request_id: requestId || null,
        event_type: eventType || null,
        interview_id: interview?.id || null,
        conversation_id: conversationId || null
      }
    });
    const interviewCreatedAt = interview?.created_at || null;
    const elapsedFromInterviewCreatedSec = elapsedSecondsSince(interviewCreatedAt, eventReceivedAt);
    if (isPerceptionAnalysis) {
      console.log('[webhook] event_timing', {
        request_id: requestId || null,
        event_type: eventType || null,
        interview_id: interview.id || null,
        conversation_id: conversationId || null,
        interview_created_at: interviewCreatedAt,
        received_at: eventReceivedAtIso,
        elapsed_seconds_from_interview_created: elapsedFromInterviewCreatedSec
      });
    }

    const statusBefore = interview.status || null;
    const preserveFailureStatus = [
      'INTERVIEW_PROGRESS_STALLED',
      'INTERVIEW_DISCONNECTED'
    ].includes(String(interview.failure_code || '').trim().toUpperCase());
    let statusAfter = null;
    let analysisCompleteSummary = null;
    let perceptionKeysCount = null;
    let unansweredQuestionsCount = null;
    const toolNameRaw = pickFirst(
      fromAny(body, 'tool_name'),
      fromAny(body, 'tool.name'),
      fromAny(body, 'name'),
      fromAny(body, 'payload.tool_name'),
      fromAny(body, 'payload.tool.name'),
      fromAny(body, 'properties.tool_name'),
      fromAny(body, 'properties.tool.name')
    );
    const toolArgs = pickFirst(
      fromAny(body, 'tool_arguments'),
      fromAny(body, 'tool.arguments'),
      fromAny(body, 'arguments'),
      fromAny(body, 'payload.tool_arguments'),
      fromAny(body, 'payload.tool.arguments'),
      fromAny(body, 'properties.tool_arguments'),
      fromAny(body, 'properties.tool.arguments')
    );
    const toolName = String(toolNameRaw || '').trim().toLowerCase();

    if (isLifecycleEvent || isShutdown || isReplicaJoined) {
      await recordLifecycleEvent({ interview, body, eventType, receivedAt: eventReceivedAtIso });
    }

    if (isTranscriptionReady) {
      const result = await reconcileFinalTranscript({
        body,
        interview,
        requestId,
        conversationId,
      });
      for (const [name, value] of Object.entries(result.headers || {})) {
        res.set(name, value);
      }
      return res.status(result.status).json(result.body);
    }

    if (isPerceptionEventIngestion) {
      await ingestPerceptionEvent({
        interview,
        body,
        eventType,
        requestId,
        conversationId,
        eventReceivedAtIso,
        toolName
      });
      return res.status(200).json({ ok: true });
    }
    if (isLifecycleEvent) {
      return res.status(200).json({ ok: true });
    }

    const updates = {};
    let transcriptNonEmpty = false;
    let analysisMissing = false;
    let shouldTriggerAnalysisRun = false;
    let transcriptText = '';
    let transcriptQuestionText = '';
    let preserveRecordingState = false;
    let suppressRecordingReadyState = false;

    if (isToolCall && isTerminalInterviewToolName(toolName) && conversationId && interview?.id) {
      try {
        const apiKey = String(process.env.TAVUS_API_KEY || '').trim();
        if (!apiKey) {
          console.error('[webhook] tool_call missing tavus api key', {
            request_id: requestId || null,
            conversation_id: conversationId || null,
            interview_id: interview.id,
            tool_name: toolName
          });
        } else {
          let tavusEndSucceeded = false;
          try {
            await activeTavusHttpClient.endConversation(conversationId);
            tavusEndSucceeded = true;
          } catch (endError) {
            console.error('[webhook] tool_call tavus end failed', {
              request_id: requestId || null,
              interview_id: interview.id,
              tool_name: toolName,
              status: endError?.status || null,
              providerCode: endError?.providerCode || null,
              category: endError?.category || 'provider_error',
              attemptCount: Number.isInteger(endError?.attemptCount) ? endError.attemptCount : 1,
              timeout: endError?.timeout === true,
            });
          }

          if (tavusEndSucceeded && preserveFailureStatus) {
            statusAfter = interview.status || 'Incomplete';
            console.log('[webhook] tool_call failure_status_preserved', {
              request_id: requestId || null,
              conversation_id: conversationId || null,
              interview_id: interview.id,
              failure_code: interview.failure_code
            });
          } else if (tavusEndSucceeded) {
            const { error: toolUpdateError } = await supabaseAdmin
              .from('interviews')
              .update({
                status: 'ending_requested',
                updated_at: new Date().toISOString()
              })
              .eq('id', interview.id);

            if (toolUpdateError) {
              console.error('[webhook] tool_call status update failed', {
                request_id: requestId || null,
                conversation_id: conversationId || null,
                interview_id: interview.id,
                tool_name: toolName,
                error: toolUpdateError.message || toolUpdateError,
                details: toolUpdateError.details || null,
                hint: toolUpdateError.hint || null
              });
            } else {
              statusAfter = 'ending_requested';
              console.log('[webhook] terminal tool_call processed', {
                request_id: requestId || null,
                conversation_id: conversationId || null,
                interview_id: interview.id,
                tool_name: toolName,
                has_tool_arguments: toolArgs !== undefined && toolArgs !== null
              });
            }
          }
        }
      } catch (err) {
        console.error('[webhook] terminal tool_call failed', {
          request_id: requestId || null,
          conversation_id: conversationId || null,
          interview_id: interview.id,
          tool_name: toolName,
          error: err?.message || err
        });
      }
    }

    if (isShutdown) {
      updates.status = 'Ended';
      updates.vendor_end_reason = String(pickFirst(
        fromAny(body, 'properties.shutdown_reason'),
        fromAny(body, 'reason'),
        fromAny(body, 'properties.reason'),
        fromAny(body, 'payload.reason'),
        fromAny(body, 'status')
      ) || 'vendor_end_event').slice(0, 120);
      console.log('[webhook] interview ended', {
        request_id: requestId || null,
        interview_id: interview.id,
        tavus_application_id: interview.tavus_application_id || conversationId || null
      });
    }

    if (isTranscriptionReady) {
      const rawTranscript = pickFirst(
        fromAny(body, 'properties.transcript'),
        fromAny(body, 'transcript'),
        fromAny(body, 'payload.transcript')
      );

      const transcriptUrlSignal = pickFirst(
        fromAny(body, 'properties.transcript_url'),
        fromAny(body, 'transcript_url'),
        fromAny(body, 'payload.transcript_url')
      );
      const hasTranscriptSignal =
        (rawTranscript !== undefined && rawTranscript !== null) ||
        (transcriptUrlSignal !== undefined && transcriptUrlSignal !== null);
      if (hasTranscriptSignal) {
        const pathName = `interviews/${interview.id}.json`;
        const stored = await putJsonToStorage(TRANSCRIPTS_BUCKET, pathName, body);
        updates.transcript_url = stored;
      }

      const transcriptItems = Array.isArray(rawTranscript)
        ? rawTranscript
        : Array.isArray(rawTranscript?.messages)
          ? rawTranscript.messages
          : Array.isArray(fromAny(body, 'messages'))
            ? fromAny(body, 'messages')
            : Array.isArray(fromAny(body, 'transcript'))
              ? fromAny(body, 'transcript')
              : null;

      const questionLines = transcriptItems
        ? transcriptItems.map(item => extractSanitizedContent(item, { preserveQuestionMarkers: true })).filter(Boolean)
        : [];
      transcriptQuestionText = questionLines.join('\n\n').trim();
      const sanitizedLines = transcriptItems ? sanitizeTranscriptArray(transcriptItems) : [];
      transcriptText = sanitizedLines.join('\n\n').trim();
      if (transcriptText) {
        updates.transcript = transcriptText;
        updates.status = 'Transcribed';
        transcriptNonEmpty = true;
        analysisMissing = !isTranscriptAnalysisCompleteForRow(interview);
        shouldTriggerAnalysisRun = analysisMissing;
      } else {
        updates.transcript = null;
        updates.status = 'TranscriptionReceived';
      }
    }

    if (!transcriptText && interview?.transcript) {
      const existingTranscript = String(interview.transcript || '').trim();
      if (existingTranscript) {
        transcriptText = existingTranscript;
        if (!transcriptNonEmpty) {
          transcriptNonEmpty = true;
          analysisMissing = !isTranscriptAnalysisCompleteForRow(interview);
          shouldTriggerAnalysisRun = analysisMissing;
        }
      }
    }

    if (isRecordingReady) {
      const recordingUrlForLog = pickFirst(
        fromAny(body, 'properties.recording_url'),
        fromAny(body, 'recording_url'),
        fromAny(body, 'payload.recording_url')
      );
      const videoUrlForLog = pickFirst(
        fromAny(body, 'properties.video_url'),
        fromAny(body, 'video_url'),
        fromAny(body, 'payload.video_url'),
        fromAny(body, 'output.video_url')
      );
      const recordingFieldSnapshot = {
        has_recording_url: typeof recordingUrlForLog === 'string' && !!recordingUrlForLog.trim(),
        has_video_url: typeof videoUrlForLog === 'string' && !!videoUrlForLog.trim(),
        has_bucket_name: !!fromAny(body, 'bucket_name'),
        has_s3_key: !!fromAny(body, 's3_key'),
        duration: fromAny(body, 'duration'),
        properties_has_bucket_name: !!fromAny(body, 'properties.bucket_name'),
        properties_has_s3_key: !!fromAny(body, 'properties.s3_key'),
        properties_duration: fromAny(body, 'properties.duration'),
        payload_has_bucket_name: !!fromAny(body, 'payload.bucket_name'),
        payload_has_s3_key: !!fromAny(body, 'payload.s3_key'),
        payload_duration: fromAny(body, 'payload.duration'),
        output_has_bucket_name: !!fromAny(body, 'output.bucket_name'),
        output_has_s3_key: !!fromAny(body, 'output.s3_key'),
        output_duration: fromAny(body, 'output.duration')
      };
      console.log('[webhook] recording_ready fields', {
        request_id: requestId || null,
        ...recordingFieldSnapshot
      });

      const recordingUrl = pickFirst(
        fromAny(body, 'properties.recording_url'),
        fromAny(body, 'properties.video_url'),
        fromAny(body, 'recording_url'),
        fromAny(body, 'video_url'),
        fromAny(body, 'payload.recording_url'),
        fromAny(body, 'payload.video_url'),
        fromAny(body, 'output.video_url')
      );

      const recordingMeta = {
        bucket_name: pickFirst(
          fromAny(body, 'bucket_name'),
          fromAny(body, 'properties.bucket_name'),
          fromAny(body, 'payload.bucket_name'),
          fromAny(body, 'output.bucket_name')
        ),
        s3_key: pickFirst(
          fromAny(body, 's3_key'),
          fromAny(body, 'properties.s3_key'),
          fromAny(body, 'payload.s3_key'),
          fromAny(body, 'output.s3_key')
        ),
        duration: pickFirst(
          fromAny(body, 'duration'),
          fromAny(body, 'properties.duration'),
          fromAny(body, 'payload.duration'),
          fromAny(body, 'output.duration')
        )
      };

      const currentRecordingStatus = String(interview.recording_status || '').trim().toLowerCase();
      preserveRecordingState = currentRecordingStatus === 'deleted' || currentRecordingStatus === 'delete_failed';
      const expectedRecordingBucket = String(process.env.TAVUS_RECORDING_S3_BUCKET_NAME || '').trim();
      const receivedRecordingBucket = String(recordingMeta.bucket_name || '').trim();
      const recordingBucketMismatch = !!(
        receivedRecordingBucket &&
        expectedRecordingBucket &&
        receivedRecordingBucket !== expectedRecordingBucket
      );
      suppressRecordingReadyState = recordingBucketMismatch;
      if (preserveRecordingState) {
        console.warn('[webhook] recording_ready_state_preserved', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          recording_status: currentRecordingStatus
        });
      }
      if (recordingBucketMismatch) {
        console.warn('[webhook] recording_ready_bucket_mismatch', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          expected_bucket: expectedRecordingBucket,
          received_bucket: receivedRecordingBucket
        });
      }

      const hasDownloadableUrl = isDownloadableRecordingUrl(recordingUrl);
      if (recordingUrl && !hasDownloadableUrl && isDailyRoomUrl(recordingUrl)) {
        const existingVideoUrl = interview.video_url || null;
        if (!preserveRecordingState && (!existingVideoUrl || isDailyRoomUrl(existingVideoUrl))) {
          updates.video_url = null;
        }
      } else if (hasDownloadableUrl && !preserveRecordingState && !recordingBucketMismatch) {
        updates.video_url = recordingUrl;
      }

      if (!hasDownloadableUrl && Object.keys(pruneMetadata(recordingMeta)).length && !preserveRecordingState && !recordingBucketMismatch) {
        updates.recording_metadata = recordingMeta;
      }
    }

    if (isPerceptionAnalysis) {
      let perceptionRawPath = null;
      try {
        const perceptionPath = `interviews/${interview.id}-perception.json`;
        perceptionRawPath = await putJsonToStorage(TRANSCRIPTS_BUCKET, perceptionPath, body);
        const { error: rawErr } = await supabaseAdmin
          .from('interviews')
          .update({ perception_raw_path: perceptionRawPath })
          .eq('id', interview.id);
        if (rawErr) {
          console.error('[webhook] perception_raw_path update failed', {
            request_id: requestId || null,
            interview_id: interview.id,
            conversation_id: conversationId || null,
            error: rawErr.message || rawErr,
            details: rawErr.details || null,
            hint: rawErr.hint || null
          });
        }
      } catch (err) {
        console.error('[webhook] perception_analysis storage failed', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          error: err?.message || err,
          details: err?.details || null,
          hint: err?.hint || null
        });
      }

      let analysisText = pickFirst(
        fromAny(body, 'properties.analysis'),
        fromAny(body, 'analysis'),
        fromAny(body, 'payload.analysis'),
        fromAny(body, 'properties.perception_analysis'),
        fromAny(body, 'perception_analysis'),
        fromAny(body, 'payload.perception_analysis')
      );
      const perceptionScoreSources = [
        body,
        body?.properties,
        body?.payload,
        body?.payload?.properties,
        body?.analysis,
        body?.perception_analysis,
        body?.payload?.analysis,
        body?.payload?.perception_analysis
      ];
      if (analysisText && typeof analysisText === 'object') {
        try {
          analysisText = JSON.stringify(analysisText);
        } catch {
          analysisText = String(analysisText);
        }
      }
      const perceptionResult = await updatePerceptionAnalysis(interview, analysisText, requestId, perceptionScoreSources);
      if (ENABLE_INTERVIEW_ANALYSIS_V2 && eventType === 'application.perception_analysis' && perceptionResult?.stored) {
        const eligibility = analysisV2Eligibility(interview);
        queueInterviewAnalysisV2({
          interview,
          requestId,
          conversationId,
          refreshOnMissingPerception: true,
          substantiveEvidence: eligibility.eligible,
          skipReason: eligibility.reason,
        });
      }
      const extractedKeys = Object.keys(perceptionResult?.perception_scores || {});
      if (eventType === 'application.perception_analysis' && !extractedKeys.length) {
        await maybeStoreTranscriptPerceptionFallback(interview, requestId, conversationId);
      }
      perceptionKeysCount = extractedKeys.length;
      if (extractedKeys.length) {
        console.log('[webhook] perception_analysis processed', {
          request_id: requestId || null,
          event_type: eventType || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          interview_created_at: interviewCreatedAt,
          elapsed_seconds_from_interview_created: elapsedFromInterviewCreatedSec,
          extracted_keys: extractedKeys,
          extracted_count: extractedKeys.length,
          stored: perceptionResult?.stored ?? null
        });
      } else {
        console.warn('[webhook] perception_analysis no scores extracted', {
          request_id: requestId || null,
          event_type: eventType || null,
          interview_id: interview.id,
          extracted_interview_id: interviewId || null,
          conversation_id: conversationId || null,
          interview_created_at: interviewCreatedAt,
          elapsed_seconds_from_interview_created: elapsedFromInterviewCreatedSec,
          top_keys: Object.keys(body || {}),
          payload_keys: Object.keys(body?.payload || {})
        });
      }
    }

    if (preserveFailureStatus && updates.status) {
      console.log('[webhook] failure_status_preserved', {
        request_id: requestId || null,
        event_type: eventType || null,
        interview_id: interview.id,
        failure_code: interview.failure_code,
        ignored_status: updates.status
      });
      delete updates.status;
    }

    let updatesApplied = false;
    if (Object.keys(updates).length) {
      const { recording_metadata: recordingMeta, ...baseUpdates } = updates;
      const hasRecordingMetadata = Object.keys(pruneMetadata(recordingMeta)).length > 0;
      try {
        await applyInterviewUpdates(interview.id, baseUpdates, recordingMeta, {
          preserveRecordingState,
          suppressRecordingReadyState
        });
        updatesApplied = true;
        if (isRecordingReady && hasRecordingMetadata) {
          console.log('[webhook] recording_metadata_stored', {
            request_id: requestId || null,
            interview_id: interview.id,
            conversation_id: conversationId || null
          });
        }
      } catch (err) {
        console.error('[webhook] interview update failed', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          error: err?.message || err,
          details: err?.details || null,
          hint: err?.hint || null
        });
        if (isRecordingReady && hasRecordingMetadata) {
          console.error('[webhook] recording_metadata_store_failed', {
            request_id: requestId || null,
            interview_id: interview.id,
            conversation_id: conversationId || null,
            error: err?.message || err,
            details: err?.details || null,
            hint: err?.hint || null
          });
        }
      }
    }

    let freshAfterTranscript = null;
    let transcriptForQuestions = transcriptQuestionText || transcriptText;
    if (isTranscriptionReady) {
      const { data: fresh, error: freshErr } = await supabaseAdmin
        .from('interviews')
        .select('id, role_id, status, analysis, transcript_scores, transcript, interview_summary, perception_scores, unanswered_candidate_questions')
        .eq('id', interview.id)
        .maybeSingle();
      if (freshErr) {
        console.error('[webhook] post-transcription reselect failed', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          error: freshErr.message || freshErr,
          details: freshErr.details || null,
          hint: freshErr.hint || null
        });
      } else {
        freshAfterTranscript = fresh;
        const freshTranscript = typeof fresh?.transcript === 'string' ? fresh.transcript.trim() : '';
        if (!transcriptForQuestions && freshTranscript) {
          transcriptForQuestions = freshTranscript;
          transcriptNonEmpty = true;
        }

        const analysisComplete = isTranscriptAnalysisCompleteForRow(fresh);
        analysisCompleteSummary = analysisComplete;
        if (transcriptNonEmpty) {
          analysisMissing = !analysisComplete;
          shouldTriggerAnalysisRun = analysisMissing;
        }
        if (transcriptNonEmpty) {
          const scoringResult = await applyTranscriptScoringForInterview({
            interview,
            fresh,
            transcriptText: freshTranscript || transcriptForQuestions || '',
            requestId,
            conversationId
          });

          const statusFrom = fresh.status || null;
          let statusTo = null;
          const allowed = [
            'ReadyForAnalysis',
            'Ready For Analysis',
            'Transcribed',
            'TranscriptionReceived',
            'TranscriptionReady',
            'TranscriptReady',
            'Video Ready'
          ];
          if (!scoringResult?.substantive) {
            statusTo = 'Incomplete';
            shouldTriggerAnalysisRun = false;
            analysisMissing = false;
          } else if (allowed.includes(statusFrom)) {
            statusTo = analysisComplete ? 'Analyzed' : 'ReadyForAnalysis';
          }

          if (statusTo) {
            const { error: statusErr } = await supabaseAdmin
              .from('interviews')
              .update({ status: statusTo })
              .eq('id', interview.id);
            if (statusErr) {
              console.error('[webhook] analysis status update failed', {
                request_id: requestId || null,
                interview_id: interview.id,
                conversation_id: conversationId || null,
                error: statusErr.message || statusErr,
                details: statusErr.details || null,
                hint: statusErr.hint || null
              });
            } else if (statusTo !== statusFrom) {
              statusAfter = statusTo;
            }
          }

          console.log('[webhook] post-transcription status normalization', {
            request_id: requestId || null,
            event_type: eventType || null,
            interview_id: interview.id,
            conversation_id: conversationId || null,
            interview_created_at: interviewCreatedAt,
            elapsed_seconds_from_interview_created: elapsedFromInterviewCreatedSec,
            status_from: statusFrom,
            status_to: statusTo,
            scoring_updated: scoringResult?.updated || false
          });
          if (scoringResult?.substantive) {
            queueInterviewAnalysisV2({ interview, requestId, conversationId });
          }
        }
      }
    }

    if (transcriptNonEmpty && !analysisMissing) {
      console.log('[webhook] skip transcript analysis (already analyzed)', {
        request_id: requestId || null,
        interview_id: interview.id
      });
    }

    const currentQuestions = freshAfterTranscript
      ? freshAfterTranscript.unanswered_candidate_questions
      : interview.unanswered_candidate_questions;
    const needsQuestionCapture =
      transcriptNonEmpty &&
      transcriptForQuestions &&
      isEmptyQuestionList(currentQuestions);

    if (needsQuestionCapture) {
      const questions = extractCandidateQuestions(transcriptForQuestions);
      unansweredQuestionsCount = questions.length;
      if (questions.length) {
        setImmediate(async () => {
          try {
            const { error } = await supabaseAdmin
              .from('interviews')
              .update({ unanswered_candidate_questions: questions })
              .eq('id', interview.id);
            if (error) {
              console.error('[webhook] unanswered_candidate_questions update failed', {
                request_id: requestId || null,
                interview_id: interview.id,
                conversation_id: conversationId || null,
                error: error.message || error,
                details: error.details || null,
                hint: error.hint || null
              });
            } else {
              console.log('[webhook] unanswered_candidate_questions updated', {
                request_id: requestId || null,
                interview_id: interview.id,
                count: questions.length
              });
            }
          } catch (err) {
            console.error('[webhook] unanswered_candidate_questions update failed', {
              request_id: requestId || null,
              interview_id: interview.id,
              conversation_id: conversationId || null,
              error: err?.message || err,
              details: err?.details || null,
              hint: err?.hint || null
            });
          }
        });
      }
    }

    if (
      shouldTriggerAnalysisRun &&
      transcriptNonEmpty &&
      shouldTriggerAnalysis(interview.id, requestId)
    ) {
      console.log('[webhook] trigger transcript analysis', {
        request_id: requestId || null,
        interview_id: interview.id,
        transcriptNonEmpty,
        analysisMissing
      });
      setImmediate(async () => {
        try {
          const result = await analyzeInterviewTranscriptById(interview.id, {
            request_id: requestId || null,
            dry_run: false
          });
          let analysisComplete = false;
          let statusFrom = null;
          let statusTo = null;
          let statusError = null;

          if (result?.ok) {
            const { data: fresh, error: freshErr } = await supabaseAdmin
              .from('interviews')
              .select('id, role_id, status, analysis, transcript_scores, transcript, interview_summary, perception_scores')
              .eq('id', interview.id)
              .maybeSingle();
            if (!freshErr && fresh) {
          analysisComplete = isTranscriptAnalysisCompleteForRow(fresh);
          statusFrom = fresh.status || null;
          const scoringResult = await applyTranscriptScoringForInterview({
            interview,
            fresh,
            transcriptText: typeof fresh.transcript === 'string' ? fresh.transcript : '',
            requestId,
            conversationId
          });
          queueInterviewAnalysisV2({
            interview,
            requestId,
            conversationId,
            substantiveEvidence: scoringResult?.substantive === true,
            skipReason: scoringResult?.reason || 'no_substantive_responses',
          });

              const allowed = [
                'ReadyForAnalysis',
                'Ready For Analysis',
                'Transcribed',
                'TranscriptionReceived',
                'TranscriptionReady',
                'TranscriptReady',
                'Video Ready'
              ];
              if (allowed.includes(statusFrom)) {
                if (analysisComplete) {
                  statusTo = 'Analyzed';
                } else if (typeof fresh.transcript === 'string' && fresh.transcript.trim()) {
                  statusTo = 'ReadyForAnalysis';
                }
              }
              if (statusTo) {
                const { error: statusErr } = await supabaseAdmin
                  .from('interviews')
                  .update({ status: statusTo })
                  .eq('id', interview.id);
                if (statusErr) {
                  statusError = statusErr.message || statusErr;
                  console.error('[webhook] analysis status update failed', {
                    request_id: requestId || null,
                    interview_id: interview.id,
                    conversation_id: conversationId || null,
                    error: statusErr.message || statusErr,
                    details: statusErr.details || null,
                    hint: statusErr.hint || null
                  });
                }
              }
            } else if (freshErr) {
              statusError = freshErr.message || freshErr;
            }
          }

          console.log('[webhook] transcript analysis finished', {
            request_id: requestId || null,
            interview_id: interview.id,
            ok: result?.ok ?? null,
            updated: result?.updated ?? null,
            skipped: result?.skipped ?? null,
            reason: result?.reason ?? null,
            error: result?.error ?? statusError ?? null,
            analysis_complete: analysisComplete,
            status_from: statusFrom,
            status_to: statusTo
          });
          if (result?.ok === false) {
            console.error('[webhook] transcript analysis update failed', {
              request_id: requestId || null,
              interview_id: interview.id,
              conversation_id: conversationId || null,
              error: result?.error ?? null
            });
          }
        } catch (err) {
          console.error('[webhook] transcript analysis failed', {
            request_id: requestId || null,
            interview_id: interview.id,
            conversation_id: conversationId || null,
            error: err?.message || err
          });
        }
      });
    }

    if (analysisCompleteSummary === null) {
      analysisCompleteSummary = isTranscriptAnalysisCompleteForRow(interview);
    }

    console.log('[webhook] summary', {
      request_id: requestId || null,
      event_type: eventType || null,
      interview_id: interview.id,
      conversation_id: conversationId || null,
      status_before: statusBefore,
      status_after: statusAfter,
      analysis_complete: analysisCompleteSummary,
      perception_keys_count: perceptionKeysCount,
      unanswered_questions_count: unansweredQuestionsCount
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    if (isFinalTranscriptEvent) {
      captureSanitizedFinalTranscriptFailure('unexpected_failure', {
        stage: 'unexpected',
        retryable: true,
        httpClass: '5xx',
      });
      console.error('[webhook] final_transcript_reconciliation', {
        outcome: 'failed',
        retryable: true,
        stage: 'unexpected',
      });
      return res.status(503).json({ ok: false, outcome: 'unexpected_failure', retryable: true });
    }
    Sentry.captureException(e, {
      tags: {
        route_name: 'tavus_webhook',
        surface: 'backend',
        request_id: requestId || undefined,
        interview_id: interviewId || undefined,
        conversation_id: conversationId || undefined,
        candidate_id: sentryCandidateId || undefined,
        role_id: sentryRoleId || undefined,
        client_id: sentryClientId || undefined
      },
      extra: {
        request_id: requestId || null,
        event_type: eventType || null,
        interview_id: interviewId || null,
        conversation_id: conversationId || null,
        candidate_id: sentryCandidateId,
        role_id: sentryRoleId,
        client_id: sentryClientId
      }
    });
    console.error('[webhook] error:', e.message || e);
    // Be lenient to avoid provider retries storms
    return res.status(200).json({ ok: true });
  }
}

module.exports = {
  handleTavusWebhookEvent,
  setTavusHttpClientForTest(client) {
    activeTavusHttpClient = client || defaultTavusHttpClient;
  },
  setSupabaseAdminForTest(client) {
    supabaseAdmin = client === undefined ? defaultSupabaseAdmin : client;
  },
  _test: Object.freeze({
    analysisV2Eligibility,
    maybeGenerateInterviewAnalysisV2,
    queueInterviewAnalysisV2,
  }),
};
