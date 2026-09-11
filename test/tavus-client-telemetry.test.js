'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
const {
  METADATA_KEYS,
  TELEMETRY_EVENTS,
  decodeTelemetryAuthorization,
  diagnosticDedupeKey,
  validateTelemetryPayload,
} = require('../src/services/interviewReliabilityDiagnostics');
const { createClientTelemetryHandler, isIdempotentEndState } = require('../src/routes/public/tavus');

const BASE_PAYLOAD = Object.freeze({
  interview_id: '00000000-0000-4000-8000-000000000001',
  conversation_id: 'synthetic-provider-binding',
  role_token: 'synthetic-role-token',
  event: 'reconnect_started',
  event_sequence: 1,
  observed_at: '2026-07-28T02:00:00.000Z',
  reason: 'watchdog_timeout',
  metadata: {
    recovery_attempt: 1,
    recovery_phase: 'reconnecting_transport',
    progress_age_ms: 45000,
    is_recovery_active: true,
  },
});

const AUTHORIZATION = `AlphaScreen-Telemetry ${Buffer.from(JSON.stringify([
  BASE_PAYLOAD.role_token,
  BASE_PAYLOAD.conversation_id,
])).toString('base64')}`;

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createFakeDatabase(options = {}) {
  const state = {
    inserts: [],
    updates: [],
    role: options.role || { id: 'role-id' },
    interview: options.interview || {
      id: BASE_PAYLOAD.interview_id,
      role_id: 'role-id',
      client_id: 'client-id',
      candidate_id: 'candidate-id',
      attempt_number: 2,
      tavus_application_id: BASE_PAYLOAD.conversation_id,
      reconnect_attempt_count: 0,
    },
  };

  return {
    state,
    from(table) {
      const query = {
        action: 'select',
        payload: null,
        filters: {},
        select() {
          this.action = 'select';
          return this;
        },
        update(payload) {
          this.action = 'update';
          this.payload = payload;
          return this;
        },
        eq(key, value) {
          this.filters[key] = value;
          if (this.action === 'update') {
            state.updates.push({ table, payload: this.payload, filters: this.filters });
            return Promise.resolve({ error: options.updateError || null });
          }
          return this;
        },
        maybeSingle() {
          if (table === 'roles') {
            return Promise.resolve({ data: state.role, error: options.roleError || null });
          }
          if (table === 'interviews') {
            return Promise.resolve({ data: state.interview, error: options.interviewError || null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert(payload) {
          state.inserts.push({ table, payload });
          return Promise.resolve({ error: options.insertError || null });
        },
      };
      return query;
    },
  };
}

test('diagnostic contract exposes only the bounded event and metadata allowlists', () => {
  for (const event of [
    'closing_terminal_reserved',
    'closing_candidate_audio_unpublish_requested',
    'closing_foreign_pal_audio_muted',
    'closing_interrupt_dispatched',
    'closing_farewell_dispatched',
    'closing_farewell_dispatch_failed',
    'closing_farewell_started',
    'closing_farewell_completed',
    'closing_foreign_inference_suppressed',
    'closing_farewell_interrupted',
    'closing_farewell_start_timed_out',
    'closing_farewell_completion_timed_out',
  ]) {
    assert.equal(TELEMETRY_EVENTS.has(event), true, event);
  }
  assert.equal(TELEMETRY_EVENTS.has('local_closing_reserved'), true);
  assert.equal(TELEMETRY_EVENTS.has('remote_pal_audio_muted'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_audio_unpublish_requested'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_closing_audio_primed'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_closing_audio_prime_failed'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_closing_audio_play_requested'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_closing_audio_started'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_closing_audio_completed'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_closing_audio_play_failed'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_closing_navigation_fallback'), true);
  assert.equal(TELEMETRY_EVENTS.has('reconnect_started'), true);
  assert.equal(TELEMETRY_EVENTS.has('interview_terminal_requested'), true);
  assert.equal(TELEMETRY_EVENTS.has('question_lock_entered'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_only_entered'), true);
  assert.equal(TELEMETRY_EVENTS.has('wind_down_entered'), true);
  assert.equal(TELEMETRY_EVENTS.has('wind_down_forced_interrupt'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_forced_interrupt'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_question_invitation_sent'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_question_invitation_skipped'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_question_received'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_question_response_completed'), true);
  assert.equal(TELEMETRY_EVENTS.has('final_farewell_eligible'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_farewell_reserved'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_farewell_started'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_farewell_completed'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_farewell_interrupted'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_farewell_completion_timeout'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_candidate_audio_lock_requested'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_candidate_audio_lock_waiting'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_candidate_audio_locked'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_candidate_audio_lock_failed'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_candidate_audio_lock_timed_out'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_candidate_audio_lock_cancelled'), true);
  assert.equal(TELEMETRY_EVENTS.has('closing_candidate_activity_suppressed'), true);
  assert.equal(TELEMETRY_EVENTS.has('termination_only_entered'), true);
  assert.equal(TELEMETRY_EVENTS.has('provider_end_requested'), true);
  assert.equal(TELEMETRY_EVENTS.has('provider_end_confirmed'), true);
  assert.equal(TELEMETRY_EVENTS.has('post_closing_question_violation'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_inactivity_nudge_armed'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_inactivity_nudge_cancelled'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_inactivity_nudge_sent'), true);
  assert.equal(TELEMETRY_EVENTS.has('candidate_inactivity_nudge_suppressed'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_media_preflight_result'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_audio_level_state_changed'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_audio_recovery_requested'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_audio_recovery_succeeded'), true);
  assert.equal(TELEMETRY_EVENTS.has('local_audio_recovery_failed'), true);
  assert.equal(TELEMETRY_EVENTS.has('transcript_received'), false);
  assert.equal(METADATA_KEYS.has('remote_audio_state'), true);
  assert.equal(METADATA_KEYS.has('message'), false);
  assert.equal(METADATA_KEYS.has('conversation_id'), false);
});

test('local media diagnostics accept coarse states and reject device or audio content', () => {
  const cases = [
    ['local_media_preflight_result', {
      local_media_permission_state: 'granted',
      local_audio_level_state: 'ready',
      local_audio_track_live: true,
      local_video_track_live: true,
      input_level_detected: true,
      preflight_override: false,
      audio_processing_requested: true,
    }],
    ['local_audio_level_state_changed', {
      local_audio_level_state: 'low',
      local_audio_track_live: true,
      input_level_detected: false,
    }],
    ['local_audio_recovery_requested', {
      local_audio_level_state: 'silent',
      local_audio_recovery_result: 'requested',
      audio_processing_requested: true,
    }],
    ['local_audio_recovery_succeeded', {
      local_audio_level_state: 'ready',
      local_audio_recovery_result: 'succeeded',
      audio_processing_result: 'applied',
      local_audio_track_live: true,
    }],
    ['local_audio_recovery_failed', {
      local_audio_level_state: 'unavailable',
      local_audio_recovery_result: 'failed',
      audio_processing_result: 'failed',
      local_audio_track_live: false,
    }],
  ];

  for (const [index, [event, metadata]] of cases.entries()) {
    const result = validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event,
      event_sequence: 975 + index,
      reason: undefined,
      metadata,
    });
    assert.equal(result.ok, true, `${event}:${result.code || 'ok'}`);
  }

  for (const metadata of [
    { device_id: 'sensitive-device-id' },
    { device_label: 'Jason microphone' },
    { exact_audio_level: 0.012345 },
    { transcript: 'synthetic voice content' },
  ]) {
    assert.equal(validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event: 'local_audio_level_state_changed',
      event_sequence: 990,
      reason: undefined,
      metadata,
    }).ok, false);
  }
});

test('startup-readiness and remote-media telemetry accepts only the bounded canonical contract', () => {
  for (const event of [
    'daily_remote_participant_snapshot',
    'daily_remote_track_state_changed',
    'daily_receive_settings_snapshot',
    'remote_video_attachment_result',
    'reconnect_media_binding_snapshot',
    'startup_readiness_changed',
  ]) assert.equal(TELEMETRY_EVENTS.has(event), true, event);

  const snapshot = validateTelemetryPayload({
    ...BASE_PAYLOAD,
    event: 'daily_remote_participant_snapshot',
    metadata: {
      remote_participant_count_bucket: 'one',
      local_remote_classification: 'all_non_local_as_replica',
      audio_track_state: 'playable',
      video_track_state: 'loading',
      audio_persistent_track_present: true,
      video_persistent_track_present: true,
      audio_subscription_state: 'subscribed',
      video_subscription_state: 'staged',
      startup_readiness_state: 'remote_video_loading',
      reconnect_phase: 'idle',
      snapshot_reason: 'participant_updated',
    },
  });
  assert.equal(snapshot.ok, true);

  const attachment = validateTelemetryPayload({
    ...BASE_PAYLOAD,
    event_sequence: 2,
    event: 'remote_video_attachment_result',
    metadata: {
      video_attachment_result: 'play_rejected_policy',
      video_track_state: 'playable',
      element_ready_state_bucket: 'metadata',
      element_visible: true,
      element_size_bucket: 'nonzero',
      reconnect_active: false,
      elapsed_since_join_bucket: 'under_15_seconds',
      startup_readiness_state: 'remote_video_playable',
    },
  });
  assert.equal(attachment.ok, true);

  const raw = validateTelemetryPayload({
    ...BASE_PAYLOAD,
    event_sequence: 3,
    event: 'daily_remote_track_state_changed',
    metadata: { track_id: 'forbidden' },
  });
  assert.deepEqual(raw, { ok: false, code: 'UNKNOWN_TELEMETRY_METADATA' });
});

test('zero-deadline local closing diagnostics accept only bounded metadata', () => {
  const cases = [
    ['local_closing_reserved', { closing_state: 'LOCAL_CLOSING', remaining_time_bucket: '0_10' }],
    ['remote_pal_audio_muted', {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      mute_result_category: 'muted_detached',
    }],
    ['candidate_audio_unpublish_requested', {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      candidate_unpublish_result_category: 'requested',
    }],
    ['local_closing_audio_primed', {
      closing_state: 'INTERVIEWING',
      playback_result_category: 'primed',
      audio_duration_bucket: '4_5_seconds',
    }],
    ['local_closing_audio_prime_failed', {
      closing_state: 'INTERVIEWING',
      playback_result_category: 'prime_failed',
      audio_duration_bucket: '4_5_seconds',
    }],
    ['local_closing_audio_play_requested', {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      playback_result_category: 'requested',
      audio_duration_bucket: '4_5_seconds',
    }],
    ['local_closing_audio_started', {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      playback_result_category: 'started',
      audio_duration_bucket: '4_5_seconds',
    }],
    ['local_closing_audio_completed', {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      playback_result_category: 'completed',
      audio_duration_bucket: '4_5_seconds',
    }],
    ['local_closing_audio_play_failed', {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      playback_result_category: 'play_failed',
      audio_duration_bucket: '4_5_seconds',
    }],
    ['local_closing_navigation_fallback', {
      closing_state: 'COMPLETE',
      remaining_time_bucket: '0_10',
      fallback_reason: 'playback_stalled',
    }],
    ['provider_end_requested', {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      hard_deadline: true,
      provider_end_result_category: 'requested',
    }],
    ['provider_end_confirmed', {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      hard_deadline: true,
      provider_end_result_category: 'confirmed',
    }],
  ];
  for (const [index, [event, metadata]] of cases.entries()) {
    const result = validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event,
      event_sequence: 800 + index,
      reason: undefined,
      metadata,
    });
    assert.equal(result.ok, true, event);
  }

  for (const metadata of [
    { closing_text: 'synthetic' },
    { transcript: 'synthetic' },
    { provider_conversation_id: 'synthetic' },
    { participant_id: 'synthetic' },
    { room_url: 'https://example.invalid' },
    { file_path: '/synthetic/path' },
    { playback_result_category: 'raw_exception' },
    { fallback_reason: 'raw_media_failure' },
  ]) {
    assert.equal(validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event: 'local_closing_audio_play_failed',
      event_sequence: 850,
      reason: undefined,
      metadata,
    }).ok, false);
  }
});

test('terminal closing diagnostics accept the canonical bounded contract and reject content', () => {
  const cases = [
    ['closing_terminal_reserved', {
      closing_state: 'CLOSING_RESERVED',
      duplicate_suppression_category: 'none',
      remaining_time_bucket: '0_10',
    }],
    ['closing_candidate_audio_unpublish_requested', {
      closing_state: 'CLOSING_RESERVED',
      candidate_unpublish_result_category: 'requested',
      remaining_time_bucket: '0_10',
    }],
    ['closing_foreign_pal_audio_muted', {
      closing_state: 'FOREIGN_PAL_AUDIO_MUTED',
      mute_result_category: 'muted_detached',
      remaining_time_bucket: '0_10',
    }],
    ['closing_interrupt_dispatched', {
      closing_state: 'FOREIGN_PAL_AUDIO_MUTED',
      dispatch_result_category: 'sent',
      remaining_time_bucket: '0_10',
    }],
    ['closing_farewell_dispatched', {
      closing_state: 'FAREWELL_DISPATCHED',
      dispatch_result_category: 'sent',
      remaining_time_bucket: '0_10',
    }],
    ['closing_farewell_dispatch_failed', {
      closing_state: 'FOREIGN_PAL_AUDIO_MUTED',
      dispatch_result_category: 'failed',
      remaining_time_bucket: '0_10',
    }],
    ['closing_farewell_started', {
      closing_state: 'FAREWELL_AUDIBLE',
      inference_match: true,
      speech_result_category: 'started',
      remote_audio_state_category: 'audible',
      remaining_time_bucket: '0_10',
    }],
    ['closing_foreign_inference_suppressed', {
      closing_state: 'FAREWELL_AUDIBLE',
      inference_match: false,
      remote_audio_state_category: 'remuted',
      provider_end_reason: 'foreign_inference_conflict',
      remaining_time_bucket: '0_10',
    }],
    ['closing_farewell_start_timed_out', {
      closing_state: 'FAREWELL_DISPATCHED',
      timeout_category: 'farewell_start',
      remaining_time_bucket: '0_10',
    }],
    ['closing_farewell_completion_timed_out', {
      closing_state: 'FAREWELL_AUDIBLE',
      timeout_category: 'farewell_completion',
      remaining_time_bucket: '0_10',
    }],
    ['closing_farewell_completed', {
      closing_state: 'FAREWELL_AUDIBLE',
      inference_match: true,
      speech_interrupted: false,
      speech_result_category: 'completed',
      remaining_time_bucket: '0_10',
    }],
    ['closing_farewell_interrupted', {
      closing_state: 'FAREWELL_AUDIBLE',
      inference_match: true,
      speech_interrupted: true,
      remote_audio_state_category: 'remuted',
      remaining_time_bucket: '0_10',
    }],
    ['provider_end_requested', {
      closing_state: 'PROVIDER_END_REQUESTED',
      provider_end_result_category: 'requested',
      provider_end_reason: 'farewell_completed',
      remaining_time_bucket: '0_10',
    }],
    ['provider_end_confirmed', {
      closing_state: 'PROVIDER_END_REQUESTED',
      provider_end_result_category: 'unconfirmed',
      provider_end_reason: 'observer_reload',
      remaining_time_bucket: '0_10',
    }],
  ];
  for (const [index, [event, metadata]] of cases.entries()) {
    const result = validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event,
      event_sequence: 900 + index,
      reason: undefined,
      metadata,
    });
    assert.equal(result.ok, true, `${event}:${result.code || 'ok'}`);
  }

  for (const metadata of [
    { inference_id: 'synthetic' },
    { farewell_text: 'synthetic' },
    { provider_conversation_id: 'synthetic' },
    { participant_id: 'synthetic' },
    { room_url: 'https://example.invalid' },
    { raw_event: 'synthetic' },
  ]) {
    assert.equal(validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event: 'closing_farewell_started',
      event_sequence: 950,
      reason: undefined,
      metadata,
    }).ok, false);
  }
});

