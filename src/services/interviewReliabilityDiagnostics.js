'use strict';

const TELEMETRY_EVENTS = new Set([
  'reconnect_started',
  'reconnect_local_joined',
  'reconnect_remote_presence',
  'reconnect_remote_audio_ready',
  'reconnect_remote_media_changed',
  'reconnect_practical_progress',
  'reconnect_succeeded',
  'reconnect_failed',
  'daily_participant_joined',
  'daily_participant_left',
  'daily_remote_track_started',
  'daily_remote_track_stopped',
  'daily_remote_participant_snapshot',
  'daily_remote_track_state_changed',
  'daily_receive_settings_snapshot',
  'remote_video_attachment_result',
  'reconnect_media_binding_snapshot',
  'startup_readiness_changed',
  'app_message_received',
  'progress_checkpoint_updated',
  'watchdog_deadline_evaluated',
  'browser_online',
  'browser_offline',
  'browser_visibility_changed',
  'interview_terminal_requested',
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
  'closing_terminal_reserved',
  'closing_candidate_audio_unpublish_requested',
  'closing_foreign_pal_audio_muted',
  'closing_interrupt_dispatched',
  'closing_farewell_dispatched',
  'closing_farewell_dispatch_failed',
  'closing_foreign_inference_suppressed',
  'closing_farewell_start_timed_out',
  'closing_farewell_completion_timed_out',
  'closing_farewell_reserved',
  'closing_farewell_started',
  'closing_farewell_completed',
  'closing_farewell_interrupted',
  'closing_farewell_completion_timeout',
  'closing_candidate_audio_lock_requested',
  'closing_candidate_audio_lock_waiting',
  'closing_candidate_audio_locked',
  'closing_candidate_audio_lock_failed',
  'closing_candidate_audio_lock_timed_out',
  'closing_candidate_audio_lock_cancelled',
  'closing_candidate_activity_suppressed',
  'termination_only_entered',
  'local_closing_reserved',
  'remote_pal_audio_muted',
  'candidate_audio_unpublish_requested',
  'local_closing_audio_primed',
  'local_closing_audio_prime_failed',
  'local_closing_audio_play_requested',
  'local_closing_audio_started',
  'local_closing_audio_completed',
  'local_closing_audio_play_failed',
  'local_closing_navigation_fallback',
  'provider_end_requested',
  'provider_end_confirmed',
  'post_closing_question_violation',
  'candidate_inactivity_nudge_armed',
  'candidate_inactivity_nudge_cancelled',
  'candidate_inactivity_nudge_sent',
  'candidate_inactivity_nudge_suppressed',
  'local_media_preflight_result',
  'local_audio_level_state_changed',
  'local_audio_recovery_requested',
  'local_audio_recovery_succeeded',
  'local_audio_recovery_failed',
  // Existing Phase B events retained for deployment compatibility.
  'watchdog_started',
  'watchdog_timeout',
  'reconnect_attempted',
  'browser_closed_or_navigation',
]);

const TOP_LEVEL_KEYS = new Set([
  'conversation_id',
  'interview_id',
  'role_token',
  'event',
  'event_sequence',
  'observed_at',
  'reason',
  'metadata',
]);

const INTEGER_FIELDS = Object.freeze({
  recovery_attempt: [0, 1],
  elapsed_ms: [0, 3_600_000],
  progress_age_ms: [0, 3_600_000],
  recovery_age_ms: [0, 3_600_000],
  participant_count: [0, 16],
  turn_index: [0, 10_000],
  threshold_ms: [0, 60_000],
  turn_sequence: [0, 1_000_000_000],
  attempt_count: [0, 2],
});

