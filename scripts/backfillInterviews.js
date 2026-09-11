// scripts/backfillInterviews.js
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { isSubstantiveTranscript, scoreInterview, INSUFFICIENT_SUMMARY } = require('../src/services/interviewScoring');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TRANSCRIPTS_BUCKET = process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts';
const BACKFILL_LIMIT = Number(process.env.BACKFILL_LIMIT || 500);
const BACKFILL_DRY_RUN = String(process.env.BACKFILL_DRY_RUN || 'true').toLowerCase() === 'true';
const BACKFILL_START_AFTER_ID = process.env.BACKFILL_START_AFTER_ID || null;
const BACKFILL_HYDRATE_TRANSCRIPT = String(process.env.BACKFILL_HYDRATE_TRANSCRIPT || 'false').toLowerCase() === 'true';
const BACKFILL_CURSOR_CREATED_AT = process.env.BACKFILL_CURSOR_CREATED_AT || null;
const BACKFILL_CURSOR_ID = process.env.BACKFILL_CURSOR_ID || null;

function pickFirst(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function fromAny(obj, ...paths) {
  for (const p of paths) {
    try {
      const parts = p.split('.');
      let cur = obj;
      for (const key of parts) cur = cur?.[key];
      if (cur !== undefined) return cur;
    } catch {}
  }
  return undefined;
}

function extractSanitizedContent(item) {
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

  const text = String(content).trim();
  if (!text) return null;

  if (role === 'user') return `CANDIDATE: ${text}`;
  if (role === 'assistant' || role === 'interviewer' || role === 'agent') {
    return `INTERVIEWER: ${text}`;
  }
  return null;
}

function sanitizeTranscriptArray(arr) {
  if (!Array.isArray(arr)) return '';
  const out = [];
  for (const item of arr) {
    const line = extractSanitizedContent(item);
    if (line) out.push(line);
  }
  return out.join('\n\n');
}

function parsePublicStorageUrl(u) {
  const m = u?.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
  return m ? { bucket: m[1], path: m[2] } : null;
}

function parseStoredRef(ref) {
  if (!ref) return null;
  const trimmed = String(ref).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  let path = trimmed.replace(/^\/+/, '');
  if (path.startsWith(`${TRANSCRIPTS_BUCKET}/`)) {
    path = path.slice(`${TRANSCRIPTS_BUCKET}/`.length);
  } else if (path.startsWith(`${TRANSCRIPTS_BUCKET}`)) {
    path = path.slice(`${TRANSCRIPTS_BUCKET}`.length);
    path = path.replace(/^\/+/, '');
  }
  if (path.startsWith('/')) path = path.replace(/^\/+/, '');
  return { bucket: TRANSCRIPTS_BUCKET, path };
}

function resolveTranscriptRef(ref) {
  if (!ref) return null;
  const trimmed = String(ref).trim();
  if (!trimmed) return null;

  const storage = parsePublicStorageUrl(trimmed);
  if (storage) return { ...storage, source: 'storage-url' };

  if (/^https?:\/\//i.test(trimmed)) {
    return { url: trimmed, source: 'http' };
  }

  const stored = parseStoredRef(trimmed);
  return stored ? { ...stored, source: 'path' } : null;
}

async function downloadTranscriptPayload(ref) {
  const resolved = resolveTranscriptRef(ref);
  if (!resolved) return null;

  if (resolved.source === 'storage-url' || resolved.source === 'path') {
    const { data, error } = await supabase.storage.from(resolved.bucket).download(resolved.path);
    if (!error && data) {
      const buf = Buffer.from(await data.arrayBuffer());
      const raw = buf.toString('utf8');
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }

    if (resolved.source === 'storage-url' && /^https?:\/\//i.test(String(ref || ''))) {
      try {
        const res = await fetch(ref);
        if (!res.ok) return null;
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  if (resolved.source === 'http') {
    try {
      const res = await fetch(resolved.url);
      if (!res.ok) return null;
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function extractTranscriptItemsFromPayload(payload) {
  if (!payload) return null;
  const rawTranscript = pickFirst(
    fromAny(payload, 'properties.transcript'),
    fromAny(payload, 'transcript'),
    fromAny(payload, 'payload.transcript')
  );

  if (Array.isArray(rawTranscript)) return rawTranscript;
  if (Array.isArray(rawTranscript?.messages)) return rawTranscript.messages;
  if (Array.isArray(fromAny(payload, 'messages'))) return fromAny(payload, 'messages');
  if (Array.isArray(fromAny(payload, 'transcript'))) return fromAny(payload, 'transcript');
  return null;
}

function sanitizeTranscriptPayload(payload) {
  if (payload == null) return '';

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return '';
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        return sanitizeTranscriptPayload(parsed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  if (Array.isArray(payload)) {
    const text = sanitizeTranscriptArray(payload);
    return text.trim();
  }

  if (typeof payload === 'object') {
    const items = extractTranscriptItemsFromPayload(payload);
    if (!items) return '';
    const text = sanitizeTranscriptArray(items);
    return text.trim();
  }

  return '';
}

async function getTranscriptText(row) {
  if (row.transcript && row.transcript.trim().length > 0) {
    return row.transcript.trim();
  }

  const ref = row.transcript_url;
  if (!ref) return '';
  const payload = await downloadTranscriptPayload(ref);
  return sanitizeTranscriptPayload(payload);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const roleScoringContextCache = new Map();
async function getRoleScoringContext(roleId) {
  if (!roleId) return null;
  const cacheKey = String(roleId);
  if (roleScoringContextCache.has(cacheKey)) return roleScoringContextCache.get(cacheKey);
  const { data, error } = await supabase
    .from('roles')
    .select('id,title,description,interview_type,job_description_text,job_description_url,rubric,rubric_questions,manual_questions')
    .eq('id', roleId)
    .maybeSingle();
  if (error) {
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

async function scoreWithRetry(input, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await scoreInterview(input);
    } catch (err) {
      lastErr = err;
      const delay = 500 * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function normalizeAnalysis(analysis) {
  if (!analysis) return {};
  if (typeof analysis === 'object' && !Array.isArray(analysis)) return analysis;
  if (typeof analysis === 'string') {
    try {
      const parsed = JSON.parse(analysis);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

async function analyzeInterviewTranscriptById(interviewId, opts = {}) {
  const requestId = opts?.request_id || null;
  const dryRun = opts?.dry_run === true;
  const forceRescore = opts?.force_rescore === true;
  const returnPayload = opts?.return_payload === true;

  try {
    if (!interviewId) {
      return { ok: false, error: 'missing_interview_id', request_id: requestId || null };
    }

    const { data: row, error } = await supabase
      .from('interviews')
      .select('id, role_id, transcript, transcript_url, analysis, transcript_scores, interview_summary, perception_scores, status')
      .eq('id', interviewId)
      .maybeSingle();
    if (error || !row) {
      return { ok: false, error: error?.message || 'interview_not_found', request_id: requestId || null };
    }

    const existingTopScores = row.transcript_scores && typeof row.transcript_scores === 'object'
      ? row.transcript_scores
      : {};
    const existingOverall = existingTopScores.overall;
    const existingConfidence = existingTopScores.confidence;
    const existingSummary = typeof row.interview_summary === 'string' ? row.interview_summary.trim() : '';
    const alreadyMarkedInsufficient = Number(existingConfidence) === 0 &&
      (existingSummary === INSUFFICIENT_SUMMARY || existingSummary.includes('Interview ended before any substantive responses were recorded.'));
    if (!forceRescore && ((Number.isFinite(existingOverall) && existingSummary) || alreadyMarkedInsufficient)) {
      return { ok: true, skipped: true, reason: 'already_analyzed', request_id: requestId || null };
    }

    const transcriptText = await getTranscriptText(row);
    if (!transcriptText) {
      return { ok: true, skipped: true, reason: 'empty_transcript', request_id: requestId || null };
    }

    const substantive = isSubstantiveTranscript(transcriptText);
    if (!substantive.ok) {
      return {
        ok: true,
        skipped: true,
        reason: substantive.reason || 'no_substantive_candidate_response',
        request_id: requestId || null,
      };
    }
    const roleContext = await getRoleScoringContext(row.role_id);
    const jdText = getJdTextFromRoleContext(roleContext);
    const perceptionScores = row.perception_scores && typeof row.perception_scores === 'object'
      ? row.perception_scores
      : {};
    const { summary, transcript_scores } = await scoreWithRetry({
      transcriptText,
      jdText,
      roleContext,
      perceptionScores,
      mode: 'backfill',
      request_id: requestId || null
    }, 3);

    const updatePayload = {
      transcript_scores: { ...existingTopScores, ...(transcript_scores || {}) }
    };
    updatePayload.interview_summary = summary;
    if (BACKFILL_HYDRATE_TRANSCRIPT && (!row.transcript || row.transcript.trim().length === 0)) {
      updatePayload.transcript = transcriptText;
    }

    if (dryRun) {
      return {
        ok: true,
        updated: false,
        dry_run: true,
        prior_overall: Number.isFinite(existingOverall) ? Number(existingOverall) : null,
        rescored_overall: Number.isFinite(transcript_scores?.overall) ? Number(transcript_scores.overall) : null,
        ...(returnPayload ? { update_payload: updatePayload } : {}),
        request_id: requestId || null,
      };
    }

    const { error: upErr } = await supabase
      .from('interviews')
      .update(updatePayload)
      .eq('id', row.id);
    if (upErr) {
      return { ok: false, error: upErr.message, request_id: requestId || null };
    }

    if (!substantive.ok) {
      return { ok: true, updated: true, skipped: true, reason: `insufficient_${substantive.reason}`, request_id: requestId || null };
    }

    return {
      ok: true,
      updated: true,
      prior_overall: Number.isFinite(existingOverall) ? Number(existingOverall) : null,
      rescored_overall: Number.isFinite(transcript_scores?.overall) ? Number(transcript_scores.overall) : null,
      request_id: requestId || null,
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), request_id: requestId || null };
  }
}

async function main() {
  let scanned = 0;
  let skipped = 0;
  let scored = 0;
  let insufficient = 0;
  let would_update = 0;
  let updated = 0;
  let failed = 0;

  let query = supabase
    .from('interviews')
    .select('id, role_id, created_at, transcript, transcript_url, analysis, transcript_scores, interview_summary, perception_scores')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(BACKFILL_LIMIT);

  if (BACKFILL_CURSOR_CREATED_AT) {
    query = query.gte('created_at', BACKFILL_CURSOR_CREATED_AT);
  } else if (BACKFILL_START_AFTER_ID) {
    query = query.gt('id', BACKFILL_START_AFTER_ID);
  }

  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.log('No rows to process.');
    console.log(`scanned=${scanned} skipped=${skipped} scored=${scored} insufficient=${insufficient} would_update=${would_update} updated=${updated} failed=${failed}`);
    return;
  }

  const cursorTime = BACKFILL_CURSOR_CREATED_AT ? Date.parse(BACKFILL_CURSOR_CREATED_AT) : null;

  for (const row of rows) {
    scanned += 1;

    if (BACKFILL_CURSOR_CREATED_AT) {
      const rowTime = Date.parse(row.created_at);
      if (Number.isFinite(rowTime) && Number.isFinite(cursorTime)) {
        if (rowTime < cursorTime) {
          skipped += 1;
          console.log(`[backfill] skip ${row.id} cursor_before`);
          continue;
        }
        if (rowTime === cursorTime && BACKFILL_CURSOR_ID) {
          const rowIdNum = Number(row.id);
          const cursorIdNum = Number(BACKFILL_CURSOR_ID);
          let shouldSkip = false;
          if (Number.isFinite(rowIdNum) && Number.isFinite(cursorIdNum)) {
            shouldSkip = rowIdNum <= cursorIdNum;
          } else {
            shouldSkip = String(row.id) <= String(BACKFILL_CURSOR_ID);
          }
          if (shouldSkip) {
            skipped += 1;
            console.log(`[backfill] skip ${row.id} cursor_tie`);
            continue;
          }
        }
      }
    }

    try {
      const existingTopScores = row.transcript_scores && typeof row.transcript_scores === 'object'
        ? row.transcript_scores
        : {};
      const existingOverall = existingTopScores.overall;
      const existingConfidence = existingTopScores.confidence;
      const existingSummary = typeof row.interview_summary === 'string' ? row.interview_summary.trim() : '';
      const alreadyMarkedInsufficient = Number(existingConfidence) === 0 &&
        (existingSummary === INSUFFICIENT_SUMMARY || existingSummary.includes('Interview ended before any substantive responses were recorded.'));
      if ((Number.isFinite(existingOverall) && existingSummary) || alreadyMarkedInsufficient) {
        skipped += 1;
        console.log(`[backfill] skip ${row.id} already_analyzed`);
        continue;
      }

      const transcriptText = await getTranscriptText(row);
      if (!transcriptText) {
        skipped += 1;
        console.log(`[backfill] skip ${row.id} empty_transcript`);
        continue;
      }

      const substantive = isSubstantiveTranscript(transcriptText);
      if (!substantive.ok) {
        skipped += 1;
        console.log(`[backfill] skip ${row.id} ${substantive.reason || 'no_substantive_candidate_response'}`);
        continue;
      }
      scored += 1;
      const roleContext = await getRoleScoringContext(row.role_id);
      const jdText = getJdTextFromRoleContext(roleContext);
      const perceptionScores = row.perception_scores && typeof row.perception_scores === 'object'
        ? row.perception_scores
        : {};
      const { summary, transcript_scores } = await scoreWithRetry({
        transcriptText,
        jdText,
        roleContext,
        perceptionScores,
        mode: 'backfill',
        request_id: null
      }, 3);

      const updatePayload = {
        transcript_scores: { ...existingTopScores, ...(transcript_scores || {}) }
      };
      updatePayload.interview_summary = summary;
      if (BACKFILL_HYDRATE_TRANSCRIPT && (!row.transcript || row.transcript.trim().length === 0)) {
        updatePayload.transcript = transcriptText;
      }

      if (BACKFILL_DRY_RUN) {
        would_update += 1;
        console.log(`[backfill] dry_run ${row.id}`);
        continue;
      }

      const { error: upErr } = await supabase
        .from('interviews')
        .update(updatePayload)
        .eq('id', row.id);
      if (upErr) throw upErr;

      updated += 1;
      console.log(`[backfill] updated ${row.id}`);
    } catch (e) {
      failed += 1;
      console.log(`[backfill] failed ${row.id}: ${e?.message || e}`);
    }
  }

  console.log(`scanned=${scanned} skipped=${skipped} scored=${scored} insufficient=${insufficient} would_update=${would_update} updated=${updated} failed=${failed}`);
}

module.exports = { analyzeInterviewTranscriptById };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