test('final-closing audio lock diagnostics accept only bounded publication metadata', () => {
  for (const [index, [event, lock_result_category]] of [
    ['closing_candidate_audio_lock_requested', 'requested'],
    ['closing_candidate_audio_lock_waiting', 'requested'],
    ['closing_candidate_audio_locked', 'confirmed_disabled'],
    ['closing_candidate_audio_lock_failed', 'definite_failure'],
    ['closing_candidate_audio_lock_timed_out', 'timed_out'],
    ['closing_candidate_audio_lock_cancelled', 'cancelled_terminal'],
  ].entries()) {
    const result = validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event,
      event_sequence: 700 + index,
      reason: undefined,
      metadata: {
        closing_state: 'FINAL_FAREWELL_ELIGIBLE',
        remaining_time_bucket: '11_30',
        lock_result_category,
        audio_publication_enabled: event === 'closing_candidate_audio_lock_failed',
        attempt_count: Math.min(2, index),
        confirmation_source: event === 'closing_candidate_audio_locked'
          ? 'participant_updated'
          : 'none',
        publication_state: event === 'closing_candidate_audio_locked'
          ? 'off'
          : event === 'closing_candidate_audio_lock_failed'
            ? 'enabled'
            : 'unknown',
        elapsed_time_bucket: 'under_250',
        ...(event === 'closing_candidate_audio_lock_timed_out'
          ? { timeout_category: 'bounded_timeout' }
          : {}),
        reconnect_active: false,
      },
    });
    assert.equal(result.ok, true, event);
  }
  assert.equal(validateTelemetryPayload({
    ...BASE_PAYLOAD,
    event: 'closing_candidate_activity_suppressed',
    event_sequence: 710,
    reason: undefined,
    metadata: {
      closing_state: 'FINAL_FAREWELL_ELIGIBLE',
      remaining_time_bucket: '11_30',
      suppression_reason: 'final_closing_audio_lock',
    },
  }).ok, true);

  for (const metadata of [
    { utterance: 'synthetic' },
    { participant_id: 'synthetic' },
    { provider_conversation_id: 'synthetic' },
    { lock_result_category: 'raw_daily_failure' },
    { attempt_count: 3 },
    { suppression_reason: 'synthetic-sensitive-reason' },
    { confirmation_source: 'raw_daily_event' },
    { publication_state: 'SECRET_TRACK_STATE' },
    { elapsed_time_bucket: '1800_exact' },
    { timeout_category: 'raw_timeout_reason' },
  ]) {
    assert.equal(validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event: 'closing_candidate_audio_lock_failed',
      event_sequence: 720,
      reason: undefined,
      metadata,
    }).ok, false);
  }
});

