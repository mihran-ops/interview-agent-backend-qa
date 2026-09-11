'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PROCESSING_OVERDUE_MS,
  TECHNICAL_METADATA_FIELDS,
  createInterviewReliabilityReadService,
  deriveEvidenceCompleteness,
  deriveProcessingStatus,
  deriveReliabilityClassification,
  parseListQuery,
  sanitizeLifecycleEvent,
} = require('../src/services/interviewReliabilityReadService');

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';
const ROLE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROLE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CANDIDATE_A = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CANDIDATE_B = 'cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INTERVIEW_A = 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTERVIEW_B = 'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INTERVIEW_C = 'dccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-07-28T18:00:00.000Z');

function baseInterview(overrides = {}) {
  return {
    id: INTERVIEW_A,
    candidate_id: CANDIDATE_A,
    role_id: ROLE_A,
    client_id: CLIENT_A,
    status: 'Analyzed',
    created_at: '2026-07-28T16:00:00.000Z',
    updated_at: '2026-07-28T17:00:00.000Z',
    started_at: '2026-07-28T16:00:00.000Z',
    ended_at: '2026-07-28T16:20:00.000Z',
    attempt_number: 1,
    previous_attempt_id: null,
    replacement_authorization_id: null,
    is_active: false,
    has_substantive_response: true,
    substantive_response_count: 4,
    candidate_utterance_count: 5,
    conversation_progress_state: 'CandidateResponded',
    replacement_eligible: false,
    replacement_eligibility_reason: 'completed_interview_retake_blocked',
    client_end_reason: 'completed_normally',
    vendor_end_reason: 'vendor_end_event',
    reconnect_attempted: false,
    reconnect_attempt_count: 0,
    reconnect_result: null,
    watchdog_no_progress_at: null,
    last_candidate_utterance_at: '2026-07-28T16:18:00.000Z',
    last_ai_utterance_at: '2026-07-28T16:19:00.000Z',
    last_vendor_event_at: '2026-07-28T16:20:00.000Z',
    recording_status: 'ready',
    recording_ready_at: '2026-07-28T16:30:00.000Z',
    recording_deleted_at: null,
    transcript_available: true,
    transcript_scores: { secret_score_marker: 88 },
    interview_summary: 'SECRET_SUMMARY_MARKER',
    unanswered_candidate_questions: ['SECRET_QUESTION_MARKER'],
    interview_analysis_v2: { secret_analysis_marker: true },
    failure_code: null,
    failure_stage: null,
    failure_at: null,
    retryable: false,
    ...overrides,
  };
}

function lifecycleEvents(interviewId = INTERVIEW_A) {
  return [
    {
      id: `${interviewId}:1`,
      event_type: 'system.replica_joined',
      speaker_role: 'system',
      observed_at: '2026-07-28T16:00:01.000Z',
      received_at: '2026-07-28T16:00:01.100Z',
      metadata: {},
    },
    {
      id: `${interviewId}:2`,
      event_type: 'client.daily_remote_track_started',
      speaker_role: 'system',
      observed_at: '2026-07-28T16:00:02.000Z',
      received_at: '2026-07-28T16:00:02.100Z',
      metadata: { track_kind: 'audio', track_state: 'playable', unknown_secret: 'SECRET_METADATA_MARKER' },
    },
    {
      id: `${interviewId}:3`,
      event_type: 'client.progress_checkpoint_updated',
      speaker_role: 'system',
      observed_at: '2026-07-28T16:00:03.000Z',
      received_at: '2026-07-28T16:00:03.100Z',
      metadata: { progress_source: 'candidate_utterance', progress_age_ms: 0 },
    },
    {
      id: `${interviewId}:4`,
      event_type: 'client.interview_terminal_requested',
      speaker_role: 'system',
      observed_at: '2026-07-28T16:20:00.000Z',
      received_at: '2026-07-28T16:20:00.100Z',
      metadata: { terminal_reason: 'watchdog_timeout' },
    },
  ];
}