const BOOLEAN_FIELDS = new Set([
  'remote_participant_present',
  'is_recovery_active',
  'speech_interrupted',
  'candidate_speaking',
  'reconnect_active',
  'transport_healthy',
  'replica_present',
  'remote_audio_ready',
  'runtime_owner',
  'hard_deadline',
  'audio_publication_enabled',
  'inference_match',
  'audio_track_present',
  'video_track_present',
  'track_present',
  'audio_persistent_track_present',
  'video_persistent_track_present',
  'persistent_track_present',
  'audio_attached',
  'video_attached',
  'element_visible',
  'local_audio_track_live',
  'local_video_track_live',
  'input_level_detected',
  'preflight_override',
  'audio_processing_requested',
]);

const ENUM_FIELDS = Object.freeze({
  recovery_phase: new Set([
    'idle',
    'reconnecting_transport',
    'awaiting_remote_presence',
    'awaiting_remote_media',
    'awaiting_practical_progress',
    'recovered',
    'failed',
  ]),
  participant_role: new Set(['candidate', 'replica', 'unknown']),
  remote_audio_state: new Set(['absent', 'blocked', 'off', 'sendable', 'loading', 'interrupted', 'playable', 'stopped', 'unavailable', 'unknown']),
  remote_video_state: new Set(['absent', 'blocked', 'off', 'sendable', 'loading', 'interrupted', 'playable', 'stopped', 'unavailable', 'unknown']),
  audio_track_state: new Set(['absent', 'blocked', 'off', 'sendable', 'loading', 'interrupted', 'playable', 'unavailable', 'unknown']),
  video_track_state: new Set(['absent', 'blocked', 'off', 'sendable', 'loading', 'interrupted', 'playable', 'unavailable', 'unknown']),
  track_kind: new Set(['audio', 'video']),
  track_state: new Set(['started', 'stopped', 'absent', 'blocked', 'off', 'sendable', 'loading', 'interrupted', 'playable', 'unavailable', 'unknown']),
  previous_track_state: new Set(['absent', 'blocked', 'off', 'sendable', 'loading', 'interrupted', 'playable', 'unavailable', 'unknown']),
  next_track_state: new Set(['absent', 'blocked', 'off', 'sendable', 'loading', 'interrupted', 'playable', 'unavailable', 'unknown']),
  meeting_state: new Set(['joined', 'left', 'reconnecting', 'unknown']),
  network_state: new Set(['online', 'offline', 'unknown']),
  visibility_state: new Set(['visible', 'hidden', 'prerender', 'unknown']),
  progress_source: new Set([
    'replica_started_speaking',
    'replica_utterance',
    'candidate_utterance',
    'candidate_speaking_started',
    'candidate_speaking_ended',
  ]),
  watchdog_reset_source: new Set(['progress_checkpoint', 'reconnect_practical_progress']),
  watchdog_evaluation: new Set([
    'recovery_threshold_reached',
    'recovery_deadline_expired',
    'post_recovery_progress_stale',
    'candidate_speaking_active',
    'candidate_speaking_protection_expired',
  ]),
  terminal_reason: new Set([
    'watchdog_timeout',
    'reconnect_failed',
    'browser_closed_or_navigation',
  ]),
  closing_state: new Set([
    'INTERVIEWING',
    'QUESTION_LOCKED',
    'CLOSING_ONLY',
    'WIND_DOWN_ONLY',
    'FORCED_WIND_DOWN',
    'FINAL_FAREWELL_ELIGIBLE',
    'TERMINATION_ONLY',
    'LOCAL_CLOSING',
    'CLOSING_RESERVED',
    'FOREIGN_PAL_AUDIO_MUTED',
    'FAREWELL_DISPATCHED',
    'FAREWELL_AUDIBLE',
    'PROVIDER_END_REQUESTED',
    'COMPLETE',
    'ENDED',
  ]),
  remaining_time_bucket: new Set([
    'over_45',
    '31_45',
    '11_30',
    '0_10',
  ]),
  inactivity_state: new Set([
    'DISABLED',
    'DISARMED',
    'ARMED_AFTER_PAL_TURN',
    'CANCELLED',
    'NUDGE_DISPATCHED',
    'WAITING_FOR_CANDIDATE_AFTER_NUDGE',
    'SUPPRESSED',
    'TERMINAL',
  ]),
  inactivity_reason: new Set([
    'candidate_speaking',
    'candidate_utterance',
    'pal_speaking',
    'reconnect',
    'transport_unhealthy',
    'candidate_media_unavailable',
    'replica_absent',
    'remote_audio_unavailable',
    'watchdog_recovery',
    'question_lock',
    'closing',
    'termination',
    'provider_end',
    'conversation_changed',
    'unmount',
    'runtime_ownership_lost',
    'hidden_document',
    'interrupted_pal_turn',
    'duplicate_turn',
    'stale_sequence',
    'wrong_conversation',
    'application_control_turn',
    'late_timer',
    'ambiguous_state',
    'dispatch_failed',
  ]),
  timer_lateness_bucket: new Set(['on_time', 'within_2s', 'over_2s']),
  ownership_mode: new Set(['prompt', 'tavus_patient', 'application_inactivity']),
  lock_result_category: new Set([
    'requested',
    'confirmed_disabled',
    'already_disabled',
    'definite_failure',
    'timed_out',
    'ambiguous',
    'cancelled_terminal',
    'unsupported',
  ]),
  confirmation_source: new Set([
    'participant_updated',
    'participant_snapshot',
    'participant_snapshot_poll',
    'none',
  ]),
  publication_state: new Set([
    'off',
    'blocked',
    'enabled',
    'loading',
    'interrupted',
    'unavailable',
    'unknown',
  ]),
  elapsed_time_bucket: new Set([
    'under_250',
    '250_749',
    '750_1499',
    '1500_1999',
    '2000_plus',
  ]),
  timeout_category: new Set(['bounded_timeout', 'farewell_start', 'farewell_completion']),
  suppression_reason: new Set(['final_closing_audio_lock']),
  playback_result_category: new Set([
    'primed',
    'prime_failed',
    'unavailable',
    'requested',
    'started',
    'completed',
    'play_failed',
  ]),
  audio_duration_bucket: new Set(['4_5_seconds']),
  mute_result_category: new Set(['muted_detached', 'already_muted', 'unavailable', 'failed']),
  candidate_unpublish_result_category: new Set(['requested', 'unsupported', 'failed']),
  fallback_reason: new Set(['play_failed', 'playback_stalled', 'load_failed', 'observer_reload']),
  provider_end_result_category: new Set(['requested', 'confirmed', 'unconfirmed', 'failed', 'ambiguous']),
  dispatch_result_category: new Set(['sent', 'failed']),
  speech_result_category: new Set(['started', 'completed']),
  remote_audio_state_category: new Set(['muted', 'remuted', 'audible']),
  duplicate_suppression_category: new Set([
    'none',
    'deadline',
    'effect',
    'tab_observer',
    'remount',
    'stale_owner_takeover',
    'ownership_uncertain',
    'event_replay',
  ]),
  provider_end_reason: new Set([
    'farewell_completed',
    'start_timeout',
    'completion_timeout',
    'dispatch_failed',
    'farewell_interrupted',
    'foreign_inference_conflict',
    'stale_owner_takeover',
    'observer_reload',
  ]),
  remote_participant_count_bucket: new Set(['zero', 'one', 'multiple']),
  local_remote_classification: new Set(['all_non_local_as_replica', 'none', 'unknown']),
  audio_subscription_state: new Set(['subscribed', 'staged', 'unsubscribed', 'unknown']),
  video_subscription_state: new Set(['subscribed', 'staged', 'unsubscribed', 'unknown']),
  subscription_state: new Set(['subscribed', 'staged', 'unsubscribed', 'unknown']),
  startup_readiness_state: new Set([
    'waiting_for_remote_participant',
    'remote_participant_present',
    'remote_participant_audio_only',
    'remote_video_loading',
    'remote_video_playable',
    'replica_progress_confirmed',
    'startup_ready',
    'startup_recovering',
    'startup_failed',
  ]),
  reconnect_phase: new Set([
    'idle',
    'reconnecting_transport',
    'awaiting_remote_presence',
    'awaiting_remote_media',
    'awaiting_practical_progress',
    'recovered',
    'failed',
  ]),
  snapshot_reason: new Set([
    'initial_discovery',
    'participant_joined',
    'participant_updated',
    'participant_left',
    'track_started',
    'track_stopped',
    'reconnect_rediscovery',
    'recovery_deadline',
    'terminal_failure',
    'watchdog_snapshot',
  ]),
  transition_source: new Set([
    'participant_joined',
    'participant_updated',
    'participant_left',
    'track_started',
    'track_stopped',
    'reconnect_enumeration',
    'watchdog_snapshot',
  ]),
  elapsed_since_join_bucket: new Set([
    'under_15_seconds',
    '15_45_seconds',
    '46_75_seconds',
    'over_75_seconds',
    'unavailable',
  ]),
  audio_receive_state: new Set(['automatic', 'off', 'full', 'base', 'unavailable', 'unknown']),
  video_receive_state: new Set(['automatic', 'off', 'full', 'base', 'thumbnail', 'unavailable', 'unknown']),
  settings_source: new Set(['explicit', 'inherited_default', 'unavailable']),
  video_attachment_result: new Set([
    'no_track',
    'track_loading',
    'src_object_attached',
    'play_resolved',
    'play_rejected_policy',
    'play_rejected_media',
    'play_rejected_unknown',
    'element_not_ready',
    'track_ended',
    'detached_for_reconnect',
    'replaced_after_reconnect',
  ]),
  element_ready_state_bucket: new Set(['empty', 'metadata', 'current_data', 'future_data', 'enough_data', 'unavailable']),
  element_size_bucket: new Set(['zero', 'nonzero', 'unavailable']),
  reconnect_binding_phase: new Set([
    'initiation',
    'post_leave',
    'rejoin_success',
    'participant_rediscovery',
    'track_rebinding',
    'recovery_deadline',
  ]),
  participant_continuity: new Set(['same_runtime_reference', 'replacement_reference', 'absent', 'unknown']),
  audio_track_continuity: new Set(['retained', 'replaced', 'absent', 'unknown']),
  video_track_continuity: new Set(['retained', 'replaced', 'absent', 'unknown']),
  recovery_age_bucket: new Set(['under_5_seconds', '5_15_seconds', '16_30_seconds', 'over_30_seconds', 'unavailable']),
  missing_progress_reason: new Set([
    'no_remote_participant',
    'audio_only',
    'video_unavailable',
    'video_loading',
    'no_replica_speech',
    'no_replica_utterance',
    'no_candidate_activity',
    'media_attachment_unconfirmed',
    'multiple_conditions',
    'unknown',
  ]),
  video_unavailable_duration_bucket: new Set([
    'under_15_seconds',
    '15_45_seconds',
    '46_75_seconds',
    'over_75_seconds',
    'unavailable',
  ]),
  local_audio_level_state: new Set(['unavailable', 'silent', 'low', 'ready']),
  local_media_permission_state: new Set(['granted', 'denied', 'unavailable', 'unknown']),
  audio_processing_result: new Set(['default', 'applied', 'unsupported', 'failed']),
  local_audio_recovery_result: new Set(['requested', 'succeeded', 'failed', 'unsupported']),
});

