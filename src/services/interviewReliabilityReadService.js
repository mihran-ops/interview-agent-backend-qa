'use strict';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SCAN_ROWS = 2000;
const PROCESSING_OVERDUE_MS = 60 * 60 * 1000;

const LIST_QUERY_KEYS = new Set([
  'time_range',
  'client_id',
  'role_id',
  'status',
  'attempt',
  'failure_category',
  'reconnect_outcome',
  'processing_state',
  'search',
  'sort',
  'direction',
  'page',
  'page_size',
]);

const DETAIL_QUERY_KEYS = new Set(['client_id']);
const TIME_RANGES = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});
const SORT_FIELDS = new Set(['started_at', 'ended_at', 'duration', 'status', 'failure', 'processing_age']);
const SORT_DIRECTIONS = new Set(['asc', 'desc']);
const STATUS_FILTERS = new Set([
  'analyzed',
  'authorized',
  'complete',
  'completed',
  'connected',
  'disconnected',
  'ended',
  'ending_requested',
  'failed',
  'in_progress',
  'incomplete',
  'pending',
  'readyforanalysis',
  'started',
  'starting',
  'transcribed',
  'transcriptionreceived',
]);
const FAILURE_CATEGORIES = new Set([
  'healthy_completed',
  'incomplete_substantive',
  'incomplete_non_substantive',
  'reconnect_recovered',
  'reconnect_failed',
  'watchdog_timeout',
  'processing_pending',
  'processing_overdue',
  'unknown_termination',
  'in_progress',
]);
const RECONNECT_OUTCOMES = new Set(['not_attempted', 'attempted_unknown', 'recovered', 'failed']);
const PROCESSING_STATES = new Set(['complete', 'pending', 'overdue', 'incomplete', 'failed', 'not_applicable', 'unknown']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCH_RE = /^[\p{L}\p{N} .,'’-]+$/u;

const ACTIVE_STATUSES = new Set(['authorized', 'starting', 'pending', 'started', 'connected', 'in_progress', 'ending_requested']);
const COMPLETED_STATUSES = new Set(['analyzed', 'complete', 'completed', 'readyforanalysis', 'transcribed', 'transcriptionreceived']);
const INCOMPLETE_STATUSES = new Set(['disconnected', 'failed', 'incomplete']);
const TERMINAL_STATUSES = new Set([...COMPLETED_STATUSES, ...INCOMPLETE_STATUSES, 'ended']);

const STATUS_OUTPUT = new Map([
  ['analyzed', 'Analyzed'],
  ['authorized', 'Authorized'],
  ['complete', 'Complete'],
  ['completed', 'Completed'],
  ['connected', 'Connected'],
  ['disconnected', 'Disconnected'],
  ['ended', 'Ended'],
  ['ending_requested', 'Ending requested'],
  ['failed', 'Failed'],
  ['in_progress', 'In progress'],
  ['incomplete', 'Incomplete'],
  ['pending', 'Pending'],
  ['readyforanalysis', 'Ready for analysis'],
  ['started', 'Started'],
  ['starting', 'Starting'],
  ['transcribed', 'Transcribed'],
  ['transcriptionreceived', 'Transcription received'],
]);

const PROGRESS_STATES = new Map([
  ['candidateresponded', 'candidate_responded'],
  ['clarificationrequested', 'clarification_requested'],
  ['questionrepeated', 'question_repeated'],
  ['waitingafterrepeat', 'waiting_after_repeat'],
  ['waitingforanswer', 'waiting_for_answer'],
]);

const TERMINAL_REASONS = new Set([
  'browser_closed_or_navigation',
  'candidate_ended',
  'completed_normally',
  'reconnect_failed',
  'vendor_end_event',
  'watchdog_timeout',
]);

const FAILURE_CODE_CATEGORIES = new Map([
  ['INTERVIEW_DISCONNECTED', 'reconnect_failed'],
  ['INTERVIEW_PROGRESS_STALLED', 'watchdog_timeout'],
  ['NO_SUBSTANTIVE_CANDIDATE_RESPONSE', 'no_substantive_response'],
]);

const EVENT_DEFINITIONS = Object.freeze({
  'client.reconnect_started': ['Reconnect started', 'reconnect'],
  'client.reconnect_attempted': ['Reconnect attempted', 'reconnect'],
  'client.reconnect_local_joined': ['Local participant rejoined', 'reconnect'],
  'client.reconnect_remote_presence': ['Remote participant detected', 'reconnect'],
  'client.reconnect_remote_audio_ready': ['Remote audio became ready', 'reconnect'],
  'client.reconnect_remote_media_changed': ['Remote media state changed', 'reconnect'],
  'client.reconnect_practical_progress': ['Practical progress resumed', 'reconnect'],
  'client.reconnect_succeeded': ['Reconnect succeeded', 'reconnect'],
  'client.reconnect_failed': ['Reconnect failed', 'reconnect'],
  'client.daily_participant_joined': ['Participant joined', 'participant'],
  'client.daily_participant_left': ['Participant left', 'participant'],
  'client.daily_remote_track_started': ['Remote media started', 'media'],
  'client.daily_remote_track_stopped': ['Remote media stopped', 'media'],
  'client.daily_remote_participant_snapshot': ['Remote participant snapshot', 'media'],
  'client.daily_remote_track_state_changed': ['Remote track state changed', 'media'],
  'client.daily_receive_settings_snapshot': ['Daily receive settings snapshot', 'media'],
  'client.remote_video_attachment_result': ['Remote video attachment result', 'media'],
  'client.reconnect_media_binding_snapshot': ['Reconnect media binding snapshot', 'reconnect'],
  'client.startup_readiness_changed': ['Startup readiness changed', 'media'],
  'client.app_message_received': ['Replica progress received', 'replica_progress'],
  'client.progress_checkpoint_updated': ['Progress checkpoint updated', 'candidate_progress'],
  'client.watchdog_started': ['Progress watchdog started', 'watchdog'],
  'client.watchdog_deadline_evaluated': ['Progress watchdog evaluated', 'watchdog'],
  'client.watchdog_timeout': ['Progress watchdog timed out', 'watchdog'],
  'client.browser_online': ['Browser online', 'session'],
  'client.browser_offline': ['Browser offline', 'session'],
  'client.browser_visibility_changed': ['Browser visibility changed', 'session'],
  'client.interview_terminal_requested': ['Interview termination requested', 'terminal'],
  'client.question_lock_entered': ['Question lock entered', 'closing'],
  'client.closing_only_entered': ['Closing-only state entered', 'closing'],
  'client.wind_down_entered': ['Wind-down entered', 'closing'],
  'client.wind_down_forced_interrupt': ['Forced wind-down decision applied', 'closing'],
  'client.closing_forced_interrupt': ['Final closing interrupt applied', 'closing'],
  'client.candidate_question_invitation_sent': ['Candidate question invitation sent', 'closing'],
  'client.candidate_question_invitation_skipped': ['Candidate question invitation skipped', 'closing'],
  'client.candidate_question_received': ['Candidate question received', 'closing'],
  'client.candidate_question_response_completed': ['Candidate question response completed', 'closing'],
  'client.final_farewell_eligible': ['Final farewell became eligible', 'closing'],
  'client.closing_terminal_reserved': ['Terminal closing reserved', 'closing'],
  'client.closing_candidate_audio_unpublish_requested': ['Candidate audio unpublish requested', 'closing'],
  'client.closing_foreign_pal_audio_muted': ['Ordinary PAL audio muted', 'closing'],
  'client.closing_interrupt_dispatched': ['Closing interrupt dispatched', 'closing'],
  'client.closing_farewell_dispatched': ['Closing farewell dispatched', 'closing'],
  'client.closing_farewell_dispatch_failed': ['Closing farewell dispatch failed', 'closing'],
  'client.closing_foreign_inference_suppressed': ['Foreign closing inference suppressed', 'closing'],
  'client.closing_farewell_start_timed_out': ['Closing farewell start timed out', 'closing'],
  'client.closing_farewell_completion_timed_out': ['Closing farewell completion timed out', 'closing'],
  'client.closing_farewell_reserved': ['Closing farewell reserved', 'closing'],
  'client.closing_farewell_started': ['Closing farewell started', 'closing'],
  'client.closing_farewell_completed': ['Closing farewell completed', 'closing'],
  'client.closing_farewell_interrupted': ['Closing farewell interrupted', 'closing'],
  'client.closing_farewell_completion_timeout': ['Closing farewell completion timed out', 'closing'],
  'client.closing_candidate_audio_lock_requested': ['Candidate audio lock requested', 'closing'],
  'client.closing_candidate_audio_lock_waiting': ['Candidate audio lock awaiting Daily confirmation', 'closing'],
  'client.closing_candidate_audio_locked': ['Candidate audio publication locked', 'closing'],
  'client.closing_candidate_audio_lock_failed': ['Candidate audio lock failed', 'closing'],
  'client.closing_candidate_audio_lock_timed_out': ['Candidate audio lock confirmation timed out', 'closing'],
  'client.closing_candidate_audio_lock_cancelled': ['Candidate audio lock confirmation cancelled', 'closing'],
  'client.closing_candidate_activity_suppressed': ['Candidate activity suppressed during closing', 'closing'],
  'client.termination_only_entered': ['Termination-only state entered', 'terminal'],
  'client.local_closing_reserved': ['Local closing reserved', 'closing'],
  'client.remote_pal_audio_muted': ['Remote PAL audio muted', 'closing'],
  'client.candidate_audio_unpublish_requested': ['Candidate audio unpublish requested', 'closing'],
  'client.local_closing_audio_primed': ['Local closing audio primed', 'closing'],
  'client.local_closing_audio_prime_failed': ['Local closing audio prime failed', 'closing'],
  'client.local_closing_audio_play_requested': ['Local closing audio playback requested', 'closing'],
  'client.local_closing_audio_started': ['Local closing audio started', 'closing'],
  'client.local_closing_audio_completed': ['Local closing audio completed', 'closing'],
  'client.local_closing_audio_play_failed': ['Local closing audio playback failed', 'closing'],
  'client.local_closing_navigation_fallback': ['Local closing navigation fallback used', 'closing'],
  'client.provider_end_requested': ['Provider end requested', 'terminal'],
  'client.provider_end_confirmed': ['Provider end confirmed', 'terminal'],
  'client.post_closing_question_violation': ['Post-closing question blocked', 'closing'],
  'client.candidate_inactivity_nudge_armed': ['Candidate inactivity nudge armed', 'inactivity'],
  'client.candidate_inactivity_nudge_cancelled': ['Candidate inactivity nudge cancelled', 'inactivity'],
  'client.candidate_inactivity_nudge_sent': ['Candidate inactivity nudge sent', 'inactivity'],
  'client.candidate_inactivity_nudge_suppressed': ['Candidate inactivity nudge suppressed', 'inactivity'],
  'client.browser_closed_or_navigation': ['Browser closed or navigated away', 'terminal'],
  'system.replica_joined': ['Replica joined', 'participant'],
  'system.shutdown': ['Session ended', 'terminal'],
  'application.transcription_ready': ['Transcript processing received', 'processing'],
});

const TECHNICAL_INTEGER_FIELDS = Object.freeze({
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
const TECHNICAL_BOOLEAN_FIELDS = new Set([
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
]);
const TECHNICAL_ENUM_FIELDS = Object.freeze({
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
    'waiting_for_remote_participant', 'remote_participant_present', 'remote_participant_audio_only',
    'remote_video_loading', 'remote_video_playable', 'replica_progress_confirmed', 'startup_ready',
    'startup_recovering', 'startup_failed',
  ]),
  reconnect_phase: new Set([
    'idle', 'reconnecting_transport', 'awaiting_remote_presence', 'awaiting_remote_media',
    'awaiting_practical_progress', 'recovered', 'failed',
  ]),
  snapshot_reason: new Set([
    'initial_discovery', 'participant_joined', 'participant_updated', 'participant_left',
    'track_started', 'track_stopped', 'reconnect_rediscovery', 'recovery_deadline',
    'terminal_failure', 'watchdog_snapshot',
  ]),
  transition_source: new Set([
    'participant_joined', 'participant_updated', 'participant_left', 'track_started',
    'track_stopped', 'reconnect_enumeration', 'watchdog_snapshot',
  ]),
  elapsed_since_join_bucket: new Set(['under_15_seconds', '15_45_seconds', '46_75_seconds', 'over_75_seconds', 'unavailable']),
  audio_receive_state: new Set(['automatic', 'off', 'full', 'base', 'unavailable', 'unknown']),
  video_receive_state: new Set(['automatic', 'off', 'full', 'base', 'thumbnail', 'unavailable', 'unknown']),
  settings_source: new Set(['explicit', 'inherited_default', 'unavailable']),
  video_attachment_result: new Set([
    'no_track', 'track_loading', 'src_object_attached', 'play_resolved', 'play_rejected_policy',
    'play_rejected_media', 'play_rejected_unknown', 'element_not_ready', 'track_ended',
    'detached_for_reconnect', 'replaced_after_reconnect',
  ]),
  element_ready_state_bucket: new Set(['empty', 'metadata', 'current_data', 'future_data', 'enough_data', 'unavailable']),
  element_size_bucket: new Set(['zero', 'nonzero', 'unavailable']),
  reconnect_binding_phase: new Set(['initiation', 'post_leave', 'rejoin_success', 'participant_rediscovery', 'track_rebinding', 'recovery_deadline']),
  participant_continuity: new Set(['same_runtime_reference', 'replacement_reference', 'absent', 'unknown']),
  audio_track_continuity: new Set(['retained', 'replaced', 'absent', 'unknown']),
  video_track_continuity: new Set(['retained', 'replaced', 'absent', 'unknown']),
  recovery_age_bucket: new Set(['under_5_seconds', '5_15_seconds', '16_30_seconds', 'over_30_seconds', 'unavailable']),
  missing_progress_reason: new Set([
    'no_remote_participant', 'audio_only', 'video_unavailable', 'video_loading',
    'no_replica_speech', 'no_replica_utterance', 'no_candidate_activity',
    'media_attachment_unconfirmed', 'multiple_conditions', 'unknown',
  ]),
  video_unavailable_duration_bucket: new Set(['under_15_seconds', '15_45_seconds', '46_75_seconds', 'over_75_seconds', 'unavailable']),
  webhook_latency_bucket: new Set(['under_1_second', '1_5_seconds', '5_15_seconds', 'over_15_seconds', 'unavailable']),
});
const TECHNICAL_METADATA_FIELDS = Object.freeze([
  ...Object.keys(TECHNICAL_INTEGER_FIELDS),
  ...TECHNICAL_BOOLEAN_FIELDS,
  ...Object.keys(TECHNICAL_ENUM_FIELDS),
]);

const INTERVIEW_SELECT = [
  'id',
  'candidate_id',
  'role_id',
  'client_id',
  'status',
  'created_at',
  'updated_at',
  'attempt_number',
  'previous_attempt_id',
  'replacement_authorization_id',
  'is_active',
  'has_substantive_response',
  'substantive_response_count',
  'candidate_utterance_count',
  'conversation_progress_state',
  'replacement_eligible',
  'replacement_eligibility_reason',
  'reset_at',
  'reset_mode',
  'client_end_reason',
  'vendor_end_reason',
  'last_candidate_utterance_at',
  'last_ai_utterance_at',
  'watchdog_no_progress_at',
  'reconnect_attempted',
  'reconnect_attempt_count',
  'reconnect_result',
  'started_at',
  'ended_at',
  'last_vendor_event_at',
  'recording_status',
  'recording_ready_at',
  'recording_deleted_at',
  'recording_delete_reason',
  'recording_delete_error',
  'transcript_available',
  'transcript_scores',
  'interview_summary',
  'unanswered_candidate_questions',
  'interview_analysis_v2',
  'failure_code',
  'failure_stage',
  'failure_at',
  'retryable',
].join(',');

function reliabilityError(code, detail, status = 400) {
  const error = new Error(detail);
  error.code = code;
  error.status = status;
  return error;
}

function trimText(value, maxLength = 120) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, maxLength);
}