test('inactivity diagnostics accept only bounded lifecycle metadata', () => {
  for (const [index, event] of [
    'candidate_inactivity_nudge_armed',
    'candidate_inactivity_nudge_cancelled',
    'candidate_inactivity_nudge_sent',
    'candidate_inactivity_nudge_suppressed',
  ].entries()) {
    const result = validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event,
      event_sequence: 500 + index,
      reason: undefined,
      metadata: {
        threshold_ms: 10_000,
        turn_sequence: index + 1,
        inactivity_state: event.endsWith('_sent')
          ? 'WAITING_FOR_CANDIDATE_AFTER_NUDGE'
          : 'ARMED_AFTER_PAL_TURN',
        inactivity_reason: event.endsWith('_cancelled') ? 'candidate_speaking' : 'ambiguous_state',
        timer_lateness_bucket: 'on_time',
        ownership_mode: 'application_inactivity',
        candidate_speaking: false,
        reconnect_active: false,
        transport_healthy: true,
        replica_present: true,
        remote_audio_ready: true,
        runtime_owner: true,
      },
    });
    assert.equal(result.ok, true, event);
  }

  for (const metadata of [
    { transcript: 'synthetic' },
    { utterance: 'synthetic' },
    { candidate_id: 'synthetic' },
    { conversation_id: 'synthetic' },
    { provider_id: 'synthetic' },
    { ownership_mode: 'request_override' },
    { timer_lateness_bucket: '2750ms' },
  ]) {
    assert.equal(validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event: 'candidate_inactivity_nudge_suppressed',
      event_sequence: 600,
      reason: undefined,
      metadata,
    }).ok, false);
  }
});