function createReader(overrides = {}) {
  const interviews = overrides.interviews || [
    baseInterview(),
    baseInterview({
      id: INTERVIEW_B,
      candidate_id: CANDIDATE_B,
      status: 'Incomplete',
      client_end_reason: 'watchdog_timeout',
      watchdog_no_progress_at: '2026-07-28T17:20:00.000Z',
      started_at: '2026-07-28T17:00:00.000Z',
      ended_at: '2026-07-28T17:20:00.000Z',
      created_at: '2026-07-28T17:00:00.000Z',
      updated_at: '2026-07-28T17:20:00.000Z',
      has_substantive_response: true,
      transcript_available: false,
      transcript_scores: {},
      interview_summary: null,
      unanswered_candidate_questions: [],
      interview_analysis_v2: null,
      recording_status: null,
      recording_ready_at: null,
      replacement_eligible: true,
      replacement_eligibility_reason: 'interview_reset_not_eligible',
      failure_code: 'INTERVIEW_PROGRESS_STALLED',
      failure_stage: 'live_interview',
      retryable: true,
    }),
    baseInterview({
      id: INTERVIEW_C,
      attempt_number: 2,
      previous_attempt_id: INTERVIEW_B,
      reconnect_attempted: true,
      reconnect_attempt_count: 1,
      reconnect_result: 'reconnect_succeeded',
    }),
  ];
  const clients = [
    { id: CLIENT_A, name: 'AlphaSource Test' },
    { id: CLIENT_B, name: 'Other QA Client' },
  ];
  const roles = [
    { id: ROLE_A, client_id: CLIENT_A, title: 'Internal Reliability Test' },
    { id: ROLE_B, client_id: CLIENT_B, title: 'Other Role' },
  ];
  const candidates = [
    { id: CANDIDATE_A, first_name: 'Synthetic', last_name: 'Canary' },
    { id: CANDIDATE_B, name: 'Minimal Evidence Fixture' },
  ];
  const calls = [];
  return {
    calls,
    async validateClient(id) {
      calls.push(['validateClient', id]);
      return clients.find((row) => row.id === id) || null;
    },
    async validateRole(id) {
      calls.push(['validateRole', id]);
      return roles.find((row) => row.id === id) || null;
    },
    async listInterviews(filters) {
      calls.push(['listInterviews', filters]);
      return interviews.filter((row) =>
        (!filters.client_id || row.client_id === filters.client_id)
        && (!filters.role_id || row.role_id === filters.role_id)
        && (!filters.status || String(row.status).toLowerCase() === filters.status)
        && (!filters.attempt || row.attempt_number === filters.attempt));
    },
    async readInterview(id) {
      calls.push(['readInterview', id]);
      return interviews.find((row) => row.id === id) || null;
    },
    async readCandidates(ids) {
      return candidates.filter((row) => ids.includes(row.id));
    },
    async readClients(ids) {
      return clients.filter((row) => ids.includes(row.id));
    },
    async readRoles(ids) {
      return roles.filter((row) => ids.includes(row.id));
    },
    async readReports(ids) {
      return ids.includes(INTERVIEW_A) ? [{ id: 'report-a', interview_id: INTERVIEW_A, created_at: NOW.toISOString() }] : [];
    },
    async readLifecycleEvents(id) {
      return overrides.eventsByInterview?.[id] || lifecycleEvents(id);
    },
    async readAttempts() {
      return interviews.map(({ id, status, attempt_number, previous_attempt_id, replacement_authorization_id, replacement_eligible, replacement_eligibility_reason, created_at }) => ({
        id,
        status,
        attempt_number,
        previous_attempt_id,
        replacement_authorization_id,
        replacement_eligible,
        replacement_eligibility_reason,
        created_at,
      }));
    },
    async readResetEvents() {
      return overrides.resetEvents || [];
    },
  };
}