function lowerText(value) {
  return trimText(value, 120).toLowerCase().replace(/[\s-]+/g, '_');
}

function parseDateMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function safeStatus(value) {
  const normalized = lowerText(value);
  return STATUS_OUTPUT.get(normalized) || 'Unknown';
}

function safeProgressState(value) {
  return PROGRESS_STATES.get(lowerText(value).replace(/_/g, '')) || 'unknown';
}

function terminalReason(interview) {
  const clientReason = lowerText(interview?.client_end_reason);
  if (TERMINAL_REASONS.has(clientReason)) return clientReason;
  const vendorReason = lowerText(interview?.vendor_end_reason);
  if (TERMINAL_REASONS.has(vendorReason)) return vendorReason;
  return TERMINAL_STATUSES.has(lowerText(interview?.status)) ? 'unknown' : 'not_terminal';
}

function failureCategory(interview) {
  const code = trimText(interview?.failure_code, 80).toUpperCase();
  if (FAILURE_CODE_CATEGORIES.has(code)) return FAILURE_CODE_CATEGORIES.get(code);
  const reason = terminalReason(interview);
  if (reason === 'watchdog_timeout' || reason === 'reconnect_failed') return reason;
  const stage = lowerText(interview?.failure_stage);
  if (stage === 'provider_start' || stage === 'tavus_start') return 'provider_start';
  if (stage === 'transcript_evidence_gate' || stage === 'transcript_processing') return 'transcript_processing';
  return code || stage ? 'unknown' : 'none';
}