test('provider-end state suppresses repeated terminal requests without masking a different active failure', () => {
  assert.equal(isIdempotentEndState('ending_requested', 'completed_normally', 'completed_normally'), true);
  assert.equal(isIdempotentEndState('ReadyForAnalysis', null, 'completed_normally'), true);
  assert.equal(isIdempotentEndState('Ended', 'candidate_ended', 'completed_normally'), true);
  assert.equal(isIdempotentEndState('started', null, 'completed_normally'), false);
  assert.equal(isIdempotentEndState('ending_requested', 'completed_normally', 'reconnect_failed'), false);
});

test('closing diagnostics accept only bounded state, time, turn, and interruption metadata', () => {
  const events = [
    'question_lock_entered',
    'closing_only_entered',
    'wind_down_entered',
    'wind_down_forced_interrupt',
    'closing_forced_interrupt',
    'candidate_question_invitation_sent',
    'candidate_question_invitation_skipped',
    'candidate_question_received',
    'candidate_question_response_completed',
    'final_farewell_eligible',
    'closing_farewell_reserved',
    'closing_farewell_started',
    'closing_farewell_completed',
    'closing_farewell_interrupted',
    'closing_farewell_completion_timeout',
    'termination_only_entered',
    'provider_end_requested',
    'provider_end_confirmed',
    'post_closing_question_violation',
  ];
  for (const [index, event] of events.entries()) {
    const result = validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event,
      event_sequence: index + 100,
      reason: undefined,
      metadata: {
        closing_state: event === 'provider_end_confirmed'
          ? 'ENDED'
          : event === 'wind_down_entered'
            ? 'WIND_DOWN_ONLY'
            : event === 'wind_down_forced_interrupt'
              ? 'FORCED_WIND_DOWN'
              : event === 'final_farewell_eligible'
                ? 'FINAL_FAREWELL_ELIGIBLE'
                : 'CLOSING_ONLY',
        remaining_time_bucket: '11_30',
        turn_index: index,
        ...(event === 'post_closing_question_violation' ? { speech_interrupted: true } : {}),
        ...(event === 'provider_end_requested' ? { hard_deadline: false } : {}),
      },
    });
    assert.equal(result.ok, true, event);
  }

  for (const metadata of [
    { question_text: 'synthetic' },
    { transcript: 'synthetic' },
    { inference_id: 'synthetic' },
    { provider_url: 'https://example.invalid' },
    { closing_state: 'closing_only' },
    { remaining_time_bucket: '29_seconds' },
    { turn_index: 10_001 },
  ]) {
    assert.equal(validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event: 'post_closing_question_violation',
      reason: undefined,
      metadata,
    }).ok, false);
  }

  for (const closing_state of [
    'WIND_DOWN_ONLY',
    'FORCED_WIND_DOWN',
    'FINAL_FAREWELL_ELIGIBLE',
  ]) {
    assert.equal(validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event: 'post_closing_question_violation',
      event_sequence: 900,
      reason: undefined,
      metadata: {
        closing_state,
        remaining_time_bucket: '11_30',
        turn_index: 1,
      },
    }).ok, true, closing_state);
  }
});