const METADATA_KEYS = new Set([
  ...Object.keys(INTEGER_FIELDS),
  ...BOOLEAN_FIELDS,
  ...Object.keys(ENUM_FIELDS),
]);

const REASON_VALUES = new Set([
  'watchdog_timeout',
  'reconnect_failed',
  'browser_closed_or_navigation',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(code) {
  return { ok: false, code };
}

function validateMetadata(value) {
  if (value === undefined) return { ok: true, metadata: {} };
  if (!isPlainObject(value)) return invalid('INVALID_TELEMETRY_METADATA');

  const serialized = JSON.stringify(value);
  if (serialized.length > 2048 || Object.keys(value).length > 20) {
    return invalid('TELEMETRY_METADATA_TOO_LARGE');
  }

  const metadata = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!METADATA_KEYS.has(key)) return invalid('UNKNOWN_TELEMETRY_METADATA');

    if (Object.prototype.hasOwnProperty.call(INTEGER_FIELDS, key)) {
      const [minimum, maximum] = INTEGER_FIELDS[key];
      if (!Number.isInteger(fieldValue) || fieldValue < minimum || fieldValue > maximum) {
        return invalid('INVALID_TELEMETRY_METADATA');
      }
      metadata[key] = fieldValue;
      continue;
    }

    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof fieldValue !== 'boolean') return invalid('INVALID_TELEMETRY_METADATA');
      metadata[key] = fieldValue;
      continue;
    }

    const allowedValues = ENUM_FIELDS[key];
    if (!allowedValues?.has(fieldValue)) return invalid('INVALID_TELEMETRY_METADATA');
    metadata[key] = fieldValue;
  }

  return { ok: true, metadata };
}