function reconnectOutcome(interview) {
  const result = lowerText(interview?.reconnect_result);
  if (result === 'reconnect_succeeded' || result === 'succeeded' || result === 'recovered') return 'recovered';
  if (result === 'reconnect_failed' || result === 'failed' || terminalReason(interview) === 'reconnect_failed') return 'failed';
  if (interview?.reconnect_attempted === true || Number(interview?.reconnect_attempt_count || 0) > 0) return 'attempted_unknown';
  return 'not_attempted';
}

function deriveProcessingStatus(interview, options = {}) {
  const nowMs = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
  const status = lowerText(interview?.status);
  const terminal = TERMINAL_STATUSES.has(status);
  const completed = COMPLETED_STATUSES.has(status);
  const referenceMs =
    parseDateMs(interview?.ended_at) ||
    parseDateMs(interview?.failure_at) ||
    (terminal ? parseDateMs(interview?.updated_at) : null);
  const ageMs = referenceMs == null ? null : Math.max(0, nowMs - referenceMs);

  const scoresAvailable = isNonEmptyObject(interview?.transcript_scores);
  const summaryAvailable = Boolean(trimText(interview?.interview_summary, 1));
  const transcriptAvailable = interview?.transcript_available === true || scoresAvailable || summaryAvailable;
  const substantiveExpected = interview?.has_substantive_response !== false;
  let transcriptState = 'not_applicable';
  if (transcriptAvailable) transcriptState = 'complete';
  else if (terminal && substantiveExpected) {
    transcriptState = ageMs != null && ageMs > PROCESSING_OVERDUE_MS ? 'overdue' : 'pending';
  } else if (terminal) {
    transcriptState = 'not_applicable';
  } else if (!ACTIVE_STATUSES.has(status)) {
    transcriptState = 'unknown';
  }

  const recordingRaw = lowerText(interview?.recording_status);
  let recordingState = 'not_observed';
  if (recordingRaw === 'ready' || interview?.recording_ready_at) recordingState = 'ready';
  else if (recordingRaw === 'deleted' || interview?.recording_deleted_at) recordingState = 'deleted';
  else if (recordingRaw.includes('fail') || recordingRaw.includes('error') || interview?.recording_delete_error) recordingState = 'failed';
  else if (recordingRaw) {
    recordingState = terminal && ageMs != null && ageMs > PROCESSING_OVERDUE_MS ? 'overdue' : 'pending';
  }

  const analysisAvailable = isNonEmptyObject(interview?.interview_analysis_v2);
  const questionsAvailable = Array.isArray(interview?.unanswered_candidate_questions)
    && interview.unanswered_candidate_questions.length > 0;

  let overall = 'unknown';
  if (transcriptState === 'overdue' || recordingState === 'overdue') overall = 'overdue';
  else if (recordingState === 'failed') overall = 'failed';
  else if (transcriptState === 'pending' || recordingState === 'pending') overall = 'pending';
  else if (transcriptState === 'complete' && (!scoresAvailable || !summaryAvailable)) overall = 'incomplete';
  else if (transcriptState === 'complete') overall = 'complete';
  else if (ACTIVE_STATUSES.has(status) || (terminal && interview?.has_substantive_response === false)) overall = 'not_applicable';

  return {
    overall,
    age_ms: ageMs,
    overdue_threshold_ms: PROCESSING_OVERDUE_MS,
    transcript_reconciliation: transcriptState,
    transcript_completed_at: transcriptAvailable ? (interview?.updated_at || interview?.ended_at || null) : null,
    recording: recordingState,
    recording_ready_at: interview?.recording_ready_at || null,
    scores: scoresAvailable ? 'available' : 'not_observed',
    summary: summaryAvailable ? 'available' : 'not_observed',
    question_processing: questionsAvailable ? 'available' : 'not_observed',
    analysis_v2: analysisAvailable ? 'available' : 'not_observed',
    report: options.reportAvailable === true ? 'available' : 'not_observed',
    ownership_visibility: 'derived_from_canonical_outputs',
    completed_interview: completed,
  };
}