test('valid telemetry is normalized without arbitrary values', () => {
  const {
    conversation_id: _conversationId,
    role_token: _roleToken,
    ...boundedPayload
  } = BASE_PAYLOAD;
  const result = validateTelemetryPayload(boundedPayload);
  assert.equal(result.ok, true);
  assert.equal(result.telemetry.event, 'reconnect_started');
  assert.deepEqual(result.telemetry.metadata, BASE_PAYLOAD.metadata);
  assert.equal(result.telemetry.conversationId, '');
  assert.equal(result.telemetry.roleToken, '');
});

test('candidate-speaking watchdog transitions use only bounded allowlisted enums', () => {
  const cases = [
    {
      event: 'progress_checkpoint_updated',
      metadata: {
        progress_source: 'candidate_speaking_started',
        watchdog_reset_source: 'progress_checkpoint',
        elapsed_ms: 45000,
        recovery_attempt: 0,
        recovery_phase: 'idle',
        is_recovery_active: false,
      },
    },
    {
      event: 'progress_checkpoint_updated',
      metadata: {
        progress_source: 'candidate_speaking_ended',
        watchdog_reset_source: 'progress_checkpoint',
        elapsed_ms: 60000,
        recovery_attempt: 0,
        recovery_phase: 'idle',
        is_recovery_active: false,
      },
    },
    {
      event: 'watchdog_deadline_evaluated',
      metadata: {
        watchdog_evaluation: 'candidate_speaking_active',
        progress_age_ms: 60000,
        recovery_attempt: 0,
        recovery_phase: 'idle',
        is_recovery_active: false,
      },
    },
    {
      event: 'watchdog_deadline_evaluated',
      metadata: {
        watchdog_evaluation: 'candidate_speaking_protection_expired',
        progress_age_ms: 120000,
        recovery_attempt: 0,
        recovery_phase: 'idle',
        is_recovery_active: false,
      },
    },
  ];

  for (const [index, telemetry] of cases.entries()) {
    const result = validateTelemetryPayload({
      ...BASE_PAYLOAD,
      event_sequence: index + 10,
      reason: undefined,
      ...telemetry,
    });
    assert.equal(result.ok, true, `${telemetry.event}:${telemetry.metadata.progress_source || telemetry.metadata.watchdog_evaluation}`);
    assert.deepEqual(result.telemetry.metadata, telemetry.metadata);
  }
});

