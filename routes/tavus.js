'use strict';

const express = require('express');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { tavusHttpClient: defaultTavusHttpClient } = require('../src/lib/tavusHttpClient');
const {
  decodeTelemetryAuthorization,
  diagnosticDedupeKey,
  validateTelemetryPayload,
} = require('../src/lib/interviewReliabilityDiagnostics');

const router = express.Router();
let activeTavusHttpClient = defaultTavusHttpClient;
const EARLY_END_GRACE_MS = 15000;
const EARLY_END_WINDOW_MS = 20 * 60 * 1000;
const EARLY_END_SUMMARY = 'Interview ended before substantive responses were captured.';
const EARLY_END_TRANSCRIPT_SCORES = {
  overall: null,
  role_fit: null,
  technical_strength: null,
  communication_quality: null,
  confidence: 0,
  ai_aided_risk: 'low',
  ai_aided_risk_reason: 'No substantive interview response was available to assess.'
};
const END_REASON_MAP = Object.freeze({
  manual: 'candidate_ended',
  candidate_ended: 'candidate_ended',
  tool_call: 'vendor_end_event',
  ended_payload: 'vendor_end_event',
  vendor_end_event: 'vendor_end_event',
  closing_utterance: 'completed_normally',
  completed_normally: 'completed_normally',
  time_limit_warning: 'completed_normally',
  time_limit_graceful_close: 'completed_normally',
  time_limit_force_close: 'completed_normally',
  progress_stalled: 'watchdog_timeout',
  watchdog_timeout: 'watchdog_timeout',
  disconnected: 'reconnect_failed',
  reconnect_failed: 'reconnect_failed',
  browser_closed: 'browser_closed_or_navigation',
  browser_closed_or_navigation: 'browser_closed_or_navigation',
});

function normalizeEndReason(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'manual';
  const normalized = raw.replace(/[^a-z0-9_-]+/g, '_').slice(0, 80);
  return END_REASON_MAP[normalized] || 'vendor_end_event';
}

function isIdempotentEndState(status, currentEndReason, requestedEndReason) {
  const currentStatus = String(status || '').trim().toLowerCase();
  const storedReason = String(currentEndReason || '').trim().toLowerCase();
  const requestedReason = String(requestedEndReason || '').trim().toLowerCase();
  if (new Set([
    'analyzed',
    'complete',
    'completed',
    'ended',
    'readyforanalysis',
    'transcribed',
    'transcriptionreceived',
  ]).has(currentStatus)) {
    return true;
  }
  return currentStatus === 'ending_requested'
    && Boolean(storedReason)
    && storedReason === requestedReason;
}

function hasNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAnalysisData(value) {
  if (!value) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return trimmed !== '{}' && trimmed !== '[]';
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

router.post('/end-conversation', express.json({ limit: '1mb' }), async (req, res) => {
  const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
  try {
    const conversation_id = typeof req.body?.conversation_id === 'string' ? req.body.conversation_id.trim() : '';
    const interview_id = typeof req.body?.interview_id === 'string' ? req.body.interview_id.trim() : '';
    const role_token = typeof req.body?.role_token === 'string' ? req.body.role_token.trim() : '';
    const reason = normalizeEndReason(req.body?.reason);
    const isTimeLimitEnd = reason === 'completed_normally';
    const isFailureEnd = reason === 'watchdog_timeout' || reason === 'reconnect_failed';
    const failureCode = reason === 'watchdog_timeout' ? 'INTERVIEW_PROGRESS_STALLED' : 'INTERVIEW_DISCONNECTED';
    const failureSummary = reason === 'watchdog_timeout'
      ? 'The live interview stopped progressing after one automatic reconnect attempt.'
      : 'The live interview disconnected and could not reconnect.';
    if (!conversation_id || !interview_id || !role_token) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'MISSING_REQUIRED_PARAMS',
        detail: 'conversation_id, interview_id, and role_token are required',
        hint: null,
        request_id
      });
    }

    const { data: role, error: roleError } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('slug_or_token', role_token)
      .maybeSingle();

    if (roleError) {
      return res.status(500).json({
        error: 'server_error',
        code: 'ROLE_LOOKUP_FAILED',
        detail: roleError.message || 'Failed to load role',
        hint: roleError.hint || null,
        request_id
      });
    }
    if (!role) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found',
        hint: null,
        request_id
      });
    }

    const { data: interview, error: interviewError } = await supabaseAdmin
      .from('interviews')
      .select('id, role_id, tavus_application_id, status, client_end_reason')
      .eq('id', interview_id)
      .maybeSingle();

    if (interviewError) {
      return res.status(500).json({
        error: 'server_error',
        code: 'INTERVIEW_LOOKUP_FAILED',
        detail: interviewError.message || 'Failed to load interview',
        hint: interviewError.hint || null,
        request_id
      });
    }
    if (!interview) {
      return res.status(404).json({
        error: 'not_found',
        code: 'INTERVIEW_NOT_FOUND',
        detail: 'Interview not found',
        hint: null,
        request_id
      });
    }

    if (
      String(interview.role_id || '') !== String(role.id || '') ||
      String(interview.tavus_application_id || '') !== conversation_id
    ) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'INTERVIEW_BINDING_MISMATCH',
        detail: 'Interview does not match supplied role_token and conversation_id',
        hint: null,
        request_id
      });
    }

    if (isIdempotentEndState(interview.status, interview.client_end_reason, reason)) {
      return res.json({ ok: true, duplicate: true, request_id });
    }

    const apiKey = String(process.env.TAVUS_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(500).json({
        error: 'server_error',
        code: 'MISSING_TAVUS_API_KEY',
        detail: 'TAVUS_API_KEY is not set',
        hint: null,
        request_id
      });
    }

    try {
      await activeTavusHttpClient.endConversation(conversation_id);
    } catch (e) {
      const upstreamStatus = e?.status;
      const detail = 'Tavus could not end the conversation.';
      console.error('[tavus/end-conversation] tavus_end_failed', {
        request_id,
        reason,
        status: upstreamStatus,
        providerCode: e?.providerCode || null,
        category: e?.category || 'provider_error',
        attemptCount: Number.isInteger(e?.attemptCount) ? e.attemptCount : 1,
        timeout: e?.timeout === true,
      });
      if (isFailureEnd) {
        await supabaseAdmin
          .from('interviews')
          .update({
            status: 'Incomplete',
            failure_code: failureCode,
            failure_stage: 'live_interview',
            failure_summary: failureSummary,
            failure_at: new Date().toISOString(),
            retryable: true,
            replacement_eligible: true,
            client_end_reason: reason,
            updated_at: new Date().toISOString()
          })
          .eq('id', interview.id);
      }
      return res.status(upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 502).json({
        error: 'upstream_error',
        code: 'TAVUS_END_FAILED',
        detail,
        hint: null,
        request_id
      });
    }

    const statusUpdate = isFailureEnd
      ? {
          status: 'Incomplete',
          failure_code: failureCode,
          failure_stage: 'live_interview',
          failure_summary: failureSummary,
          failure_at: new Date().toISOString(),
          retryable: true,
          replacement_eligible: true,
          client_end_reason: reason,
          updated_at: new Date().toISOString()
        }
      : {
        status: 'ending_requested',
        client_end_reason: reason,
          updated_at: new Date().toISOString()
        };
    const { data: updatedInterview, error: updateError } = await supabaseAdmin
      .from('interviews')
      .update(statusUpdate)
      .eq('tavus_application_id', conversation_id)
      .select('id, status')
      .maybeSingle();

    if (updateError) {
      console.error('[tavus/end-conversation] status_update_failed', {
        request_id,
        conversation_id,
        reason,
        code: updateError.code,
        detail: updateError.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'INTERVIEW_STATUS_UPDATE_FAILED',
        detail: updateError.message,
        hint: updateError.hint || null,
        request_id
      });
    }

    if (updatedInterview?.id && !isTimeLimitEnd && !isFailureEnd) {
      const interviewId = updatedInterview.id;
      setTimeout(async () => {
        try {
          const { data: fresh, error: freshError } = await supabaseAdmin
            .from('interviews')
            .select('id,candidate_id,role_id,status,created_at,transcript,analysis,interview_summary')
            .eq('id', interviewId)
            .maybeSingle();

          if (freshError) {
            console.error('[tavus/end-conversation] early_end_reconcile_read_failed', {
              request_id,
              interview_id: interviewId,
              reason,
              code: freshError.code,
              detail: freshError.message
            });
            return;
          }
          if (!fresh) return;

          const status = String(fresh.status || '').toLowerCase();
          const createdAtMs = new Date(fresh.created_at || 0).getTime();
          const isRecent = Number.isFinite(createdAtMs) && (Date.now() - createdAtMs <= EARLY_END_WINDOW_MS);
          const transcriptEmpty = !hasNonEmptyText(fresh.transcript);
          const summaryEmpty = !hasNonEmptyText(fresh.interview_summary);
          const analysisEmpty = !hasAnalysisData(fresh.analysis);
          const shouldFinalizeEarlyEnded =
            status === 'ending_requested' &&
            isRecent &&
            transcriptEmpty &&
            summaryEmpty &&
            analysisEmpty;

          if (!shouldFinalizeEarlyEnded) return;

          const { error: finalizeError } = await supabaseAdmin
            .from('interviews')
            .update({
              status: 'Ended',
              interview_summary: EARLY_END_SUMMARY,
              transcript_scores: EARLY_END_TRANSCRIPT_SCORES,
              updated_at: new Date().toISOString()
            })
            .eq('id', interviewId)
            .eq('status', 'ending_requested');

          if (finalizeError) {
            console.error('[tavus/end-conversation] early_end_reconcile_finalize_failed', {
              request_id,
              interview_id: interviewId,
              reason,
              code: finalizeError.code,
              detail: finalizeError.message
            });
            return;
          }

        } catch (e) {
          console.error('[tavus/end-conversation] early_end_reconcile_unexpected', {
            request_id,
            interview_id: interviewId,
            reason,
            error: e?.message || e
          });
        }
      }, EARLY_END_GRACE_MS);
    } else if (updatedInterview?.id && (isTimeLimitEnd || isFailureEnd)) {
      console.log('[tavus/end-conversation] early_end_reconcile_skipped', {
        request_id,
        interview_id: updatedInterview.id,
        conversation_id,
        reason
      });
    }

    return res.json({ ok: true, request_id });
  } catch (e) {
    console.error('[tavus/end-conversation] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'END_CONVERSATION_FAILED',
      detail: e?.message || 'Failed to end conversation',
      hint: null,
      request_id
    });
  }
});