function deriveReliabilityClassification(interview, processing) {
  const status = lowerText(interview?.status);
  const reason = terminalReason(interview);
  const reconnect = reconnectOutcome(interview);
  if (reason === 'watchdog_timeout' || interview?.watchdog_no_progress_at) return 'watchdog_timeout';
  if (reconnect === 'failed') return 'reconnect_failed';
  if (INCOMPLETE_STATUSES.has(status)) {
    if (interview?.has_substantive_response === true) return 'incomplete_substantive';
    if (interview?.has_substantive_response === false) return 'incomplete_non_substantive';
    return 'unknown_termination';
  }
  if (reconnect === 'recovered' && COMPLETED_STATUSES.has(status)) return 'reconnect_recovered';
  if (processing?.overall === 'overdue') return 'processing_overdue';
  if (processing?.overall === 'pending' || processing?.overall === 'incomplete' || processing?.overall === 'failed') {
    return 'processing_pending';
  }
  if (COMPLETED_STATUSES.has(status) && (reason === 'completed_normally' || reason === 'unknown' || reason === 'vendor_end_event')) {
    return 'healthy_completed';
  }
  if (ACTIVE_STATUSES.has(status)) return 'in_progress';
  if (TERMINAL_STATUSES.has(status)) return 'unknown_termination';
  return 'unknown_termination';
}

function candidateDisplayName(candidate) {
  const combined = [candidate?.first_name, candidate?.last_name].map((value) => trimText(value, 60)).filter(Boolean).join(' ');
  const name = combined || trimText(candidate?.name, 80) || 'Candidate';
  return name.includes('@') ? 'Candidate' : name;
}

function durationMs(interview, nowMs) {
  const started = parseDateMs(interview?.started_at) || parseDateMs(interview?.created_at);
  const ended = parseDateMs(interview?.ended_at) || (ACTIVE_STATUSES.has(lowerText(interview?.status)) ? nowMs : parseDateMs(interview?.updated_at));
  if (started == null || ended == null || ended < started) return null;
  return ended - started;
}

function recoveryReason(value) {
  const normalized = lowerText(value);
  const allowed = new Set([
    'active_interview_attempt_exists',
    'candidate_interview_state_requires_review',
    'completed_interview_retake_blocked',
    'interview_reset_not_eligible',
    'replacement_already_used',
    'replacement_not_authorized',
  ]);
  return allowed.has(normalized) ? normalized : (normalized ? 'requires_review' : 'not_recorded');
}