test('unknown events, fields, metadata, nested values, and invalid bounds fail closed', () => {
  const cases = [
    [{ ...BASE_PAYLOAD, event: 'raw_provider_payload' }, 'UNKNOWN_TELEMETRY_EVENT'],
    [{ ...BASE_PAYLOAD, candidate_id: 'untrusted' }, 'UNKNOWN_TELEMETRY_FIELD'],
    [{ ...BASE_PAYLOAD, metadata: { message: 'untrusted' } }, 'UNKNOWN_TELEMETRY_METADATA'],
    [{ ...BASE_PAYLOAD, metadata: { remote_audio_state: { raw: true } } }, 'INVALID_TELEMETRY_METADATA'],
    [{ ...BASE_PAYLOAD, metadata: { progress_age_ms: -1 } }, 'INVALID_TELEMETRY_METADATA'],
    [{ ...BASE_PAYLOAD, event_sequence: 0 }, 'INVALID_TELEMETRY_SEQUENCE'],
  ];
  for (const [payload, expectedCode] of cases) {
    assert.deepEqual(validateTelemetryPayload(payload), { ok: false, code: expectedCode });
  }
});

test('oversized metadata fails closed', () => {
  const result = validateTelemetryPayload({
    ...BASE_PAYLOAD,
    metadata: { remote_audio_state: `playable${'x'.repeat(3000)}` },
  });
  assert.deepEqual(result, { ok: false, code: 'TELEMETRY_METADATA_TOO_LARGE' });
});

