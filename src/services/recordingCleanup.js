'use strict';

const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { supabaseAdmin } = require('../clients/supabase');
const { INSUFFICIENT_SUMMARY, isSubstantiveTranscript } = require('./interviewScoring');

const DELETE_REASON_NO_SUBSTANTIVE = 'no_substantive_interview';
const DELETE_REASON_ROLE_INACTIVE_EXPIRED = 'role_inactive_expired';
const s3ClientsByRegion = new Map();

function getS3Client(region) {
  if (!s3ClientsByRegion.has(region)) {
    s3ClientsByRegion.set(region, new S3Client({ region }));
  }
  return s3ClientsByRegion.get(region);
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function sanitizeError(error) {
  return String(error?.message || error || 'recording_delete_failed')
    .replace(/(X-Amz-Signature|Signature)=[^&\s]+/gi, '$1=REDACTED')
    .replace(/(Authorization|Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 REDACTED')
    .slice(0, 500);
}

function hasInsufficientSummary(summary) {
  const text = String(summary || '').trim();
  const lower = text.toLowerCase();
  return (
    text === INSUFFICIENT_SUMMARY ||
    lower.includes('before any substantive responses were recorded') ||
    lower.includes('before substantive responses were captured') ||
    lower.includes('insufficient data')
  );
}

function isNoSubstantiveInterview(row) {
  if (hasInsufficientSummary(row?.interview_summary)) return true;
  const transcript = typeof row?.transcript === 'string' ? row.transcript.trim() : '';
  if (!transcript) return false;
  return !isSubstantiveTranscript(transcript).ok;
}

function isExpiredRecording(row, now) {
  const raw = String(row?.recording_expires_at || '').trim();
  if (!raw) return false;
  const expiresAt = new Date(raw);
  return Number.isFinite(expiresAt.getTime()) && expiresAt <= now;
}

async function cleanupNoSubstantiveRecordings(options = {}) {
  const db = options.db || supabaseAdmin;
  const logger = options.logger || console;
  const region = String(process.env.AWS_REGION || process.env.TAVUS_RECORDING_S3_BUCKET_REGION || '').trim();
  const expectedBucket = String(process.env.TAVUS_RECORDING_S3_BUCKET_NAME || '').trim();
  const summary = { ok: true, scanned: 0, deleted: 0, skipped: 0, failed: 0 };
  const now = new Date();

  logger.log('[recording-cleanup] start', { reasons: [DELETE_REASON_NO_SUBSTANTIVE, DELETE_REASON_ROLE_INACTIVE_EXPIRED] });
  if (!region) {
    throw new Error('AWS region missing for recording cleanup');
  }
  if (!expectedBucket) {
    throw new Error('TAVUS_RECORDING_S3_BUCKET_NAME missing for recording cleanup');
  }

  const { data: rows, error } = await db
    .from('interviews')
    .select('id, recording_metadata, recording_status, recording_expires_at, interview_summary, transcript')
    .eq('recording_status', 'ready');

  if (error) throw error;

  const s3 = getS3Client(region);
  for (const row of rows || []) {
    summary.scanned += 1;
    const metadata = parseJsonObject(row.recording_metadata);
    const bucketName = String(metadata.bucket_name || '').trim();
    const s3Key = String(metadata.s3_key || '').trim();
    const noSubstantive = isNoSubstantiveInterview(row);
    const deleteReason = noSubstantive
      ? DELETE_REASON_NO_SUBSTANTIVE
      : isExpiredRecording(row, now)
        ? DELETE_REASON_ROLE_INACTIVE_EXPIRED
        : null;

    if (!bucketName || !s3Key || !deleteReason) {
      summary.skipped += 1;
      continue;
    }
    if (bucketName !== expectedBucket) {
      summary.skipped += 1;
      logger.warn('[recording-cleanup] bucket_mismatch_skipped', {
        interview_id: row.id
      });
      continue;
    }

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: s3Key }));
    } catch (err) {
      const sanitized = sanitizeError(err);
      summary.failed += 1;
      logger.error('[recording-cleanup] delete_failed', {
        interview_id: row.id,
        reason: deleteReason,
        error: sanitized
      });
      const { error: updateErr } = await db
        .from('interviews')
        .update({
          recording_status: 'delete_failed',
          recording_delete_error: sanitized
        })
        .eq('id', row.id)
        .eq('recording_status', 'ready');
      if (updateErr) {
        logger.error('[recording-cleanup] delete_failed_status_update_failed', {
          interview_id: row.id,
          error: sanitizeError(updateErr)
        });
      }
      continue;
    }

    const { error: updateErr } = await db
      .from('interviews')
      .update({
        recording_status: 'deleted',
        recording_deleted_at: new Date().toISOString(),
        recording_delete_reason: deleteReason,
        recording_delete_error: null,
        recording_expires_at: null
      })
      .eq('id', row.id)
      .eq('recording_status', 'ready');
    if (updateErr) {
      summary.failed += 1;
      logger.error('[recording-cleanup] deleted_status_update_failed', {
        interview_id: row.id,
        error: sanitizeError(updateErr)
      });
      continue;
    }
    summary.deleted += 1;
  }

  logger.log('[recording-cleanup] end', summary);
  return summary;
}

module.exports = {
  cleanupNoSubstantiveRecordings,
  isNoSubstantiveInterview
};