function createClientTelemetryHandler({
  database = supabaseAdmin,
  now = () => new Date().toISOString(),
  warn = (category) => console.warn('[tavus/client-telemetry] bounded_failure', { category }),
} = {}) {
  return async (req, res) => {
    const validation = validateTelemetryPayload(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: 'bad_request', code: validation.code });
    }
    if (!database) {
      warn('database_unavailable');
      return res.status(503).json({ error: 'temporary_service_error', code: 'CLIENT_TELEMETRY_UNAVAILABLE' });
    }

    const telemetry = validation.telemetry;
    const headerBinding = decodeTelemetryAuthorization(req.headers?.authorization);
    const roleToken = headerBinding?.roleToken || telemetry.roleToken;
    const conversationId = headerBinding?.conversationId || telemetry.conversationId;
    if (!roleToken || !conversationId) {
      return res.status(400).json({ error: 'bad_request', code: 'MISSING_TELEMETRY_BINDING' });
    }
    if (
      headerBinding &&
      (
        (telemetry.roleToken && telemetry.roleToken !== headerBinding.roleToken) ||
        (telemetry.conversationId && telemetry.conversationId !== headerBinding.conversationId)
      )
    ) {
      return res.status(403).json({ error: 'forbidden', code: 'INTERVIEW_BINDING_MISMATCH' });
    }
    try {
      const roleLookup = await database
        .from('roles')
        .select('id')
        .eq('slug_or_token', roleToken)
        .maybeSingle();
      if (roleLookup.error) {
        warn('role_lookup_failed');
        return res.status(503).json({ error: 'temporary_service_error', code: 'CLIENT_TELEMETRY_UNAVAILABLE' });
      }
      const role = roleLookup.data;

      const { data: interview, error: interviewError } = await database
        .from('interviews')
        .select('id,role_id,client_id,candidate_id,attempt_number,tavus_application_id,reconnect_attempt_count')
        .eq('id', telemetry.interviewId)
        .maybeSingle();
      if (interviewError) {
        warn('interview_lookup_failed');
        return res.status(503).json({ error: 'temporary_service_error', code: 'CLIENT_TELEMETRY_UNAVAILABLE' });
      }
      if (
        !role ||
        !interview ||
        !interview.client_id ||
        !interview.candidate_id ||
        !Number.isInteger(Number(interview.attempt_number)) ||
        String(interview.role_id) !== String(role.id) ||
        String(interview.tavus_application_id) !== conversationId
      ) {
        return res.status(403).json({ error: 'forbidden', code: 'INTERVIEW_BINDING_MISMATCH' });
      }

      const receivedAt = now();
      const { error: insertError } = await database
        .from('interview_lifecycle_events')
        .insert({
          interview_id: interview.id,
          client_id: interview.client_id,
          event_type: `client.${telemetry.event}`,
          vendor_event_id: null,
          dedupe_key: diagnosticDedupeKey(telemetry.eventSequence, telemetry.observedAt),
          speaker_role: 'system',
          utterance_classification: null,
          observed_at: telemetry.observedAt,
          received_at: receivedAt,
          metadata: {
            ...telemetry.metadata,
            event_sequence: telemetry.eventSequence,
          },
        });

      if (insertError?.code === '23505') {
        return res.json({ ok: true, duplicate: true });
      }
      if (insertError) {
        warn('lifecycle_persist_failed');
        return res.status(503).json({ error: 'temporary_service_error', code: 'CLIENT_TELEMETRY_UNAVAILABLE' });
      }

      // Preserve the pre-existing Phase B summary fields for legacy events.
      const update = {};
      if (telemetry.event === 'watchdog_timeout') update.watchdog_no_progress_at = receivedAt;
      if (telemetry.event === 'reconnect_attempted') {
        update.reconnect_attempted = true;
        update.reconnect_attempt_count = Math.min(1, Number(interview.reconnect_attempt_count || 0) + 1);
      }
      if (telemetry.event === 'reconnect_succeeded' || telemetry.event === 'reconnect_failed') {
        update.reconnect_result = telemetry.event;
      }
      if (telemetry.event === 'browser_closed_or_navigation') {
        update.client_end_reason = 'browser_closed_or_navigation';
      }
      if (
        telemetry.reason &&
        (
          telemetry.event === 'watchdog_timeout' ||
          telemetry.event === 'reconnect_attempted' ||
          telemetry.event === 'reconnect_succeeded' ||
          telemetry.event === 'reconnect_failed' ||
          telemetry.event === 'browser_closed_or_navigation'
        )
      ) {
        update.client_end_reason = telemetry.reason;
      }

      if (Object.keys(update).length > 0) {
        update.updated_at = receivedAt;
        const { error: updateError } = await database
          .from('interviews')
          .update(update)
          .eq('id', interview.id);
        if (updateError) {
          warn('legacy_summary_update_failed');
          return res.status(503).json({ error: 'temporary_service_error', code: 'CLIENT_TELEMETRY_UNAVAILABLE' });
        }
      }

      return res.json({ ok: true, duplicate: false });
    } catch {
      warn('unexpected_failure');
      return res.status(503).json({ error: 'temporary_service_error', code: 'CLIENT_TELEMETRY_UNAVAILABLE' });
    }
  };
}

// Diagnostic delivery is best effort and separate from interview control.
router.post(
  '/client-telemetry',
  express.json({ limit: '8kb' }),
  createClientTelemetryHandler(),
);

module.exports = router;
router._setTavusHttpClientForTest = (client) => {
  activeTavusHttpClient = client || defaultTavusHttpClient;
};
module.exports.createClientTelemetryHandler = createClientTelemetryHandler;
module.exports.isIdempotentEndState = isIdempotentEndState;