test('handler binds identity server-side and stores no provider binding or role token', async () => {
  const database = createFakeDatabase();
  const handler = createClientTelemetryHandler({
    database,
    now: () => '2026-07-28T02:00:01.000Z',
    warn: () => assert.fail('warning not expected'),
  });
  const res = responseRecorder();
  const {
    conversation_id: _conversationId,
    role_token: _roleToken,
    ...boundedPayload
  } = BASE_PAYLOAD;
  await handler({
    body: boundedPayload,
    headers: { authorization: AUTHORIZATION },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, duplicate: false });
  assert.equal(database.state.inserts.length, 1);
  const stored = database.state.inserts[0].payload;
  assert.equal(stored.interview_id, database.state.interview.id);
  assert.equal(stored.client_id, database.state.interview.client_id);
  assert.equal(stored.event_type, 'client.reconnect_started');
  assert.equal(stored.dedupe_key, diagnosticDedupeKey(1, BASE_PAYLOAD.observed_at));
  assert.equal(stored.metadata.event_sequence, 1);
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes(BASE_PAYLOAD.conversation_id), false);
  assert.equal(serialized.includes(BASE_PAYLOAD.role_token), false);
  assert.equal(serialized.includes(database.state.interview.candidate_id), false);
  assert.deepEqual(decodeTelemetryAuthorization(AUTHORIZATION), {
    roleToken: BASE_PAYLOAD.role_token,
    conversationId: BASE_PAYLOAD.conversation_id,
  });
});