function buildInterviewRow(interview, maps, options = {}) {
  const nowMs = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
  const candidate = maps.candidateById.get(String(interview?.candidate_id || '')) || null;
  const client = maps.clientById.get(String(interview?.client_id || '')) || null;
  const role = maps.roleById.get(String(interview?.role_id || '')) || null;
  const processing = deriveProcessingStatus(interview, {
    now: nowMs,
    reportAvailable: options.reportInterviewIds?.has(String(interview?.id || '')),
  });
  const classification = deriveReliabilityClassification(interview, processing);
  return {
    interview_id: String(interview?.id || ''),
    candidate: candidateDisplayName(candidate),
    client: trimText(client?.name, 100) || 'Unknown client',
    client_id: String(interview?.client_id || ''),
    role: trimText(role?.title, 100) || 'Unknown role',
    role_id: String(interview?.role_id || ''),
    attempt: Number.isInteger(Number(interview?.attempt_number)) ? Number(interview.attempt_number) : null,
    started_at: interview?.started_at || interview?.created_at || null,
    ended_at: interview?.ended_at || null,
    duration_ms: durationMs(interview, nowMs),
    final_status: safeStatus(interview?.status),
    status_code: lowerText(interview?.status) || 'unknown',
    progress_state: safeProgressState(interview?.conversation_progress_state),
    reconnect: reconnectOutcome(interview),
    reconnect_count: Math.max(0, Number(interview?.reconnect_attempt_count || 0)),
    terminal_reason: terminalReason(interview),
    transcript_state: processing.transcript_reconciliation,
    analysis_state: processing.analysis_v2,
    reliability_result: classification,
    failure_category: failureCategory(interview),
    processing_state: processing.overall,
    processing_age_ms: processing.age_ms,
  };
}