function assertNoSensitiveContent(payload) {
  const serialized = JSON.stringify(payload);
  for (const marker of [
    'SECRET_SUMMARY_MARKER',
    'SECRET_QUESTION_MARKER',
    'secret_score_marker',
    'secret_analysis_marker',
    'SECRET_METADATA_MARKER',
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
  for (const forbiddenKey of [
    '"transcript_scores"',
    '"interview_summary"',
    '"unanswered_candidate_questions"',
    '"interview_analysis_v2"',
    '"metadata"',
    '"provider_conversation_id"',
    '"claim_token"',
    '"storage_reference"',
  ]) {
    assert.equal(serialized.includes(forbiddenKey), false, forbiddenKey);
  }
}

test('list query validation fails closed for unknown filters, malformed values, and oversized pages', () => {
  assert.equal(parseListQuery({}, NOW).page_size, 20);
  assert.throws(() => parseListQuery({ surprise: 'yes' }, NOW), /Unsupported filter/);
  assert.throws(() => parseListQuery({ page_size: '101' }, NOW), /page_size is invalid/);
  assert.throws(() => parseListQuery({ sort: 'candidate_email' }, NOW), /sort is invalid/);
  assert.throws(() => parseListQuery({ search: 'person@example.test' }, NOW), /search is invalid/);
  assert.throws(() => parseListQuery({ client_id: 'not-a-uuid' }, NOW), /client_id is invalid/);
});

test('classification and processing rules are deterministic at the one-hour existing product threshold', () => {
  const completed = baseInterview();
  const completeProcessing = deriveProcessingStatus(completed, { now: NOW });
  assert.equal(completeProcessing.overall, 'complete');
  assert.equal(deriveReliabilityClassification(completed, completeProcessing), 'healthy_completed');

  const pending = baseInterview({
    status: 'Ended',
    client_end_reason: 'vendor_end_event',
    updated_at: new Date(NOW.getTime() - PROCESSING_OVERDUE_MS + 1000).toISOString(),
    ended_at: new Date(NOW.getTime() - PROCESSING_OVERDUE_MS + 1000).toISOString(),
    transcript_available: false,
    transcript_scores: {},
    interview_summary: null,
    recording_status: null,
  });
  const pendingProcessing = deriveProcessingStatus(pending, { now: NOW });
  assert.equal(pendingProcessing.overall, 'pending');
  assert.equal(deriveReliabilityClassification(pending, pendingProcessing), 'processing_pending');

  const overdue = {
    ...pending,
    updated_at: new Date(NOW.getTime() - PROCESSING_OVERDUE_MS - 1).toISOString(),
    ended_at: new Date(NOW.getTime() - PROCESSING_OVERDUE_MS - 1).toISOString(),
  };
  const overdueProcessing = deriveProcessingStatus(overdue, { now: NOW });
  assert.equal(overdueProcessing.overall, 'overdue');
  assert.equal(deriveReliabilityClassification(overdue, overdueProcessing), 'processing_overdue');

  const watchdog = baseInterview({ status: 'Incomplete', client_end_reason: 'watchdog_timeout', watchdog_no_progress_at: NOW.toISOString() });
  assert.equal(deriveReliabilityClassification(watchdog, deriveProcessingStatus(watchdog, { now: NOW })), 'watchdog_timeout');
  const nonSubstantive = baseInterview({ status: 'Incomplete', has_substantive_response: false, transcript_scores: {}, interview_summary: null });
  assert.equal(deriveReliabilityClassification(nonSubstantive, deriveProcessingStatus(nonSubstantive, { now: NOW })), 'incomplete_non_substantive');
});

test('metadata projection allowlists bounded technical fields and strips arbitrary metadata', () => {
  const source = lifecycleEvents()[1];
  const sanitized = sanitizeLifecycleEvent(source, '2026-07-28T16:00:00.000Z');
  assert.deepEqual(sanitized.technical_details, {
    track_kind: 'audio',
    track_state: 'playable',
    webhook_latency_bucket: 'under_1_second',
  });
  assert.equal(Object.keys(sanitized.technical_details).every((key) => TECHNICAL_METADATA_FIELDS.includes(key)), true);
  assertNoSensitiveContent(sanitized);

  const invalidValues = sanitizeLifecycleEvent({
    ...source,
    metadata: {
      recovery_attempt: 99,
      participant_count: '2',
      remote_participant_present: 'true',
      network_state: 'SECRET_NETWORK_MARKER',
      terminal_reason: { secret: 'SECRET_NESTED_MARKER' },
    },
  }, '2026-07-28T16:00:00.000Z');
  assert.deepEqual(invalidValues.technical_details, { webhook_latency_bucket: 'under_1_second' });
  assert.equal(JSON.stringify(invalidValues).includes('SECRET_'), false);
});

test('provider occurrence and receipt timing derives bounded webhook latency without conflating late occurrence', () => {
  const underOne = sanitizeLifecycleEvent({
    event_type: 'system.replica_joined',
    observed_at: '2026-08-05T12:01:20.000Z',
    received_at: '2026-08-05T12:01:20.411Z',
    created_at: '2026-08-05T12:01:20.500Z',
    metadata: {},
  }, '2026-08-05T12:00:00.000Z');
  assert.equal(underOne.technical_details.webhook_latency_bucket, 'under_1_second');
  assert.equal(underOne.elapsed_ms, 80000);
  assert.equal(underOne.persistence_timestamp, '2026-08-05T12:01:20.500Z');

  for (const [received_at, expected] of [
    ['2026-08-05T12:00:04.000Z', '1_5_seconds'],
    ['2026-08-05T12:00:12.000Z', '5_15_seconds'],
    ['2026-08-05T12:00:20.000Z', 'over_15_seconds'],
  ]) {
    const result = sanitizeLifecycleEvent({
      event_type: 'system.replica_joined',
      observed_at: '2026-08-05T12:00:00.000Z',
      received_at,
      metadata: {},
    }, '2026-08-05T12:00:00.000Z');
    assert.equal(result.technical_details.webhook_latency_bucket, expected);
  }

  const unavailable = sanitizeLifecycleEvent({
    event_type: 'system.replica_joined',
    received_at: '2026-08-05T12:00:01.000Z',
    metadata: {},
  }, '2026-08-05T12:00:00.000Z');
  assert.equal('webhook_latency_bucket' in unavailable.technical_details, false);
});

test('new startup and media events render bounded labels and identity-free metadata', () => {
  const sanitized = sanitizeLifecycleEvent({
    event_type: 'client.daily_remote_participant_snapshot',
    observed_at: '2026-08-05T12:00:00.000Z',
    received_at: '2026-08-05T12:00:00.100Z',
    metadata: {
      remote_participant_count_bucket: 'one',
      audio_track_state: 'playable',
      video_track_state: 'loading',
      startup_readiness_state: 'remote_video_loading',
      participant_id: 'SECRET_PARTICIPANT_MARKER',
      track_id: 'SECRET_TRACK_MARKER',
    },
  }, '2026-08-05T12:00:00.000Z');
  assert.equal(sanitized.event, 'Remote participant snapshot');
  assert.deepEqual(sanitized.technical_details, {
    audio_track_state: 'playable',
    video_track_state: 'loading',
    remote_participant_count_bucket: 'one',
    startup_readiness_state: 'remote_video_loading',
    webhook_latency_bucket: 'under_1_second',
  });
  assert.equal(JSON.stringify(sanitized).includes('SECRET_'), false);
});

test('closing lifecycle diagnostics render bounded labels without raw payload data', () => {
  const sanitized = sanitizeLifecycleEvent({
    id: 'closing-event',
    interview_id: INTERVIEW_A,
    event_type: 'client.post_closing_question_violation',
    source: 'browser',
    occurred_at: '2026-07-28T16:00:00.000Z',
    received_at: '2026-07-28T16:00:00.100Z',
    metadata: {
      closing_state: 'FORCED_WIND_DOWN',
      remaining_time_bucket: '11_30',
      turn_index: 4,
      speech_interrupted: true,
      transcript_text: 'SECRET_TRANSCRIPT_MARKER',
      inference_id: 'SECRET_INFERENCE_MARKER',
    },
  }, '2026-07-28T16:00:01.000Z');

  assert.equal(sanitized.event_code, 'client.post_closing_question_violation');
  assert.equal(sanitized.event, 'Post-closing question blocked');
  assert.deepEqual(sanitized.technical_details, {
    closing_state: 'FORCED_WIND_DOWN',
    remaining_time_bucket: '11_30',
    turn_index: 4,
    speech_interrupted: true,
  });
  assert.equal(JSON.stringify(sanitized).includes('SECRET_'), false);
});

test('terminal-closing lifecycle diagnostics render canonical bounded labels', () => {
  const events = [
    ['client.closing_terminal_reserved', 'Terminal closing reserved'],
    ['client.closing_foreign_pal_audio_muted', 'Ordinary PAL audio muted'],
    ['client.closing_interrupt_dispatched', 'Closing interrupt dispatched'],
    ['client.closing_farewell_dispatched', 'Closing farewell dispatched'],
    ['client.closing_farewell_dispatch_failed', 'Closing farewell dispatch failed'],
    ['client.closing_farewell_started', 'Closing farewell started'],
    ['client.closing_farewell_completed', 'Closing farewell completed'],
    ['client.closing_farewell_interrupted', 'Closing farewell interrupted'],
    ['client.closing_foreign_inference_suppressed', 'Foreign closing inference suppressed'],
    ['client.closing_farewell_start_timed_out', 'Closing farewell start timed out'],
    ['client.closing_farewell_completion_timed_out', 'Closing farewell completion timed out'],
  ];
  for (const [event_type, expectedLabel] of events) {
    const sanitized = sanitizeLifecycleEvent({
      id: event_type,
      event_type,
      observed_at: '2026-08-04T12:00:00.000Z',
      received_at: '2026-08-04T12:00:00.100Z',
      metadata: {
        closing_state: 'FAREWELL_DISPATCHED',
        remaining_time_bucket: '0_10',
        raw_payload: 'SECRET_CLOSING_MARKER',
      },
    }, '2026-08-04T12:00:00.000Z');
    assert.equal(sanitized.event, expectedLabel);
    assert.equal(JSON.stringify(sanitized).includes('SECRET_CLOSING_MARKER'), false);
  }
});

test('single 20-second closing interrupt renders bounded evidence only', () => {
  const sanitized = sanitizeLifecycleEvent({
    id: 'single-closing-interrupt',
    interview_id: INTERVIEW_A,
    event_type: 'client.closing_forced_interrupt',
    source: 'browser',
    occurred_at: '2026-07-28T16:00:00.000Z',
    received_at: '2026-07-28T16:00:00.100Z',
    metadata: {
      closing_state: 'FINAL_FAREWELL_ELIGIBLE',
      remaining_time_bucket: '11_30',
      turn_index: 0,
      speech_interrupted: true,
      transcript_text: 'SECRET_TRANSCRIPT_MARKER',
      conversation_id: 'SECRET_CONVERSATION_MARKER',
    },
  }, '2026-07-28T16:00:01.000Z');

  assert.equal(sanitized.event_code, 'client.closing_forced_interrupt');
  assert.equal(sanitized.event, 'Final closing interrupt applied');
  assert.deepEqual(sanitized.technical_details, {
    closing_state: 'FINAL_FAREWELL_ELIGIBLE',
    remaining_time_bucket: '11_30',
    turn_index: 0,
    speech_interrupted: true,
  });
  assert.equal(JSON.stringify(sanitized).includes('SECRET_'), false);
});

test('single-flight farewell diagnostics expose bounded completion and deadline evidence only', () => {
  const sanitized = sanitizeLifecycleEvent({
    id: 'farewell-event',
    interview_id: INTERVIEW_A,
    event_type: 'client.closing_farewell_completed',
    source: 'browser',
    occurred_at: '2026-07-28T16:00:00.000Z',
    received_at: '2026-07-28T16:00:00.100Z',
    metadata: {
      closing_state: 'TERMINATION_ONLY',
      remaining_time_bucket: '0_10',
      turn_index: 5,
      hard_deadline: false,
      inference_id: 'SECRET_INFERENCE_MARKER',
      farewell_text: 'SECRET_FAREWELL_MARKER',
      conversation_id: 'SECRET_CONVERSATION_MARKER',
    },
  }, '2026-07-28T16:00:01.000Z');

  assert.equal(sanitized.event_code, 'client.closing_farewell_completed');
  assert.equal(sanitized.event, 'Closing farewell completed');
  assert.deepEqual(sanitized.technical_details, {
    closing_state: 'TERMINATION_ONLY',
    remaining_time_bucket: '0_10',
    turn_index: 5,
    hard_deadline: false,
  });
  assert.equal(JSON.stringify(sanitized).includes('SECRET_'), false);
});

test('final-closing audio lock evidence exposes bounded publication state only', () => {
  const sanitized = sanitizeLifecycleEvent({
    id: 'audio-lock-event',
    interview_id: INTERVIEW_A,
    event_type: 'client.closing_candidate_audio_locked',
    source: 'browser',
    occurred_at: '2026-07-28T16:00:00.000Z',
    received_at: '2026-07-28T16:00:00.100Z',
    metadata: {
      closing_state: 'FINAL_FAREWELL_ELIGIBLE',
      remaining_time_bucket: '11_30',
      lock_result_category: 'confirmed_disabled',
      audio_publication_enabled: false,
      attempt_count: 1,
      confirmation_source: 'participant_updated',
      publication_state: 'off',
      elapsed_time_bucket: '250_749',
      reconnect_active: false,
      participant_id: 'SECRET_PARTICIPANT_MARKER',
      provider_payload: 'SECRET_PROVIDER_MARKER',
    },
  }, '2026-07-28T16:00:01.000Z');

  assert.equal(sanitized.event_code, 'client.closing_candidate_audio_locked');
  assert.equal(sanitized.event, 'Candidate audio publication locked');
  assert.deepEqual(sanitized.technical_details, {
    closing_state: 'FINAL_FAREWELL_ELIGIBLE',
    remaining_time_bucket: '11_30',
    lock_result_category: 'confirmed_disabled',
    audio_publication_enabled: false,
    attempt_count: 1,
    confirmation_source: 'participant_updated',
    publication_state: 'off',
    elapsed_time_bucket: '250_749',
    reconnect_active: false,
  });
  assert.equal(JSON.stringify(sanitized).includes('SECRET_'), false);
});

test('asynchronous audio-lock timeout diagnostics remain bounded and content-free', () => {
  const sanitized = sanitizeLifecycleEvent({
    id: 'audio-lock-timeout-event',
    interview_id: INTERVIEW_A,
    event_type: 'client.closing_candidate_audio_lock_timed_out',
    source: 'browser',
    occurred_at: '2026-07-28T16:00:00.000Z',
    received_at: '2026-07-28T16:00:00.100Z',
    metadata: {
      closing_state: 'FINAL_FAREWELL_ELIGIBLE',
      remaining_time_bucket: '11_30',
      lock_result_category: 'timed_out',
      confirmation_source: 'none',
      publication_state: 'loading',
      elapsed_time_bucket: '1500_1999',
      timeout_category: 'bounded_timeout',
      attempt_count: 1,
      reconnect_active: false,
      participant_id: 'SECRET_PARTICIPANT_MARKER',
      raw_daily_payload: 'SECRET_DAILY_MARKER',
    },
  }, '2026-07-28T16:00:02.000Z');

  assert.equal(sanitized.event_code, 'client.closing_candidate_audio_lock_timed_out');
  assert.equal(sanitized.event, 'Candidate audio lock confirmation timed out');
  assert.deepEqual(sanitized.technical_details, {
    closing_state: 'FINAL_FAREWELL_ELIGIBLE',
    remaining_time_bucket: '11_30',
    lock_result_category: 'timed_out',
    confirmation_source: 'none',
    publication_state: 'loading',
    elapsed_time_bucket: '1500_1999',
    timeout_category: 'bounded_timeout',
    attempt_count: 1,
    reconnect_active: false,
  });
  assert.equal(JSON.stringify(sanitized).includes('SECRET_'), false);
});

test('zero-deadline local closing diagnostics render bounded labels without content', () => {
  const sanitized = sanitizeLifecycleEvent({
    id: 'local-closing-event',
    interview_id: INTERVIEW_A,
    event_type: 'client.local_closing_audio_completed',
    source: 'browser',
    occurred_at: '2026-07-28T16:00:00.000Z',
    received_at: '2026-07-28T16:00:00.100Z',
    metadata: {
      closing_state: 'LOCAL_CLOSING',
      remaining_time_bucket: '0_10',
      playback_result_category: 'completed',
      audio_duration_bucket: '4_5_seconds',
      transcript_text: 'SECRET_TRANSCRIPT_MARKER',
      closing_text: 'SECRET_CLOSING_MARKER',
      provider_conversation_id: 'SECRET_PROVIDER_MARKER',
      file_path: 'SECRET_PATH_MARKER',
    },
  }, '2026-07-28T16:00:01.000Z');

  assert.equal(sanitized.event_code, 'client.local_closing_audio_completed');
  assert.equal(sanitized.event, 'Local closing audio completed');
  assert.deepEqual(sanitized.technical_details, {
    closing_state: 'LOCAL_CLOSING',
    remaining_time_bucket: '0_10',
    playback_result_category: 'completed',
    audio_duration_bucket: '4_5_seconds',
  });
  assert.equal(JSON.stringify(sanitized).includes('SECRET_'), false);
});

test('evidence completeness is a documented signal count, not an AI score', () => {
  const timeline = lifecycleEvents().map((event) => sanitizeLifecycleEvent(event, '2026-07-28T16:00:00.000Z'));
  const complete = deriveEvidenceCompleteness(timeline, { completed_interview: true, transcript_reconciliation: 'complete' });
  assert.equal(complete.level, 'complete');
  assert.equal(Object.values(complete.signals).every(Boolean), true);
  const minimal = deriveEvidenceCompleteness([], { completed_interview: false, transcript_reconciliation: 'not_applicable' });
  assert.equal(minimal.level, 'minimal');
});

test('list supports server scope, filters, pagination, sorting, bounded search, and matching summary counts', async () => {
  const reader = createReader();
  const service = createInterviewReliabilityReadService({ reader, now: () => NOW });
  const page = await service.list({
    time_range: '7d',
    client_id: CLIENT_A,
    failure_category: 'watchdog_timeout',
    search: 'Minimal Evidence',
    sort: 'started_at',
    direction: 'desc',
    page: '1',
    page_size: '1',
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].interview_id, INTERVIEW_B);
  assert.equal(page.pagination.total_items, 1);
  assert.equal(page.summary.total_interviews, 1);
  assert.equal(page.summary.watchdog_terminated, 1);
  assert.equal(page.summary.incomplete, 1);
  assert.equal(reader.calls.some(([name]) => name === 'validateClient'), true);
  assertNoSensitiveContent(page);
});

test('cross-client role scope and detail scope fail closed', async () => {
  const service = createInterviewReliabilityReadService({ reader: createReader(), now: () => NOW });
  await assert.rejects(
    service.list({ client_id: CLIENT_A, role_id: ROLE_B }),
    (error) => error?.code === 'cross_client_scope' && error?.status === 403,
  );
  await assert.rejects(
    service.detail(INTERVIEW_A, { client_id: CLIENT_B }),
    (error) => error?.code === 'interview_not_found' && error?.status === 404,
  );
});

test('detail returns ordered attempt-bound timeline, relationships, read-only eligibility, and no sensitive content', async () => {
  const reader = createReader({
    resetEvents: [{
      previous_interview_id: INTERVIEW_B,
      replacement_interview_id: INTERVIEW_C,
      authorization_status: 'consumed',
      reset_mode: 'reset_only',
    }],
  });
  const service = createInterviewReliabilityReadService({ reader, now: () => NOW });
  const detail = await service.detail(INTERVIEW_C, { client_id: CLIENT_A });
  assert.equal(detail.identity.attempt, 2);
  assert.equal(detail.attempts.prior_attempt.attempt, 1);
  assert.equal(detail.attempts.reset_only_authorization_state, 'consumed');
  assert.equal(detail.attempts.another_replacement_permitted, false);
  assert.equal(detail.attempts.recovery_eligibility.read_only, true);
  assert.equal(detail.timeline.length, 4);
  assert.deepEqual(
    detail.timeline.map((event) => event.server_timestamp),
    [...detail.timeline.map((event) => event.server_timestamp)].sort(),
  );
  assert.equal(detail.reliability.evidence_completeness.level, 'complete');
  assertNoSensitiveContent(detail);
});

test('no-event interviews remain viewable with minimal evidence', async () => {
  const reader = createReader({ eventsByInterview: { [INTERVIEW_B]: [] } });
  const service = createInterviewReliabilityReadService({ reader, now: () => NOW });
  const detail = await service.detail(INTERVIEW_B);
  assert.deepEqual(detail.timeline, []);
  assert.equal(detail.reliability.evidence_completeness.level, 'minimal');
});

test('authoritative lifecycle storage has attempt-bound uniqueness and ordered lookup indexes', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260717120000_candidate_incident_phase_b.sql'),
    'utf8',
  );
  assert.match(migration, /unique \(interview_id, dedupe_key\)/);
  assert.match(migration, /interview_lifecycle_vendor_event_uidx/);
  assert.match(migration, /on public\.interview_lifecycle_events \(interview_id, received_at desc\)/);
});