test('received order and bounded client sequence are preserved', async () => {
  const database = createFakeDatabase();
  const times = ['2026-07-28T02:00:01.000Z', '2026-07-28T02:00:02.000Z'];
  const handler = createClientTelemetryHandler({
    database,
    now: () => times.shift(),
    warn: () => assert.fail('warning not expected'),
  });
  await handler({ body: BASE_PAYLOAD }, responseRecorder());
  await handler({
    body: {
      ...BASE_PAYLOAD,
      event: 'reconnect_local_joined',
      event_sequence: 2,
      observed_at: '2026-07-28T02:00:00.500Z',
      reason: undefined,
      metadata: {
        recovery_attempt: 1,
        recovery_phase: 'awaiting_remote_presence',
        recovery_age_ms: 500,
        meeting_state: 'joined',
      },
    },
  }, responseRecorder());

  assert.deepEqual(
    database.state.inserts.map(({ payload }) => [
      payload.received_at,
      payload.metadata.event_sequence,
      payload.event_type,
    ]),
    [
      ['2026-07-28T02:00:01.000Z', 1, 'client.reconnect_started'],
      ['2026-07-28T02:00:02.000Z', 2, 'client.reconnect_local_joined'],
    ],
  );
});

test('duplicate delivery is idempotent and skips legacy summary updates', async () => {
  const database = createFakeDatabase({ insertError: { code: '23505', message: 'sensitive database text' } });
  const handler = createClientTelemetryHandler({
    database,
    warn: () => assert.fail('duplicate must not warn'),
  });
  const res = responseRecorder();
  await handler({
    body: {
      ...BASE_PAYLOAD,
      event: 'reconnect_attempted',
    },
  }, res);
  assert.deepEqual(res.body, { ok: true, duplicate: true });
  assert.equal(database.state.updates.length, 0);
});

test('a new browser document cannot collide with an earlier sequence', () => {
  assert.notEqual(
    diagnosticDedupeKey(1, '2026-07-28T02:00:00.000Z'),
    diagnosticDedupeKey(1, '2026-07-28T02:05:00.000Z'),
  );
});

test('persistence failure is bounded and cannot alter interview state', async () => {
  const warnings = [];
  const database = createFakeDatabase({
    insertError: { code: 'XX000', message: 'raw query URL and secret marker' },
  });
  const handler = createClientTelemetryHandler({
    database,
    warn: (category) => warnings.push(category),
  });
  const res = responseRecorder();
  await handler({ body: BASE_PAYLOAD }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'CLIENT_TELEMETRY_UNAVAILABLE');
  assert.deepEqual(warnings, ['lifecycle_persist_failed']);
  assert.equal(database.state.updates.length, 0);
  assert.equal(JSON.stringify({ response: res.body, warnings }).includes('secret marker'), false);
});

test('binding errors fail closed before persistence', async () => {
  const database = createFakeDatabase({
    interview: {
      ...createFakeDatabase().state.interview,
      tavus_application_id: 'different-binding',
    },
  });
  const handler = createClientTelemetryHandler({ database, warn: () => {} });
  const res = responseRecorder();
  await handler({ body: BASE_PAYLOAD }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(database.state.inserts.length, 0);
  assert.equal(database.state.updates.length, 0);
});

test('legacy reconnect summary is updated only after append-only persistence succeeds', async () => {
  const database = createFakeDatabase();
  const handler = createClientTelemetryHandler({
    database,
    now: () => '2026-07-28T02:00:01.000Z',
    warn: () => assert.fail('warning not expected'),
  });
  const res = responseRecorder();
  await handler({
    body: {
      ...BASE_PAYLOAD,
      event: 'reconnect_attempted',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(database.state.updates.length, 1);
  assert.deepEqual(database.state.updates[0].payload, {
    reconnect_attempted: true,
    reconnect_attempt_count: 1,
    client_end_reason: 'watchdog_timeout',
    updated_at: '2026-07-28T02:00:01.000Z',
  });
});