function validateTelemetryPayload(body) {
  if (!isPlainObject(body)) return invalid('INVALID_TELEMETRY_PAYLOAD');
  if (Object.keys(body).some((key) => !TOP_LEVEL_KEYS.has(key))) {
    return invalid('UNKNOWN_TELEMETRY_FIELD');
  }

  const interviewId = typeof body.interview_id === 'string' ? body.interview_id.trim() : '';
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
  const roleToken = typeof body.role_token === 'string' ? body.role_token.trim() : '';
  const event = typeof body.event === 'string' ? body.event.trim().toLowerCase() : '';
  const eventSequence = body.event_sequence;
  const observedAt = typeof body.observed_at === 'string' ? body.observed_at.trim() : '';
  const reason = body.reason === undefined
    ? null
    : (typeof body.reason === 'string' ? body.reason.trim().toLowerCase() : '');

  if (!interviewId || interviewId.length > 80 || conversationId.length > 200
    || roleToken.length > 200) {
    return invalid('MISSING_REQUIRED_PARAMS');
  }
  if (!TELEMETRY_EVENTS.has(event)) return invalid('UNKNOWN_TELEMETRY_EVENT');
  if (!Number.isInteger(eventSequence) || eventSequence < 1 || eventSequence > 1_000_000) {
    return invalid('INVALID_TELEMETRY_SEQUENCE');
  }
  if (!observedAt || observedAt.length > 40 || !Number.isFinite(Date.parse(observedAt))) {
    return invalid('INVALID_TELEMETRY_TIMESTAMP');
  }
  if (reason !== null && !REASON_VALUES.has(reason)) return invalid('INVALID_TELEMETRY_REASON');

  const metadataResult = validateMetadata(body.metadata);
  if (!metadataResult.ok) return metadataResult;

  return {
    ok: true,
    telemetry: {
      interviewId,
      conversationId,
      roleToken,
      event,
      eventSequence,
      observedAt,
      reason,
      metadata: metadataResult.metadata,
    },
  };
}

function diagnosticDedupeKey(eventSequence, observedAt) {
  return `browser:${eventSequence}:${observedAt}`;
}

function decodeTelemetryAuthorization(value) {
  if (typeof value !== 'string' || value.length > 700) return null;
  const match = value.match(/^AlphaScreen-Telemetry ([A-Za-z0-9+/=_-]+)$/);
  if (!match) return null;
  try {
    const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [roleToken, conversationId] = decoded;
    if (typeof roleToken !== 'string' || !roleToken.trim() || roleToken.length > 200) return null;
    if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 200) return null;
    return {
      roleToken: roleToken.trim(),
      conversationId: conversationId.trim(),
    };
  } catch {
    return null;
  }
}

module.exports = {
  METADATA_KEYS,
  TELEMETRY_EVENTS,
  decodeTelemetryAuthorization,
  diagnosticDedupeKey,
  validateTelemetryPayload,
};