function parsePositiveInteger(value, fallback, fieldName, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw reliabilityError('invalid_filter', `${fieldName} is invalid.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw reliabilityError('invalid_filter', `${fieldName} is invalid.`);
  }
  return parsed;
}

function assertOnlyKeys(query, allowed) {
  for (const key of Object.keys(query || {})) {
    if (!allowed.has(key)) throw reliabilityError('unsupported_filter', `Unsupported filter: ${key}.`);
    if (Array.isArray(query[key])) throw reliabilityError('invalid_filter', `${key} must be supplied once.`);
  }
}

function parseUuidFilter(value, fieldName) {
  const normalized = trimText(value, 80);
  if (!normalized || normalized === 'all') return null;
  if (!UUID_RE.test(normalized)) throw reliabilityError('invalid_filter', `${fieldName} is invalid.`);
  return normalized;
}

function parseListQuery(query = {}, now = new Date()) {
  assertOnlyKeys(query, LIST_QUERY_KEYS);
  const timeRange = trimText(query.time_range, 10) || '7d';
  if (!Object.hasOwn(TIME_RANGES, timeRange)) throw reliabilityError('invalid_filter', 'time_range is invalid.');
  const page = parsePositiveInteger(query.page, 1, 'page', 100000);
  const pageSize = parsePositiveInteger(query.page_size, DEFAULT_PAGE_SIZE, 'page_size', MAX_PAGE_SIZE);
  const attempt = query.attempt === undefined || query.attempt === ''
    ? null
    : parsePositiveInteger(query.attempt, null, 'attempt', 2);
  const status = lowerText(query.status);
  if (status && status !== 'all' && !STATUS_FILTERS.has(status)) throw reliabilityError('invalid_filter', 'status is invalid.');
  const failure = lowerText(query.failure_category);
  if (failure && failure !== 'all' && !FAILURE_CATEGORIES.has(failure)) throw reliabilityError('invalid_filter', 'failure_category is invalid.');
  const reconnect = lowerText(query.reconnect_outcome);
  if (reconnect && reconnect !== 'all' && !RECONNECT_OUTCOMES.has(reconnect)) throw reliabilityError('invalid_filter', 'reconnect_outcome is invalid.');
  const processing = lowerText(query.processing_state);
  if (processing && processing !== 'all' && !PROCESSING_STATES.has(processing)) throw reliabilityError('invalid_filter', 'processing_state is invalid.');
  const sort = lowerText(query.sort) || 'started_at';
  if (!SORT_FIELDS.has(sort)) throw reliabilityError('unsupported_sort', 'sort is invalid.');
  const direction = lowerText(query.direction) || 'desc';
  if (!SORT_DIRECTIONS.has(direction)) throw reliabilityError('unsupported_sort', 'direction is invalid.');
  const search = trimText(query.search, 81);
  if (search.length > 80 || (search && !SEARCH_RE.test(search))) throw reliabilityError('invalid_filter', 'search is invalid.');
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return {
    time_range: timeRange,
    date_from: new Date(nowMs - TIME_RANGES[timeRange]).toISOString(),
    date_to: new Date(nowMs).toISOString(),
    client_id: parseUuidFilter(query.client_id, 'client_id'),
    role_id: parseUuidFilter(query.role_id, 'role_id'),
    status: status && status !== 'all' ? status : null,
    attempt,
    failure_category: failure && failure !== 'all' ? failure : null,
    reconnect_outcome: reconnect && reconnect !== 'all' ? reconnect : null,
    processing_state: processing && processing !== 'all' ? processing : null,
    search,
    sort,
    direction,
    page,
    page_size: pageSize,
  };
}

function parseDetailQuery(query = {}) {
  assertOnlyKeys(query, DETAIL_QUERY_KEYS);
  return { client_id: parseUuidFilter(query.client_id, 'client_id') };
}

function compareNullable(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return Number(a) - Number(b);
}

function sortRows(rows, sort, direction) {
  const multiplier = direction === 'asc' ? 1 : -1;
  const field = {
    started_at: 'started_at',
    ended_at: 'ended_at',
    duration: 'duration_ms',
    status: 'status_code',
    failure: 'failure_category',
    processing_age: 'processing_age_ms',
  }[sort];
  return [...rows].sort((a, b) => {
    const left = field.endsWith('_at') ? parseDateMs(a[field]) : a[field];
    const right = field.endsWith('_at') ? parseDateMs(b[field]) : b[field];
    const primary = compareNullable(left, right);
    if (primary !== 0) return primary * multiplier;
    return String(a.interview_id).localeCompare(String(b.interview_id));
  });
}

function applyDerivedFilters(rows, filters) {
  const search = filters.search.toLowerCase();
  return rows.filter((row) => {
    if (filters.failure_category && row.reliability_result !== filters.failure_category) return false;
    if (filters.reconnect_outcome && row.reconnect !== filters.reconnect_outcome) return false;
    if (filters.processing_state && row.processing_state !== filters.processing_state) return false;
    if (search && !String(row.candidate || '').toLowerCase().includes(search)) return false;
    return true;
  });
}

function buildSummary(rows) {
  return {
    total_interviews: rows.length,
    completed_normally: rows.filter((row) => ['healthy_completed', 'reconnect_recovered'].includes(row.reliability_result)).length,
    incomplete: rows.filter((row) => ['incomplete_substantive', 'incomplete_non_substantive', 'reconnect_failed', 'watchdog_timeout', 'unknown_termination'].includes(row.reliability_result)).length,
    reconnect_attempted: rows.filter((row) => row.reconnect !== 'not_attempted').length,
    reconnect_failed: rows.filter((row) => row.reconnect === 'failed').length,
    watchdog_terminated: rows.filter((row) => row.reliability_result === 'watchdog_timeout').length,
    processing_incomplete_or_overdue: rows.filter((row) => ['pending', 'overdue', 'incomplete', 'failed'].includes(row.processing_state)).length,
  };
}

function sanitizeLifecycleEvent(event, startedAt) {
  const definition = EVENT_DEFINITIONS[trimText(event?.event_type, 100)] || ['Other lifecycle event', 'session'];
  const metadata = event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
  const technicalDetails = {};
  for (const field of TECHNICAL_METADATA_FIELDS) {
    if (!Object.hasOwn(metadata, field)) continue;
    const value = metadata[field];
    if (Object.hasOwn(TECHNICAL_INTEGER_FIELDS, field)) {
      const [minimum, maximum] = TECHNICAL_INTEGER_FIELDS[field];
      if (Number.isInteger(value) && value >= minimum && value <= maximum) {
        technicalDetails[field] = value;
      }
      continue;
    }
    if (TECHNICAL_BOOLEAN_FIELDS.has(field)) {
      if (typeof value === 'boolean') technicalDetails[field] = value;
      continue;
    }
    if (TECHNICAL_ENUM_FIELDS[field]?.has(value)) technicalDetails[field] = value;
  }
  let group = definition[1];
  if (
    definition[0] === 'Progress checkpoint updated'
    && ['replica_started_speaking', 'replica_utterance'].includes(metadata.progress_source)
  ) {
    group = 'replica_progress';
  }
  const receivedAt = event?.received_at || null;
  const observedAt = event?.observed_at || null;
  const persistedAt = event?.created_at || event?.persisted_at || null;
  const startedMs = parseDateMs(startedAt);
  const eventMs = parseDateMs(observedAt) || parseDateMs(receivedAt);
  const observedMs = parseDateMs(observedAt);
  const receivedMs = parseDateMs(receivedAt);
  const latencyMs = observedMs != null && receivedMs != null && receivedMs >= observedMs
    ? receivedMs - observedMs
    : null;
  if (latencyMs != null) {
    technicalDetails.webhook_latency_bucket = latencyMs < 1000
      ? 'under_1_second'
      : latencyMs <= 5000
        ? '1_5_seconds'
        : latencyMs <= 15000
          ? '5_15_seconds'
          : 'over_15_seconds';
  }
  return {
    event: definition[0],
    event_code: EVENT_DEFINITIONS[trimText(event?.event_type, 100)] ? trimText(event.event_type, 100) : 'other',
    group,
    server_timestamp: receivedAt,
    observed_timestamp: observedAt,
    persistence_timestamp: persistedAt,
    elapsed_ms: startedMs != null && eventMs != null ? Math.max(0, eventMs - startedMs) : null,
    speaker_role: ['candidate', 'ai', 'system'].includes(event?.speaker_role) ? event.speaker_role : 'system',
    utterance_classification: [
      'substantive_answer',
      'clarification_request',
      'repeat_request',
      'hearing_or_audio_issue',
      'acknowledgment',
      'filler',
      'technical_comment',
      'silence_or_empty',
      'unknown_non_substantive',
    ].includes(event?.utterance_classification) ? event.utterance_classification : null,
    technical_details: technicalDetails,
  };
}

function deriveEvidenceCompleteness(timeline, processing) {
  const groups = new Set(timeline.map((event) => event.group));
  const codes = new Set(timeline.map((event) => event.event_code));
  const signals = {
    session_join: codes.has('system.replica_joined') || codes.has('client.daily_participant_joined'),
    remote_presence: codes.has('system.replica_joined') || codes.has('client.reconnect_remote_presence') || codes.has('client.daily_participant_joined'),
    media_ready: codes.has('client.daily_remote_track_started') || codes.has('client.reconnect_remote_audio_ready'),
    progress_checkpoint: groups.has('candidate_progress') || groups.has('replica_progress'),
    terminal_or_completion: groups.has('terminal') || processing?.completed_interview === true,
    processing_complete: processing?.transcript_reconciliation === 'complete',
  };
  const count = Object.values(signals).filter(Boolean).length;
  return {
    level: count === 6 ? 'complete' : (count >= 2 ? 'partial' : 'minimal'),
    signals,
  };
}

function mapRowsById(rows) {
  return new Map((rows || []).map((row) => [String(row?.id || ''), row]));
}

function uniqueIds(rows, field) {
  return [...new Set((rows || []).map((row) => String(row?.[field] || '')).filter(Boolean))];
}

async function requireRows(result, code = 'read_failed') {
  const resolved = await result;
  if (resolved?.error) throw reliabilityError(code, 'Interview reliability data is temporarily unavailable.', 503);
  return Array.isArray(resolved?.data) ? resolved.data : [];
}

async function requireMaybeSingle(result, code = 'read_failed') {
  const resolved = await result;
  if (resolved?.error) throw reliabilityError(code, 'Interview reliability data is temporarily unavailable.', 503);
  return resolved?.data || null;
}

async function readChunks(ids, readChunk) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 150) {
    rows.push(...await readChunk(ids.slice(index, index + 150)));
  }
  return rows;
}

function createSupabaseReader(db) {
  if (!db?.from) throw new TypeError('database client is required');
  return {
    async validateClient(clientId) {
      if (!clientId) return null;
      return requireMaybeSingle(
        db.from('clients').select('id,name').eq('id', clientId).maybeSingle(),
        'scope_lookup_failed',
      );
    },
    async validateRole(roleId) {
      if (!roleId) return null;
      return requireMaybeSingle(
        db.from('roles').select('id,client_id,title').eq('id', roleId).maybeSingle(),
        'scope_lookup_failed',
      );
    },
    async listInterviews(filters) {
      let query = db.from('interviews')
        .select(INTERVIEW_SELECT)
        .gte('created_at', filters.date_from)
        .lte('created_at', filters.date_to)
        .order('created_at', { ascending: false })
        .limit(MAX_SCAN_ROWS + 1);
      if (filters.client_id) query = query.eq('client_id', filters.client_id);
      if (filters.role_id) query = query.eq('role_id', filters.role_id);
      if (filters.status) query = query.ilike('status', filters.status);
      if (filters.attempt) query = query.eq('attempt_number', filters.attempt);
      return requireRows(query, 'interviews_read_failed');
    },
    async readInterview(interviewId) {
      return requireMaybeSingle(
        db.from('interviews').select(INTERVIEW_SELECT).eq('id', interviewId).maybeSingle(),
        'interviews_read_failed',
      );
    },
    async readCandidates(ids) {
      if (!ids.length) return [];
      return readChunks(ids, (chunk) => requireRows(
        db.from('candidates').select('id,name,first_name,last_name').in('id', chunk),
        'candidate_identity_read_failed',
      ));
    },
    async readClients(ids) {
      if (!ids.length) return [];
      return readChunks(ids, (chunk) => requireRows(
        db.from('clients').select('id,name').in('id', chunk),
        'client_identity_read_failed',
      ));
    },
    async readRoles(ids) {
      if (!ids.length) return [];
      return readChunks(ids, (chunk) => requireRows(
        db.from('roles').select('id,client_id,title').in('id', chunk),
        'role_identity_read_failed',
      ));
    },
    async readReports(interviewIds) {
      if (!interviewIds.length) return [];
      return readChunks(interviewIds, (chunk) => requireRows(
        db.from('reports').select('id,interview_id,created_at').in('interview_id', chunk),
        'report_state_read_failed',
      ));
    },
    async readLifecycleEvents(interviewId) {
      return requireRows(
        db.from('interview_lifecycle_events')
          .select('id,event_type,speaker_role,utterance_classification,observed_at,received_at,metadata')
          .eq('interview_id', interviewId)
          .order('received_at', { ascending: true })
          .limit(2000),
        'lifecycle_read_failed',
      );
    },
    async readAttempts(candidateId, roleId) {
      return requireRows(
        db.from('interviews')
          .select('id,status,attempt_number,previous_attempt_id,replacement_authorization_id,replacement_eligible,replacement_eligibility_reason,created_at')
          .eq('candidate_id', candidateId)
          .eq('role_id', roleId)
          .order('attempt_number', { ascending: true })
          .limit(3),
        'attempts_read_failed',
      );
    },
    async readResetEvents(candidateId, roleId) {
      return requireRows(
        db.from('interview_reset_events')
          .select('previous_interview_id,replacement_interview_id,authorization_status,reset_mode,created_at,consumed_at,expires_at,start_status')
          .eq('candidate_id', candidateId)
          .eq('role_id', roleId)
          .order('created_at', { ascending: true })
          .limit(3),
        'reset_state_read_failed',
      );
    },
  };
}

function attemptSummary(attempt) {
  if (!attempt) return null;
  return {
    attempt: Number.isInteger(Number(attempt.attempt_number)) ? Number(attempt.attempt_number) : null,
    status: safeStatus(attempt.status),
  };
}

function resetAuthorizationState(resetEvents, interviewId) {
  const reset = (resetEvents || []).find((event) =>
    String(event?.previous_interview_id || '') === String(interviewId)
    || String(event?.replacement_interview_id || '') === String(interviewId));
  if (!reset) return 'not_recorded';
  const state = lowerText(reset.authorization_status);
  return ['authorized', 'consumed', 'expired', 'cancelled'].includes(state) ? state : 'unknown';
}

function buildDetailPayload({ interview, candidates, clients, roles, reports, events, attempts, resetEvents, now }) {
  const maps = {
    candidateById: mapRowsById(candidates),
    clientById: mapRowsById(clients),
    roleById: mapRowsById(roles),
  };
  const reportInterviewIds = new Set((reports || []).map((report) => String(report?.interview_id || '')));
  const row = buildInterviewRow(interview, maps, { now, reportInterviewIds });
  const processing = deriveProcessingStatus(interview, {
    now,
    reportAvailable: reportInterviewIds.has(String(interview.id)),
  });
  const timeline = (events || []).map((event) => sanitizeLifecycleEvent(event, row.started_at))
    .sort((a, b) =>
      compareNullable(parseDateMs(a.observed_timestamp) || parseDateMs(a.server_timestamp), parseDateMs(b.observed_timestamp) || parseDateMs(b.server_timestamp))
      || compareNullable(parseDateMs(a.server_timestamp), parseDateMs(b.server_timestamp)));
  const evidence = deriveEvidenceCompleteness(timeline, processing);
  const prior = (attempts || []).find((attempt) => String(attempt?.id || '') === String(interview?.previous_attempt_id || ''));
  const replacement = (attempts || []).find((attempt) => String(attempt?.previous_attempt_id || '') === String(interview?.id || ''));
  const anyReset = (resetEvents || []).length > 0;
  const anotherReplacementPermitted =
    interview?.replacement_eligible === true
    && Number(interview?.attempt_number || 0) < 2
    && !anyReset;
  return {
    interview: row,
    identity: {
      candidate: row.candidate,
      client: row.client,
      role: row.role,
      attempt: row.attempt,
      status: row.final_status,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_ms: row.duration_ms,
    },
    reliability: {
      classification: row.reliability_result,
      reconnect_count: row.reconnect_count,
      reconnect_outcome: row.reconnect,
      terminal_reason: row.terminal_reason,
      last_practical_progress_at: interview?.last_candidate_utterance_at || interview?.last_ai_utterance_at || interview?.last_vendor_event_at || null,
      participant_media_state: timeline.length ? 'see_timeline' : 'not_observed',
      browser_network_state: [...timeline].reverse().find((event) => event.technical_details.network_state)?.technical_details.network_state || 'not_observed',
      browser_visibility_state: [...timeline].reverse().find((event) => event.technical_details.visibility_state)?.technical_details.visibility_state || 'not_observed',
      evidence_completeness: evidence,
    },
    processing,
    timeline,
    attempts: {
      current_attempt: row.attempt,
      prior_attempt: attemptSummary(prior),
      replacement_attempt: attemptSummary(replacement),
      reset_only_authorization_state: resetAuthorizationState(resetEvents, interview.id),
      another_replacement_permitted: anotherReplacementPermitted,
      recovery_eligibility: {
        eligible: typeof interview?.replacement_eligible === 'boolean' ? interview.replacement_eligible : null,
        reason: recoveryReason(interview?.replacement_eligibility_reason),
        read_only: true,
      },
    },
  };
}

function createInterviewReliabilityReadService({ db, reader = null, now = () => new Date() } = {}) {
  const source = reader || createSupabaseReader(db);

  async function validateScope(filters) {
    const client = filters.client_id ? await source.validateClient(filters.client_id) : null;
    if (filters.client_id && !client) throw reliabilityError('invalid_scope', 'Client scope was not found.', 404);
    const role = filters.role_id ? await source.validateRole(filters.role_id) : null;
    if (filters.role_id && !role) throw reliabilityError('invalid_scope', 'Role scope was not found.', 404);
    if (role && filters.client_id && String(role.client_id) !== String(filters.client_id)) {
      throw reliabilityError('cross_client_scope', 'Role does not belong to the selected client.', 403);
    }
  }

  return {
    async list(query = {}) {
      const current = now();
      const filters = parseListQuery(query, current);
      await validateScope(filters);
      const interviews = await source.listInterviews(filters);
      if (interviews.length > MAX_SCAN_ROWS) {
        throw reliabilityError('result_set_too_large', 'Narrow the time range or client filters.', 422);
      }
      const [candidates, clients, roles, reports] = await Promise.all([
        source.readCandidates(uniqueIds(interviews, 'candidate_id')),
        source.readClients(uniqueIds(interviews, 'client_id')),
        source.readRoles(uniqueIds(interviews, 'role_id')),
        source.readReports(uniqueIds(interviews, 'id')),
      ]);
      const maps = {
        candidateById: mapRowsById(candidates),
        clientById: mapRowsById(clients),
        roleById: mapRowsById(roles),
      };
      const reportInterviewIds = new Set(reports.map((report) => String(report?.interview_id || '')));
      const allRows = interviews.map((interview) => buildInterviewRow(interview, maps, {
        now: current,
        reportInterviewIds,
      }));
      const matched = sortRows(applyDerivedFilters(allRows, filters), filters.sort, filters.direction);
      const start = (filters.page - 1) * filters.page_size;
      const items = matched.slice(start, start + filters.page_size);
      return {
        generated_at: current.toISOString(),
        filters: {
          ...filters,
          search: filters.search || null,
        },
        summary: buildSummary(matched),
        pagination: {
          page: filters.page,
          page_size: filters.page_size,
          total_items: matched.length,
          total_pages: Math.max(1, Math.ceil(matched.length / filters.page_size)),
        },
        filter_options: {
          clients: clients.map((client) => ({ id: String(client.id), name: trimText(client.name, 100) || 'Unknown client' }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          roles: roles.map((role) => ({ id: String(role.id), client_id: String(role.client_id || ''), name: trimText(role.title, 100) || 'Unknown role' }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
        items,
      };
    },

    async detail(interviewId, query = {}) {
      if (!UUID_RE.test(String(interviewId || ''))) throw reliabilityError('invalid_interview', 'Interview was not found.', 404);
      const filters = parseDetailQuery(query);
      await validateScope(filters);
      const interview = await source.readInterview(interviewId);
      if (!interview || (filters.client_id && String(interview.client_id) !== String(filters.client_id))) {
        throw reliabilityError('interview_not_found', 'Interview was not found.', 404);
      }
      const [candidates, clients, roles, reports, events, attempts, resetEvents] = await Promise.all([
        source.readCandidates(uniqueIds([interview], 'candidate_id')),
        source.readClients(uniqueIds([interview], 'client_id')),
        source.readRoles(uniqueIds([interview], 'role_id')),
        source.readReports([String(interview.id)]),
        source.readLifecycleEvents(interview.id),
        source.readAttempts(interview.candidate_id, interview.role_id),
        source.readResetEvents(interview.candidate_id, interview.role_id),
      ]);
      return buildDetailPayload({
        interview,
        candidates,
        clients,
        roles,
        reports,
        events,
        attempts,
        resetEvents,
        now: now(),
      });
    },
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SCAN_ROWS,
  PROCESSING_OVERDUE_MS,
  TECHNICAL_METADATA_FIELDS,
  buildDetailPayload,
  buildInterviewRow,
  buildSummary,
  createInterviewReliabilityReadService,
  deriveEvidenceCompleteness,
  deriveProcessingStatus,
  deriveReliabilityClassification,
  parseDetailQuery,
  parseListQuery,
  sanitizeLifecycleEvent,
};
