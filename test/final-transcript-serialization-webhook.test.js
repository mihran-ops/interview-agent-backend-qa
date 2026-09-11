'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const IS_REAL_SENTRY_PROBE = process.env.FINAL_TRANSCRIPT_REAL_SENTRY_PROBE === '1';
const REAL_SENTRY_EVENTS = [];
let REAL_SENTRY = null;
if (IS_REAL_SENTRY_PROBE) {
  REAL_SENTRY = require('@sentry/node');
  REAL_SENTRY.init({
    dsn: 'https://public@example.invalid/1',
    environment: 'final-transcript-privacy-test',
    integrations: [
      REAL_SENTRY.httpIntegration(),
      REAL_SENTRY.expressIntegration(),
    ],
    sendClientReports: false,
    spotlight: false,
    tracesSampleRate: 0,
    transport: () => ({
      async send(envelope) {
        for (const [itemHeader, payload] of envelope?.[1] || []) {
          if (itemHeader?.type === 'event') {
            REAL_SENTRY_EVENTS.push(structuredClone(payload));
          }
        }
        return {};
      },
      async flush() {
        return true;
      },
    }),
  });
}
const express = require('express');
const WEBHOOK_SECRET = Buffer.alloc(32, 11).toString('base64url');
process.env.TAVUS_WEBHOOK_SECRET = WEBHOOK_SECRET;

const ID = {
  candidate: '76000000-0000-4000-8000-000000000001',
  client: '76000000-0000-4000-8000-000000000002',
  role: '76000000-0000-4000-8000-000000000003',
  interview: '76000000-0000-4000-8000-000000000004',
  otherInterview: '76000000-0000-4000-8000-000000000005',
  conversation: 'synthetic-final-transcript-conversation',
  token: '76000000-0000-4000-8000-000000000006',
};
const PRIVACY_SENTINELS = Object.freeze({
  requestBody: 'privacy-probe-request-body',
  nestedBody: 'privacy-probe-nested-body',
  authorization: 'privacy-probe-authorization',
  cookie: 'privacy-probe-cookie',
  providerHeader: 'privacy-probe-provider-header',
  query: 'privacy-probe-query',
  route: 'privacy-probe-route',
  scopeTag: 'privacy-probe-scope-tag',
  scopeExtra: 'privacy-probe-scope-extra',
  scopeUser: 'privacy-probe-scope-user',
  scopeContext: 'privacy-probe-scope-context',
  breadcrumb: 'privacy-probe-breadcrumb',
  rawMessage: 'privacy-probe-raw-message',
  rawStack: 'privacy-probe-raw-stack',
  rawCause: 'privacy-probe-raw-cause',
  supabase: 'privacy-probe-supabase-diagnostic',
  eventKey: 'privacy-probe-event-key',
  transcriptHash: 'privacy-probe-transcript-hash',
  transcriptContent: 'privacy-probe-transcript-content',
  summaryContent: 'privacy-probe-summary-content',
  scoreContent: 'privacy-probe-score-content',
  questionContent: 'privacy-probe-question-content',
  databaseUrl: 'https://database.invalid/rest/v1/interviews',
  providerId: ID.conversation,
  interviewId: ID.interview,
  candidateId: ID.candidate,
  claimToken: ID.token,
  providerEventId: 'synthetic-final-event',
  storageReference: 'transcripts/private-storage-reference',
});
const RAW_DIAGNOSTIC = [
  PRIVACY_SENTINELS.rawMessage,
  PRIVACY_SENTINELS.rawStack,
  PRIVACY_SENTINELS.rawCause,
  PRIVACY_SENTINELS.supabase,
  PRIVACY_SENTINELS.databaseUrl,
  ID.interview,
  ID.candidate,
  ID.conversation,
  ID.token,
  PRIVACY_SENTINELS.storageReference,
  PRIVACY_SENTINELS.eventKey,
  PRIVACY_SENTINELS.transcriptHash,
].join('|');

const routePath = path.join(__dirname, '..', 'src', 'routes', 'webhooks', 'tavus.js');
const scoringPath = path.join(__dirname, '..', 'src', 'services', 'interviewScoring.js');
const roleAvailabilityPath = path.join(__dirname, '..', 'src', 'services', 'roleInterviewAvailability.js');
const backfillPath = path.join(__dirname, '..', 'scripts', 'backfillInterviews.js');
const analysisV2Path = path.join(__dirname, '..', 'src', 'services', 'interviewAnalysisV2.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function makeRawProbeError() {
  const error = new Error(RAW_DIAGNOSTIC);
  error.stack = `Error: ${PRIVACY_SENTINELS.rawMessage}\n${PRIVACY_SENTINELS.rawStack}`;
  error.cause = new Error(PRIVACY_SENTINELS.rawCause);
  return error;
}

function makeRawProbeDatabaseError() {
  return {
    message: RAW_DIAGNOSTIC,
    details: RAW_DIAGNOSTIC,
    hint: PRIVACY_SENTINELS.supabase,
    cause: makeRawProbeError(),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isValidSyntheticQuestionPayload(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return false;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 10_000) return false;
  const seen = new Set();
  for (const question of value) {
    if (typeof question !== 'string' ||
        question !== question.trim() ||
        [...question].length < 1 ||
        [...question].length > 1_000 ||
        seen.has(question)) {
      return false;
    }
    seen.add(question);
  }
  return true;
}

function syntheticAnalysisV2(call = 1) {
  return {
    version: 'path_a_v1',
    scores: {
      response_specificity: 70 + call,
      answer_directness: 70,
      answer_consistency: 70,
      communication_structure: 70,
    },
    conditions: {
      evaluation_conditions: 'good',
      audio_quality_issues: 'none',
      distraction_risk: 'low',
      signal_confidence: 'high',
    },
    risk: {
      integrity_risk: 'low',
      reason: 'Synthetic bounded reason.',
    },
    evidence_summary: `Synthetic bounded analysis ${call}.`,
    evidence: ['Synthetic bounded evidence.'],
    limitations: [],
  };
}

function syntheticTranscriptScores(overrides = {}) {
  return {
    overall: 70,
    role_fit: 70,
    technical_strength: 70,
    communication_quality: 70,
    confidence: 70,
    ai_aided_risk: 'low',
    ai_aided_risk_reason: 'Synthetic evidence.',
    ...overrides,
  };
}

function isValidSyntheticAnalysisV2(value) {
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.version === 'path_a_v1' &&
    value.scores &&
    typeof value.scores === 'object' &&
    value.conditions &&
    typeof value.conditions === 'object' &&
    value.risk &&
    typeof value.risk === 'object' &&
    typeof value.evidence_summary === 'string' &&
    Array.isArray(value.evidence) &&
    Array.isArray(value.limitations) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= 32_768;
}

function syntheticAnalysisClaimToken(version) {
  return `76000000-0000-4000-8002-${String(version).padStart(12, '0')}`;
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.operation = 'select';
    this.value = null;
  }
  select() { return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  update(value) {
    this.operation = 'update';
    this.value = value;
    return this;
  }
  async execute() {
    if (this.table === 'roles') {
      return { data: { id: ID.role, job_description_text: 'Synthetic role context.' }, error: null };
    }
    if (this.table !== 'interviews') throw new Error(`unexpected_table:${this.table}`);
    const row = this.db.interview;
    const bindingColumn = this.filters.at(-1)?.[0];
    if (this.operation === 'select' && bindingColumn === 'tavus_application_id') {
      if (this.db.options.primaryBindingThrow) {
        const rawError = makeRawProbeError();
        this.db.tracker.rawBindingErrors.push(rawError);
        throw rawError;
      }
      if (this.db.options.primaryBindingError) {
        const rawError = makeRawProbeDatabaseError();
        this.db.tracker.rawBindingErrors.push(rawError);
        return { data: null, error: rawError };
      }
      if (this.db.options.primaryBindingNoRow) {
        return { data: null, error: null };
      }
    }
    if (this.operation === 'select' && bindingColumn === 'conversation_id') {
      if (this.db.options.secondaryBindingError) {
        const rawError = makeRawProbeDatabaseError();
        this.db.tracker.rawBindingErrors.push(rawError);
        return { data: null, error: rawError };
      }
    }
    const matches = this.filters.every(([key, value]) => String(row?.[key] ?? '') === String(value ?? ''));
    if (this.operation === 'update') {
      this.db.tracker.directUpdates += 1;
      if (Object.hasOwn(this.value || {}, 'interview_analysis_v2')) {
        this.db.tracker.analysisV2Updates += 1;
        const analysisUpdateCall = this.db.tracker.analysisV2DirectPersistenceCalls += 1;
        if (typeof this.db.options.analysisV2DirectPersistenceBarrier === 'function') {
          await this.db.options.analysisV2DirectPersistenceBarrier({
            call: analysisUpdateCall,
          });
        }
      }
      if (Object.hasOwn(this.value || {}, 'unanswered_candidate_questions')) {
        this.db.tracker.questionUpdates += 1;
        const questionCall = this.db.tracker.questionPersistenceCalls += 1;
        if (typeof this.db.options.questionPersistenceBarrier === 'function') {
          await this.db.options.questionPersistenceBarrier({
            call: questionCall,
            mode: 'direct_update',
          });
        }
        if (this.db.options.questionUpdateError) {
          return { data: null, error: makeRawProbeDatabaseError() };
        }
      }
      if (matches) Object.assign(row, structuredClone(this.value));
      if (Object.hasOwn(this.value || {}, 'interview_analysis_v2') &&
          typeof this.db.options.analysisV2DirectPersistenceComplete === 'function') {
        this.db.options.analysisV2DirectPersistenceComplete({
          call: this.db.tracker.analysisV2DirectPersistenceCalls,
        });
      }
      if (Object.hasOwn(this.value || {}, 'unanswered_candidate_questions') &&
          typeof this.db.options.questionPersistenceComplete === 'function') {
        this.db.options.questionPersistenceComplete({
          call: this.db.tracker.questionPersistenceCalls,
          mode: 'direct_update',
          outcome: matches ? 'stored' : 'interview_not_found',
        });
      }
      return { data: null, error: null };
    }
    return { data: matches ? structuredClone(row) : null, error: null };
  }
  maybeSingle() { return this.execute(); }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

function makeDb(options = {}) {
  const tracker = {
    claimCalls: 0,
    finalizeCalls: 0,
    releaseCalls: 0,
    scoreCalls: 0,
    storageUploads: 0,
    directUpdates: 0,
    analysisV2Calls: 0,
    analysisV2Inputs: [],
    analysisV2Updates: 0,
    analysisV2DirectPersistenceCalls: 0,
    analysisV2ClaimCalls: 0,
    analysisV2ClaimOutcomes: [],
    analysisV2FinalizeCalls: 0,
    analysisV2FinalizeOutcomes: [],
    analysisV2ReleaseCalls: 0,
    analysisV2ReleaseOutcomes: [],
    questionUpdates: 0,
    questionPersistenceCalls: 0,
    questionRpcCalls: 0,
    questionRpcOutcomes: [],
    sentryCaptures: [],
    sentryTags: [],
    rawBindingErrors: [],
    rpcArgs: [],
  };
  const db = {
    tracker,
    options,
    interview: {
      id: ID.interview,
      candidate_id: ID.candidate,
      client_id: ID.client,
      role_id: ID.role,
      tavus_application_id: ID.conversation,
      status: options.status || 'Incomplete',
      failure_code: options.failureCode === undefined ? 'INTERVIEW_PROGRESS_STALLED' : options.failureCode,
      failure_stage: 'live_interview',
      failure_summary: 'Synthetic watchdog termination.',
      failure_at: '2026-07-23T18:12:40.000Z',
      retryable: true,
      replacement_eligible: true,
      has_substantive_response: options.hasSubstantive ?? false,
      candidate_utterance_count: options.candidateUtteranceCount ?? 0,
      substantive_response_count: options.substantiveResponseCount ?? 0,
      utterance_classification_counts: options.classificationCounts || {},
      conversation_progress_state: options.progress || 'WaitingForAnswer',
      transcript: options.transcript || null,
      transcript_url: options.transcriptUrl || null,
      transcript_scores: options.scores || null,
      interview_summary: options.summary || null,
      interview_analysis_v2: options.analysisV2 || null,
      perception_scores: {},
      perception_analysis_text: null,
      analysis: null,
      unanswered_candidate_questions: options.unansweredQuestions === undefined
        ? []
        : structuredClone(options.unansweredQuestions),
      attempt_number: 1,
      previous_attempt_id: null,
      replacement_authorization_id: null,
      created_at: '2026-07-23T18:09:20.000Z',
    },
    finalTranscriptClaim: {
      processing_state: 'available',
      claim_version: 0,
      authoritative_transcript_hash: null,
      authoritative_transcript_storage_ref: null,
    },
    analysisV2Claim: {
      processing_state: options.analysisV2ClaimState || 'available',
      claim_token: options.analysisV2ClaimToken || null,
      claim_version: options.analysisV2ClaimVersion || 0,
      expected_transcript_claim_version: options.analysisV2ExpectedTranscriptClaimVersion || null,
      expected_transcript_hash: options.analysisV2ExpectedTranscriptHash || null,
      completed_transcript_claim_version: options.analysisV2CompletedTranscriptClaimVersion || null,
      completed_transcript_hash: options.analysisV2CompletedTranscriptHash || null,
      completed_claim_token: options.analysisV2CompletedClaimToken || null,
      lease_expired: options.analysisV2LeaseExpired === true,
      last_released_claim_token: null,
    },
    pendingClaim: null,
    from(table) { return new FakeQuery(db, table); },
    async rpc(name, args) {
      tracker.rpcArgs.push({ name, args: structuredClone(args) });
      if (name === 'claim_interview_final_transcript_reconciliation') {
        tracker.claimCalls += 1;
        if (options.claimError) return { data: null, error: makeRawProbeDatabaseError() };
        const outcome = options.claimOutcome || 'claimed';
        const claimVersion = options.dynamicClaims
          ? db.finalTranscriptClaim.claim_version + 1
          : (options.claimVersion || 1);
        if (['claimed', 'recovered_expired_claim'].includes(outcome)) {
          db.pendingClaim = {
            claim_version: claimVersion,
            transcript_hash: args.p_transcript_hash,
          };
          db.finalTranscriptClaim.processing_state = 'claimed';
          db.finalTranscriptClaim.claim_version = claimVersion;
        }
        return {
          data: [{
            outcome,
            claim_token: ID.token,
            claim_version: claimVersion,
            lease_expires_at: '2026-07-24T22:00:00.000Z',
            scoring_required: options.scoringRequired !== false,
          }],
          error: null,
        };
      }
      if (name === 'finalize_interview_final_transcript_reconciliation') {
        tracker.finalizeCalls += 1;
        if (options.finalizeError) return { data: null, error: makeRawProbeDatabaseError() };
        const outcome = options.finalizeOutcome || 'finalized';
        if (outcome === 'finalized') {
          db.interview.transcript = args.p_normalized_transcript;
          db.interview.transcript_url = args.p_transcript_storage_ref;
          if (args.p_transcript_scores !== null) {
            db.interview.transcript_scores = structuredClone(args.p_transcript_scores);
          }
          if (args.p_interview_summary !== null) {
            db.interview.interview_summary = args.p_interview_summary;
          }
          Object.assign(db.interview, {
            has_substantive_response: args.p_evidence_snapshot.has_substantive_response,
            substantive_response_count: args.p_evidence_snapshot.substantive_response_count,
            candidate_utterance_count: args.p_evidence_snapshot.candidate_utterance_count,
            utterance_classification_counts: structuredClone(args.p_evidence_snapshot.classification_counts),
            conversation_progress_state: args.p_evidence_snapshot.conversation_progress_state,
          });
          db.finalTranscriptClaim = {
            processing_state: 'completed',
            claim_version: args.p_claim_version,
            authoritative_transcript_hash: args.p_transcript_hash,
            authoritative_transcript_storage_ref: args.p_transcript_storage_ref,
          };
          db.pendingClaim = null;
        }
        return {
          data: [{
            outcome,
            authoritative_snapshot_source: 'incoming',
            canonical_repair_applied: true,
            status_before: db.interview.status,
            status_after: db.interview.status,
            progress_before: db.interview.conversation_progress_state,
            progress_after: 'CandidateResponded',
          }],
          error: null,
        };
      }
      if (name === 'release_interview_final_transcript_reconciliation') {
        tracker.releaseCalls += 1;
        return { data: [{ outcome: 'released' }], error: options.releaseError ? { message: 'synthetic release failure' } : null };
      }
      if (name === 'persist_interview_unanswered_questions_if_authoritative') {
        tracker.questionRpcCalls += 1;
        const questionCall = tracker.questionPersistenceCalls += 1;
        if (typeof options.questionPersistenceBarrier === 'function') {
          await options.questionPersistenceBarrier({
            call: questionCall,
            mode: 'rpc',
          });
        }
        if (options.questionUpdateError) {
          return { data: null, error: makeRawProbeDatabaseError() };
        }

        let outcome;
        if (!isValidSyntheticQuestionPayload(args.p_questions)) {
          outcome = 'invalid_questions';
        } else if (!db.interview || db.interview.id !== args.p_interview_id) {
          outcome = 'interview_not_found';
        } else if (
          db.finalTranscriptClaim.processing_state !== 'completed' ||
          db.finalTranscriptClaim.claim_version !== args.p_expected_claim_version ||
          db.finalTranscriptClaim.authoritative_transcript_hash !== args.p_expected_transcript_hash
        ) {
          outcome = 'superseded';
        } else if (
          db.interview.unanswered_candidate_questions != null &&
          (!Array.isArray(db.interview.unanswered_candidate_questions) ||
            db.interview.unanswered_candidate_questions.length > 0)
        ) {
          outcome = 'already_present';
        } else {
          db.interview.unanswered_candidate_questions = structuredClone(args.p_questions);
          tracker.questionUpdates += 1;
          outcome = 'stored';
        }
        tracker.questionRpcOutcomes.push(outcome);
        if (typeof options.questionPersistenceComplete === 'function') {
          options.questionPersistenceComplete({
            call: questionCall,
            mode: 'rpc',
            outcome,
          });
        }
        return { data: [{ outcome }], error: null };
      }
      if (name === 'claim_interview_analysis_v2_if_authoritative') {
        tracker.analysisV2ClaimCalls += 1;
        if (options.analysisV2ClaimError) {
          return { data: null, error: makeRawProbeDatabaseError() };
        }
        const state = db.analysisV2Claim;
        const currentVersion = db.finalTranscriptClaim.claim_version;
        const currentHash = db.finalTranscriptClaim.authoritative_transcript_hash;
        let outcome = options.analysisV2ClaimOutcome || null;
        if (!outcome) {
          if (
            db.finalTranscriptClaim.processing_state !== 'completed' ||
            currentVersion !== args.p_expected_transcript_claim_version ||
            currentHash !== args.p_expected_transcript_hash
          ) {
            outcome = 'superseded';
          } else if (
            state.processing_state === 'completed' &&
            state.completed_transcript_claim_version === currentVersion &&
            state.completed_transcript_hash === currentHash &&
            isValidSyntheticAnalysisV2(db.interview.interview_analysis_v2)
          ) {
            outcome = 'already_current';
          } else if (
            db.interview.interview_analysis_v2 &&
            state.completed_transcript_claim_version == null &&
            state.completed_transcript_hash == null
          ) {
            outcome = 'analysis_present_unversioned';
          } else if (
            state.processing_state === 'claimed' &&
            state.expected_transcript_claim_version === currentVersion &&
            state.expected_transcript_hash === currentHash &&
            !state.lease_expired
          ) {
            outcome = 'busy';
          } else {
            outcome = state.processing_state === 'claimed' &&
              state.expected_transcript_claim_version === currentVersion &&
              state.expected_transcript_hash === currentHash &&
              state.lease_expired
              ? 'recovered_expired_claim'
              : 'claimed';
          }
        }

        if (['claimed', 'recovered_expired_claim'].includes(outcome)) {
          state.processing_state = 'claimed';
          state.claim_version += 1;
          state.claim_token = syntheticAnalysisClaimToken(state.claim_version);
          state.expected_transcript_claim_version = currentVersion;
          state.expected_transcript_hash = currentHash;
          state.lease_expired = false;
        }
        tracker.analysisV2ClaimOutcomes.push(outcome);
        return {
          data: [{
            outcome,
            analysis_claim_token: ['claimed', 'recovered_expired_claim'].includes(outcome)
              ? state.claim_token
              : null,
            analysis_claim_version: state.claim_version,
            lease_expires_at: ['claimed', 'recovered_expired_claim'].includes(outcome)
              ? '2026-07-24T22:00:00.000Z'
              : null,
          }],
          error: null,
        };
      }
      if (name === 'finalize_interview_analysis_v2_if_authoritative') {
        tracker.analysisV2FinalizeCalls += 1;
        if (options.analysisV2FinalizeError) {
          return { data: null, error: makeRawProbeDatabaseError() };
        }
        if (typeof options.analysisV2FinalizeBarrier === 'function') {
          await options.analysisV2FinalizeBarrier({
            call: tracker.analysisV2FinalizeCalls,
            args: structuredClone(args),
          });
        }
        const state = db.analysisV2Claim;
        let outcome;
        if (!isValidSyntheticAnalysisV2(args.p_analysis)) {
          outcome = 'invalid_analysis';
        } else if (
          state.processing_state === 'completed' &&
          state.completed_claim_token === args.p_analysis_claim_token &&
          state.claim_version === args.p_analysis_claim_version &&
          state.completed_transcript_claim_version === args.p_expected_transcript_claim_version &&
          state.completed_transcript_hash === args.p_expected_transcript_hash
        ) {
          outcome = 'already_current';
        } else if (
          state.processing_state !== 'claimed' ||
          state.claim_token !== args.p_analysis_claim_token ||
          state.claim_version !== args.p_analysis_claim_version
        ) {
          outcome = 'stale_claim';
        } else if (
          db.finalTranscriptClaim.processing_state !== 'completed' ||
          db.finalTranscriptClaim.claim_version !== args.p_expected_transcript_claim_version ||
          db.finalTranscriptClaim.authoritative_transcript_hash !== args.p_expected_transcript_hash
        ) {
          outcome = 'superseded';
        } else {
          db.interview.interview_analysis_v2 = structuredClone(args.p_analysis);
          tracker.analysisV2Updates += 1;
          state.processing_state = 'completed';
          state.completed_claim_token = state.claim_token;
          state.claim_token = null;
          state.completed_transcript_claim_version = args.p_expected_transcript_claim_version;
          state.completed_transcript_hash = args.p_expected_transcript_hash;
          state.expected_transcript_claim_version = null;
          state.expected_transcript_hash = null;
          outcome = 'stored';
        }
        tracker.analysisV2FinalizeOutcomes.push(outcome);
        if (typeof options.analysisV2FinalizeComplete === 'function') {
          options.analysisV2FinalizeComplete({
            call: tracker.analysisV2FinalizeCalls,
            outcome,
          });
        }
        return { data: [{ outcome }], error: null };
      }
      if (name === 'release_interview_analysis_v2_claim') {
        tracker.analysisV2ReleaseCalls += 1;
        const state = db.analysisV2Claim;
        let outcome;
        if (
          state.processing_state === 'claimed' &&
          state.claim_token === args.p_analysis_claim_token &&
          state.claim_version === args.p_analysis_claim_version
        ) {
          state.last_released_claim_token = state.claim_token;
          state.claim_token = null;
          state.expected_transcript_claim_version = null;
          state.expected_transcript_hash = null;
          state.processing_state = state.completed_transcript_claim_version == null
            ? 'available'
            : 'completed';
          outcome = 'released';
        } else {
          outcome = 'claim_mismatch';
        }
        tracker.analysisV2ReleaseOutcomes.push(outcome);
        return { data: [{ outcome }], error: options.analysisV2ReleaseError
          ? makeRawProbeDatabaseError()
          : null };
      }
      throw new Error(`unexpected_rpc:${name}`);
    },
    storage: {
      async listBuckets() { return { data: [{ name: 'transcripts' }], error: null }; },
      from() {
        return {
          upload: async () => {
            tracker.storageUploads += 1;
            return { error: options.uploadError ? makeRawProbeDatabaseError() : null };
          },
        };
      },
    },
  };
  return db;
}

function buildApp(db, buildOptions = {}) {
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
  process.env.ENABLE_INTERVIEW_ANALYSIS_V2 = db.options.analysisV2Enabled ? 'true' : 'false';

  const realScoring = require(scoringPath);
  injectModule(scoringPath, {
    ...realScoring,
    scoreInterview: async (input) => {
      const call = db.tracker.scoreCalls += 1;
      if (db.options.scoringError) throw makeRawProbeError();
      if (typeof db.options.scoringResultFactory === 'function') {
        return db.options.scoringResultFactory({ call, input: structuredClone(input) });
      }
      return {
        summary: db.options.realSentryProbe
          ? PRIVACY_SENTINELS.summaryContent
          : 'Synthetic scored summary.',
        transcript_scores: syntheticTranscriptScores(),
      };
    },
  });
  injectModule(roleAvailabilityPath, {
    getRoleInterviewAvailability: async () => ({ remaining_interviews: null }),
    syncRoleInterviewLimitNotification: async () => {},
  });
  injectModule(backfillPath, { analyzeInterviewTranscriptById: async () => ({ ok: true, skipped: true }) });
  injectModule(analysisV2Path, {
    generateInterviewAnalysisV2: async (input) => {
      const call = db.tracker.analysisV2Calls += 1;
      db.tracker.analysisV2Inputs.push({
        request_id: input.request_id,
        conversation_id: input.conversation_id,
        transcript_hash: crypto.createHash('sha256').update(String(input.transcript || '')).digest('hex'),
        score_overall: input.transcript_scores?.overall,
        interview_summary: input.interview_summary,
      });
      if (typeof db.options.analysisV2GenerationBarrier === 'function') {
        await db.options.analysisV2GenerationBarrier({ call, input: structuredClone(input) });
      }
      if (db.options.analysisV2Error) throw new Error(RAW_DIAGNOSTIC);
      if (db.options.analysisV2InvalidOutput) return { invalid: true };
      return typeof db.options.analysisV2ResultFactory === 'function'
        ? db.options.analysisV2ResultFactory({ call, input: structuredClone(input) })
        : syntheticAnalysisV2(call);
    },
  });

  const originalLoad = Module._load;
  class MockSentryScope {
    setClient(client) {
      this.client = client;
      return this;
    }
    addEventProcessor(processor) {
      this.processor = processor;
      return this;
    }
  }
  class MockSentryNodeClient {
    constructor(options) {
      this.options = options;
      this.hooks = {};
    }
    init() {}
    on(name, callback) {
      this.hooks[name] = callback;
    }
    close() {
      return Promise.resolve(true);
    }
    captureEvent(event) {
      if (db.options.sentryCaptureThrow) throw makeRawProbeError();
      const preparedEvent = {
        ...event,
        event_id: event?.event_id || 'synthetic-sentry-event-id',
        timestamp: event?.timestamp || 1,
        request: { data: PRIVACY_SENTINELS.requestBody },
        user: { id: PRIVACY_SENTINELS.scopeUser },
        contexts: { trace: { trace_id: PRIVACY_SENTINELS.scopeContext } },
      };
      const processedEvent = this.options.beforeSend(preparedEvent);
      const error = new Error(processedEvent.exception.values[0].value);
      error.stack = `Error: ${error.message}`;
      db.tracker.sentryCaptures.push({
        error,
        context: {},
        processedEvent: structuredClone(processedEvent),
      });
      this.hooks.afterSendEvent?.(processedEvent, {});
    }
  }
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../src/clients/supabase' && /routes\/webhook\.js$/.test(parent?.filename || '')) {
      return { supabaseAdmin: db, supabase: db };
    }
    if (request === '@sentry/node' && buildOptions.realSentry !== true) {
      return {
        NodeClient: MockSentryNodeClient,
        Scope: MockSentryScope,
        addBreadcrumb: () => {},
        setTag: (name, value) => db.tracker.sentryTags.push([name, value]),
        getClient: () => ({
          name: 'mock-sentry-client',
          getOptions: () => ({}),
        }),
        withIsolationScope: (_scope, callback) => callback(),
        captureException: (error, context) => {
          if (db.options.sentryCaptureThrow) throw makeRawProbeError();
          const initialEvent = {
            event_id: 'synthetic-sentry-event-id',
            timestamp: 1,
            platform: 'node',
            exception: {
              values: [{
                type: error?.name || 'Error',
                value: error?.message,
              }],
            },
          };
          db.tracker.sentryCaptures.push({
            error,
            context: structuredClone(context || {}),
            processedEvent: structuredClone(initialEvent),
          });
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[routePath];
  try {
    const router = require(routePath);
    const app = express();
    if (buildOptions.realSentry === true) {
      app.use((req, _res, next) => {
        const Sentry = require('@sentry/node');
        Sentry.setTag('privacy_probe_tag', PRIVACY_SENTINELS.scopeTag);
        Sentry.setExtra('privacy_probe_extra', PRIVACY_SENTINELS.scopeExtra);
        Sentry.setUser({
          id: PRIVACY_SENTINELS.scopeUser,
          email: `${PRIVACY_SENTINELS.scopeUser}@example.invalid`,
        });
        Sentry.setContext('privacy_probe_context', {
          value: PRIVACY_SENTINELS.scopeContext,
          route: PRIVACY_SENTINELS.route,
        });
        Sentry.addBreadcrumb({
          category: 'privacy_probe',
          message: PRIVACY_SENTINELS.breadcrumb,
          data: { value: PRIVACY_SENTINELS.breadcrumb },
        });
        next();
      });
    }
    app.use('/webhook', router);
    return {
      app,
      router,
      restore() {
        Module._load = originalLoad;
        for (const filename of [routePath, scoringPath, roleAvailabilityPath, backfillPath, analysisV2Path]) {
          delete require.cache[filename];
        }
      },
    };
  } catch (error) {
    Module._load = originalLoad;
    throw error;
  }
}

async function postTranscription(app, overrides = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const queryParams = new URLSearchParams({ tavus_webhook_token: WEBHOOK_SECRET });
    if (overrides.privacyProbe) queryParams.set('probe', PRIVACY_SENTINELS.query);
    const query = `?${queryParams.toString()}`;
    return await fetch(`http://127.0.0.1:${server.address().port}/webhook/tavus${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(overrides.privacyProbe ? {
          authorization: `Bearer ${PRIVACY_SENTINELS.authorization}`,
          cookie: `probe=${PRIVACY_SENTINELS.cookie}`,
          'x-provider-probe': PRIVACY_SENTINELS.providerHeader,
        } : {}),
      },
      body: JSON.stringify({
        event_type: 'application.transcription_ready',
        event_id: 'synthetic-final-event',
        ...(overrides.privacyProbe ? {
          privacy_probe_body: PRIVACY_SENTINELS.requestBody,
          privacy_probe_nested: {
            value: PRIVACY_SENTINELS.nestedBody,
          },
        } : {}),
        ...(!overrides.omitConversationId
          ? { conversation_id: overrides.conversationId || ID.conversation }
          : {}),
        ...(overrides.interviewId ? { interview_id: overrides.interviewId } : {}),
        properties: {
          transcript: overrides.transcript || [
            { role: 'assistant', content: 'Describe a synthetic project.' },
            { role: 'user', content: 'I built a synthetic system and improved the project workflow.' },
          ],
        },
      }),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postWebhookEvent(app, body, fetchImpl = fetch) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const query = new URLSearchParams({ tavus_webhook_token: WEBHOOK_SECRET });
    return await fetchImpl(`http://127.0.0.1:${server.address().port}/webhook/tavus?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withScenario(options, callback) {
  const db = makeDb(options);
  const { app, router, restore } = buildApp(db);
  try {
    await callback(app, db, router);
  } finally {
    await drainDeferred();
    restore();
  }
}

async function drainDeferred() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function captureConsole(callback) {
  const captured = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  for (const method of Object.keys(original)) {
    console[method] = (...args) => captured.push(args);
  }
  try {
    await callback();
  } finally {
    Object.assign(console, original);
  }
  return captured;
}

function assertNoReconciliationSideEffects(db) {
  assert.equal(db.tracker.claimCalls, 0);
  assert.equal(db.tracker.scoreCalls, 0);
  assert.equal(db.tracker.storageUploads, 0);
  assert.equal(db.tracker.finalizeCalls, 0);
  assert.equal(db.tracker.directUpdates, 0);
  assert.equal(db.tracker.analysisV2Calls, 0);
  assert.equal(db.tracker.analysisV2ClaimCalls, 0);
  assert.equal(db.tracker.analysisV2FinalizeCalls, 0);
  assert.equal(db.tracker.analysisV2ReleaseCalls, 0);
  assert.equal(db.tracker.questionUpdates, 0);
  assert.equal(db.tracker.questionRpcCalls, 0);
}

if (!IS_REAL_SENTRY_PROBE) test('current Tavus end_call tool ends the provider conversation and requests interview ending', async () => {
  await withScenario({ failureCode: null }, async (app, db, router) => {
    const previousApiKey = process.env.TAVUS_API_KEY;
    const providerCalls = [];
    process.env.TAVUS_API_KEY = 'synthetic-tavus-key';
    router._setTavusHttpClientForTest({
      async endConversation(conversationId) {
        providerCalls.push({ conversationId, method: 'POST' });
        return null;
      },
    });

    try {
      const response = await postWebhookEvent(app, {
        event_type: 'conversation.tool_call',
        conversation_id: ID.conversation,
        tool_name: 'end_call',
        tool_arguments: { reason: 'natural_conclusion' },
      });
      assert.equal(response.status, 200);
      assert.equal(providerCalls.length, 1);
      assert.equal(providerCalls[0].conversationId, ID.conversation);
      assert.equal(providerCalls[0].method, 'POST');
      assert.equal(db.interview.status, 'ending_requested');
    } finally {
      router._setTavusHttpClientForTest(null);
      if (previousApiKey === undefined) delete process.env.TAVUS_API_KEY;
      else process.env.TAVUS_API_KEY = previousApiKey;
    }
  });
});

function serializedSentry(tracker) {
  return JSON.stringify({
    captures: tracker.sentryCaptures.map(({ error, context }) => ({
      message: error?.message,
      stack: error?.stack,
      context,
    })),
    tags: tracker.sentryTags,
  });
}

function realSentryProbeScenarioOptions(scenario) {
  const options = {
    analysisV2Enabled: ['analysis_claim', 'analysis_v2', 'analysis_finalize'].includes(scenario),
    realSentryProbe: true,
  };
  if (scenario === 'binding') options.primaryBindingError = true;
  if (scenario === 'claim') options.claimError = true;
  if (scenario === 'scoring') options.scoringError = true;
  if (scenario === 'storage') options.uploadError = true;
  if (scenario === 'finalize') options.finalizeError = true;
  if (scenario === 'unexpected') options.primaryBindingThrow = true;
  if (scenario === 'analysis_claim') options.analysisV2ClaimError = true;
  if (scenario === 'analysis_v2') options.analysisV2Error = true;
  if (scenario === 'analysis_finalize') options.analysisV2FinalizeError = true;
  if (scenario === 'questions') options.questionUpdateError = true;
  if (scenario === 'invalid_scores') {
    options.scoringResultFactory = () => ({
      summary: PRIVACY_SENTINELS.summaryContent,
      transcript_scores: {
        role_fit: 70,
        technical_strength: 70,
        communication_quality: 70,
        confidence: 70,
        ai_aided_risk: 'low',
        ai_aided_risk_reason: PRIVACY_SENTINELS.scoreContent,
      },
    });
  }
  return options;
}

async function runRealSentryProbeChild() {
  const scenario = process.env.FINAL_TRANSCRIPT_REAL_SENTRY_SCENARIO;
  const db = makeDb(realSentryProbeScenarioOptions(scenario));
  const { app, restore } = buildApp(db, { realSentry: true });
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const capturedConsole = [];
  for (const method of Object.keys(originalConsole)) {
    console[method] = (...args) => capturedConsole.push(args);
  }

  let response;
  let responseBody;
  try {
    const overrides = {
      privacyProbe: true,
      transcript: [
        { role: 'assistant', content: 'Describe a synthetic project.' },
        {
          role: 'user',
          content: `I completed the synthetic project successfully. ${PRIVACY_SENTINELS.transcriptContent}`,
        },
      ],
    };
    if (scenario === 'questions') {
      overrides.transcript = [{
        role: 'user',
        content: `I completed the synthetic project. [[UNANSWERED_QUESTION: ${PRIVACY_SENTINELS.questionContent}?]]`,
      }];
    }
    response = await postTranscription(app, overrides);
    responseBody = await response.json();
    await drainDeferred();
    await REAL_SENTRY.flush(2_000);
  } finally {
    restore();
    Object.assign(console, originalConsole);
    try {
      await REAL_SENTRY.close(2_000);
    } catch {}
  }

  process.stdout.write(`${JSON.stringify({
    scenario,
    status: response?.status || null,
    responseBody,
    capturedConsole,
    events: REAL_SENTRY_EVENTS,
  })}\n`);
}

function runRealSentryProbe(scenario) {
  const result = spawnSync(
    process.execPath,
    [__filename],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        FINAL_TRANSCRIPT_REAL_SENTRY_PROBE: '1',
        FINAL_TRANSCRIPT_REAL_SENTRY_SCENARIO: scenario,
        SENTRY_DSN: '',
      },
      timeout: 20_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `real SDK probe child failed for ${scenario}: ${String(result.stderr || '').slice(0, 500)}`,
  );
  return JSON.parse(result.stdout);
}

function findPrivacyLeakLabels(value) {
  const serialized = JSON.stringify(value);
  return Object.entries(PRIVACY_SENTINELS)
    .filter(([, sentinel]) => serialized.includes(sentinel))
    .map(([label]) => label);
}

function assertSafeProcessedSentryEvent(probe, expected) {
  assert.equal(probe.status, expected.status);
  assert.equal(probe.events.length, 1, `${probe.scenario} must emit exactly one Sentry event`);
  assert.deepEqual(
    findPrivacyLeakLabels({
      responseBody: probe.responseBody,
      capturedConsole: probe.capturedConsole,
      event: probe.events[0],
    }),
    [],
    `${probe.scenario} leaked synthetic privacy marker labels`,
  );

  const event = probe.events[0];
  assert.deepEqual(Object.keys(event).sort(), [
    'event_id',
    'exception',
    'fingerprint',
    'level',
    'platform',
    'sdk',
    'tags',
    'timestamp',
  ]);
  assert.equal(Object.hasOwn(event, 'contexts'), false);
  assert.deepEqual(event.tags, {
    operation: 'final_transcript_reconciliation',
    failure_category: expected.category,
    stage: expected.stage,
    retryable: expected.retryable ? 'true' : 'false',
    http_class: expected.httpClass,
  });
  assert.deepEqual(event.fingerprint, [
    'final_transcript_reconciliation',
    expected.category,
  ]);
  assert.equal(event.level, 'error');
  assert.equal(event.platform, 'node');
  assert.deepEqual(event.exception, {
    values: [{
      type: 'FinalTranscriptReconciliationFailure',
      value: `final_transcript_reconciliation_failed:${expected.category}`,
      mechanism: {
        type: 'generic',
        handled: true,
      },
    }],
  });
  for (const forbiddenField of [
    'request',
    'user',
    'extra',
    'breadcrumbs',
    'message',
    'transaction',
    'server_name',
    'modules',
  ]) {
    assert.equal(
      Object.hasOwn(event, forbiddenField),
      false,
      `${probe.scenario} event retained forbidden field ${forbiddenField}`,
    );
  }
}

if (!IS_REAL_SENTRY_PROBE) {
test('failed claim persistence is retryable and performs no scoring, upload, or direct update', async () => {
  await withScenario({ claimError: true }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 503);
    assert.equal(db.tracker.scoreCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.directUpdates, 0);
  });
});

test('busy claim is retryable with Retry-After and performs no mutation', async () => {
  await withScenario({ claimOutcome: 'busy' }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 503);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal(db.tracker.scoreCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.finalizeCalls, 0);
  });
});

test('identical completed callback is an idempotent success without scoring, upload, or update', async () => {
  await withScenario({ claimOutcome: 'already_reconciled' }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    assert.equal(db.tracker.scoreCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.finalizeCalls, 0);
    assert.equal(db.tracker.directUpdates, 0);
  });
});

test('database-rejected malformed or unknown-key evidence fails closed before scoring or storage', async () => {
  await withScenario({ claimOutcome: 'invalid_snapshot' }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 422);
    assert.equal(db.tracker.scoreCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.finalizeCalls, 0);
  });
});

test('weaker sparse callback is a safe no-op and cannot overwrite transcript state', async () => {
  await withScenario({
    claimOutcome: 'superseded_by_stronger_evidence',
    transcript: 'STRONG_TRANSCRIPT_SENTINEL',
    transcriptUrl: 'STRONG_LINK_SENTINEL',
  }, async (app, db) => {
    const response = await postTranscription(app, {
      transcript: [{ role: 'user', content: 'Okay.' }],
    });
    assert.equal(response.status, 200);
    assert.equal(db.interview.transcript, 'STRONG_TRANSCRIPT_SENTINEL');
    assert.equal(db.interview.transcript_url, 'STRONG_LINK_SENTINEL');
    assert.equal(db.tracker.scoreCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.finalizeCalls, 0);
  });
});

test('failed scoring releases the exact claim best effort and returns retryable non-2xx', async () => {
  await withScenario({ scoringError: true }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 503);
    assert.equal(db.tracker.claimCalls, 1);
    assert.equal(db.tracker.scoreCalls, 1);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.finalizeCalls, 0);
    assert.equal(db.tracker.releaseCalls, 1);
  });
});

test('malformed truthy scorer output fails before upload, finalize, or downstream work', async (t) => {
  const missingKey = syntheticTranscriptScores();
  delete missingKey.overall;
  const cases = [
    ['empty object', {}],
    ['missing key', missingKey],
    ['unknown key', syntheticTranscriptScores({ unexpected: true })],
    ['wrong type', syntheticTranscriptScores({ overall: '70' })],
    ['out of range', syntheticTranscriptScores({ overall: 101 })],
    ['invalid enum', syntheticTranscriptScores({ ai_aided_risk: 'unknown' })],
    ['oversized', syntheticTranscriptScores({ ai_aided_risk_reason: 'x'.repeat(20_000) })],
    ['non-finite', syntheticTranscriptScores({ overall: Number.NaN })],
  ];

  for (const [name, scores] of cases) {
    await t.test(name, async () => {
      let scenarioDb;
      let responseBody;
      const captured = await captureConsole(async () => {
        await withScenario({
          analysisV2Enabled: true,
          scoringResultFactory: () => ({
            summary: 'Synthetic bounded summary.',
            transcript_scores: scores,
          }),
        }, async (app, db) => {
          scenarioDb = db;
          const response = await postTranscription(app, {
            transcript: [{
              role: 'user',
              content: 'I designed the synthetic workflow, implemented its validation, measured the result, and improved the failure handling. [[UNANSWERED_QUESTION: hidden score-contract question?]]',
            }],
          });
          assert.equal(response.status, 503);
          responseBody = await response.json();
          await drainDeferred();
        });
      });

      assert.deepEqual(responseBody, {
        ok: false,
        outcome: 'invalid_transcript_scores',
        retryable: true,
      });
      assert.equal(scenarioDb.tracker.claimCalls, 1);
      assert.equal(scenarioDb.tracker.scoreCalls, 1);
      assert.equal(scenarioDb.tracker.releaseCalls, 1);
      assert.equal(scenarioDb.tracker.storageUploads, 0);
      assert.equal(scenarioDb.tracker.finalizeCalls, 0);
      assert.equal(scenarioDb.tracker.directUpdates, 0);
      assert.equal(scenarioDb.tracker.questionRpcCalls, 0);
      assert.equal(scenarioDb.tracker.analysisV2ClaimCalls, 0);
      assert.equal(scenarioDb.tracker.analysisV2Calls, 0);
      assert.equal(scenarioDb.tracker.sentryCaptures.length, 1);
      assert.equal(
        scenarioDb.tracker.sentryCaptures[0].error.message,
        'final_transcript_reconciliation_failed:invalid_transcript_scores',
      );
      const output = JSON.stringify({
        responseBody,
        captured,
        sentry: serializedSentry(scenarioDb.tracker),
      });
      assert.doesNotMatch(output, /hidden score-contract|unexpected|20000/i);
    });
  }
});

test('exact valid scorer output still reaches one upload and one coherent finalize', async () => {
  await withScenario({
    scoringResultFactory: () => ({
      summary: 'Synthetic bounded summary.',
      transcript_scores: syntheticTranscriptScores(),
    }),
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    assert.equal(db.tracker.scoreCalls, 1);
    assert.equal(db.tracker.storageUploads, 1);
    assert.equal(db.tracker.finalizeCalls, 1);
    assert.equal(db.tracker.releaseCalls, 0);
  });
});

test('failed immutable transcript upload releases the exact claim and returns retryable non-2xx', async () => {
  await withScenario({ uploadError: true }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 503);
    assert.equal(db.tracker.storageUploads, 1);
    assert.equal(db.tracker.finalizeCalls, 0);
    assert.equal(db.tracker.releaseCalls, 1);
  });
});

test('failed finalize persistence is never acknowledged as success', async () => {
  await withScenario({ finalizeError: true }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 503);
    assert.equal(db.tracker.finalizeCalls, 1);
    assert.equal(db.tracker.releaseCalls, 1);
  });
});

test('historically scored stale row is conservatively rescored before finalize', async () => {
  await withScenario({
    scores: { overall: 70, confidence: 70 },
    summary: 'Existing synthetic score.',
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    assert.equal(db.tracker.scoreCalls, 1);
    assert.equal(db.tracker.storageUploads, 1);
    assert.equal(db.tracker.finalizeCalls, 1);
  });
});

test('claimed transcript cannot finalize while preserving unbound existing scores and summary', async () => {
  await withScenario({
    scoringRequired: false,
    scores: { overall: 70, confidence: 70 },
    summary: 'Existing synthetic score.',
  }, async (app, db) => {
    const before = structuredClone(db.interview);
    const response = await postTranscription(app);
    assert.equal(response.status, 503);
    assert.equal(db.tracker.scoreCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.finalizeCalls, 0);
    assert.deepEqual(db.interview, before);
  });
});

test('completed interview path does not perform application-level status or evidence writes', async () => {
  await withScenario({
    status: 'Completed',
    failureCode: null,
    hasSubstantive: true,
    candidateUtteranceCount: 1,
    substantiveResponseCount: 1,
    classificationCounts: { substantive_answer: 1 },
    progress: 'CandidateResponded',
    scores: { overall: 70, confidence: 70 },
    summary: 'Existing completed score.',
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    assert.equal(db.interview.status, 'Completed');
    assert.equal(db.tracker.directUpdates, 0);
    assert.equal(db.tracker.scoreCalls, 1);
  });
});

test('contradictory interview and conversation binding fails closed without touching another row', async () => {
  await withScenario({}, async (app, db) => {
    const before = structuredClone(db.interview);
    const response = await postTranscription(app, { interviewId: ID.otherInterview });
    assert.equal(response.status, 409);
    assert.deepEqual(db.interview, before);
    assert.equal(db.tracker.claimCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.directUpdates, 0);
  });
});

test('interview-id-only callback is rejected by the common envelope before any reconciliation mutation', async () => {
  await withScenario({}, async (app, db) => {
    const before = structuredClone(db.interview);
    const response = await postTranscription(app, {
      interviewId: ID.interview,
      omitConversationId: true,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'invalid_webhook_payload',
    });
    assert.deepEqual(db.interview, before);
    assert.equal(db.tracker.claimCalls, 0);
    assert.equal(db.tracker.scoreCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.finalizeCalls, 0);
    assert.equal(db.tracker.directUpdates, 0);
  });
});

test('unknown provider conversation fails closed before reconciliation', async () => {
  await withScenario({}, async (app, db) => {
    const before = structuredClone(db.interview);
    const response = await postTranscription(app, {
      conversationId: 'unknown-synthetic-provider-conversation',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      ok: false,
      outcome: 'binding_not_found',
      retryable: false,
    });
    assert.deepEqual(db.interview, before);
    assert.equal(db.tracker.claimCalls, 0);
    assert.equal(db.tracker.scoreCalls, 0);
    assert.equal(db.tracker.storageUploads, 0);
    assert.equal(db.tracker.finalizeCalls, 0);
    assert.equal(db.tracker.directUpdates, 0);
  });
});

test('primary provider-binding query error is retryable, sanitized, and side-effect free', async () => {
  let responseBody;
  let scenarioDb;
  const captured = await captureConsole(async () => {
    await withScenario({ primaryBindingError: true }, async (app, db) => {
      scenarioDb = db;
      const response = await postTranscription(app);
      assert.equal(response.status, 503);
      responseBody = await response.json();
      assert.deepEqual(responseBody, {
        ok: false,
        outcome: 'binding_lookup_failed',
        retryable: true,
      });
      assertNoReconciliationSideEffects(db);
    });
  });

  assert.equal(scenarioDb.tracker.sentryCaptures.length, 1);
  assert.notEqual(
    scenarioDb.tracker.sentryCaptures[0].error,
    scenarioDb.tracker.rawBindingErrors[0],
  );
  assert.equal(
    scenarioDb.tracker.sentryCaptures[0].error.message,
    'final_transcript_reconciliation_failed:binding_lookup_failed',
  );
  const allOutput = JSON.stringify({
    responseBody,
    captured,
    sentry: serializedSentry(scenarioDb.tracker),
  });
  assert.doesNotMatch(allOutput, /raw-supabase-diagnostic|database\.invalid|private-storage-reference/i);
  assert.doesNotMatch(allOutput, /76000000-|synthetic-final-transcript-conversation/i);
});

test('secondary provider-binding query error is retryable, sanitized, and side-effect free', async () => {
  let scenarioDb;
  const captured = await captureConsole(async () => {
    await withScenario({
      primaryBindingNoRow: true,
      secondaryBindingError: true,
    }, async (app, db) => {
      scenarioDb = db;
      const response = await postTranscription(app);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        ok: false,
        outcome: 'binding_lookup_failed',
        retryable: true,
      });
      assertNoReconciliationSideEffects(db);
    });
  });

  assert.equal(scenarioDb.tracker.sentryCaptures.length, 1);
  const allOutput = JSON.stringify({
    captured,
    sentry: serializedSentry(scenarioDb.tracker),
  });
  assert.doesNotMatch(allOutput, /raw-supabase-diagnostic|database\.invalid|private-storage-reference/i);
  assert.doesNotMatch(allOutput, /76000000-|synthetic-final-transcript-conversation/i);
});

test('unexpected final-event exception reaches Sentry only as a bounded synthetic error', async () => {
  let scenarioDb;
  const captured = await captureConsole(async () => {
    await withScenario({ primaryBindingThrow: true }, async (app, db) => {
      scenarioDb = db;
      const response = await postTranscription(app);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        ok: false,
        outcome: 'unexpected_failure',
        retryable: true,
      });
      assertNoReconciliationSideEffects(db);
    });
  });

  assert.equal(scenarioDb.tracker.sentryCaptures.length, 1);
  assert.notEqual(
    scenarioDb.tracker.sentryCaptures[0].error,
    scenarioDb.tracker.rawBindingErrors[0],
  );
  assert.equal(
    scenarioDb.tracker.sentryCaptures[0].error.message,
    'final_transcript_reconciliation_failed:unexpected_failure',
  );
  assert.equal(
    scenarioDb.tracker.sentryCaptures[0].error.stack,
    'Error: final_transcript_reconciliation_failed:unexpected_failure',
  );
  const allOutput = JSON.stringify({
    captured,
    sentry: serializedSentry(scenarioDb.tracker),
  });
  assert.doesNotMatch(allOutput, /raw-supabase-diagnostic|database\.invalid|private-storage-reference/i);
  assert.doesNotMatch(allOutput, /76000000-|synthetic-final-transcript-conversation/i);
});

test('Sentry capture failure cannot change final-transcript HTTP semantics or leak diagnostics', async () => {
  let responseBody;
  const captured = await captureConsole(async () => {
    await withScenario({
      primaryBindingError: true,
      sentryCaptureThrow: true,
    }, async (app) => {
      const response = await postTranscription(app);
      assert.equal(response.status, 503);
      responseBody = await response.json();
    });
  });

  assert.deepEqual(responseBody, {
    ok: false,
    outcome: 'binding_lookup_failed',
    retryable: true,
  });
  assert.deepEqual(findPrivacyLeakLabels({ responseBody, captured }), []);
  assert.match(JSON.stringify(captured), /final_transcript_sentry_capture_failed/);
});

test('new finalization preserves Analysis V2 under its existing enabled gate', async () => {
  await withScenario({ analysisV2Enabled: true }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.analysisV2ClaimCalls, 1);
    assert.equal(db.tracker.analysisV2Calls, 1);
    assert.equal(db.tracker.analysisV2FinalizeCalls, 1);
    assert.equal(db.tracker.analysisV2Updates, 1);
    assert.equal(db.tracker.analysisV2Inputs[0].conversation_id, ID.conversation);
    assert.ok(db.tracker.analysisV2Inputs[0].request_id);
  });
});

test('stronger transcript finalization and Analysis V2 receive one coherent score source', async () => {
  const options = {
    analysisV2Enabled: true,
    dynamicClaims: true,
    scoringResultFactory: ({ call }) => ({
      summary: `Synthetic scored summary version ${call}.`,
      transcript_scores: {
        overall: 70 + call,
        role_fit: 70,
        technical_strength: 70,
        communication_quality: 70,
        confidence: 70,
        ai_aided_risk: 'low',
        ai_aided_risk_reason: 'Synthetic evidence.',
      },
    }),
  };

  await withScenario(options, async (app, db) => {
    const first = await postTranscription(app, {
      transcript: [
        { role: 'assistant', content: 'Describe one synthetic task.' },
        { role: 'user', content: 'I built a synthetic system and improved the project workflow.' },
      ],
    });
    assert.equal(first.status, 200);
    await drainDeferred();

    const second = await postTranscription(app, {
      transcript: [
        { role: 'assistant', content: 'Describe two synthetic tasks.' },
        { role: 'user', content: 'I completed two synthetic tasks with measurable results.' },
        { role: 'user', content: 'I improved the synthetic workflow as well.' },
      ],
    });
    assert.equal(second.status, 200);
    await drainDeferred();

    const finalizeCalls = db.tracker.rpcArgs.filter(
      ({ name }) => name === 'finalize_interview_final_transcript_reconciliation',
    );
    assert.equal(db.tracker.scoreCalls, 2);
    assert.equal(finalizeCalls.length, 2);
    assert.notEqual(
      finalizeCalls[0].args.p_transcript_hash,
      finalizeCalls[1].args.p_transcript_hash,
    );
    assert.equal(finalizeCalls[0].args.p_transcript_scores.overall, 71);
    assert.equal(finalizeCalls[1].args.p_transcript_scores.overall, 72);
    assert.equal(finalizeCalls[0].args.p_interview_summary, 'Synthetic scored summary version 1.');
    assert.equal(finalizeCalls[1].args.p_interview_summary, 'Synthetic scored summary version 2.');
    assert.equal(db.interview.transcript_scores.overall, 72);
    assert.equal(db.interview.interview_summary, 'Synthetic scored summary version 2.');
    assert.equal(db.tracker.analysisV2Inputs.length, 2);
    assert.equal(db.tracker.analysisV2Inputs[1].transcript_hash, db.finalTranscriptClaim.authoritative_transcript_hash);
    assert.equal(db.tracker.analysisV2Inputs[1].score_overall, 72);
    assert.equal(
      db.tracker.analysisV2Inputs[1].interview_summary,
      'Synthetic scored summary version 2.',
    );
  });
});

test('overlapping stronger-version Analysis V2 cannot be overwritten by a stale weaker worker', async () => {
  const weakerGenerationStarted = deferred();
  const resumeWeakerGeneration = deferred();
  const strongerStored = deferred();
  const options = {
    analysisV2Enabled: true,
    dynamicClaims: true,
    analysisV2GenerationBarrier: async ({ call }) => {
      if (call === 1) {
        weakerGenerationStarted.resolve();
        await resumeWeakerGeneration.promise;
      }
    },
    analysisV2FinalizeComplete: ({ call, outcome }) => {
      if (call === 1 && outcome === 'stored') strongerStored.resolve();
    },
    analysisV2DirectPersistenceComplete: ({ call }) => {
      if (call === 1) strongerStored.resolve();
    },
  };

  await withScenario(options, async (app, db) => {
    const weaker = await postTranscription(app, {
      transcript: [
        { role: 'assistant', content: 'Describe one synthetic task.' },
        { role: 'user', content: 'I built a synthetic system and improved the project workflow.' },
      ],
    });
    assert.equal(weaker.status, 200);
    await weakerGenerationStarted.promise;

    const stronger = await postTranscription(app, {
      transcript: [
        { role: 'assistant', content: 'Describe two synthetic tasks.' },
        { role: 'user', content: 'I completed two synthetic tasks with measurable results.' },
        { role: 'user', content: 'I improved the synthetic workflow as well.' },
      ],
    });
    assert.equal(stronger.status, 200);
    await strongerStored.promise;
    resumeWeakerGeneration.resolve();
    await drainDeferred();

    assert.equal(db.finalTranscriptClaim.claim_version, 2);
    assert.equal(db.tracker.analysisV2ClaimCalls, 2);
    assert.equal(db.tracker.analysisV2Calls, 2);
    assert.equal(db.tracker.analysisV2FinalizeCalls, 2);
    assert.deepEqual(
      [...db.tracker.analysisV2FinalizeOutcomes].sort(),
      ['stale_claim', 'stored'],
    );
    assert.equal(db.tracker.analysisV2Updates, 1);
    assert.equal(db.interview.interview_analysis_v2.scores.response_specificity, 72);
  });
});

test('busy same-version Analysis V2 ownership prevents duplicate generation', async () => {
  await withScenario({
    analysisV2Enabled: true,
    analysisV2ClaimOutcome: 'busy',
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.analysisV2ClaimCalls, 1);
    assert.deepEqual(db.tracker.analysisV2ClaimOutcomes, ['busy']);
    assert.equal(db.tracker.analysisV2Calls, 0);
    assert.equal(db.tracker.analysisV2FinalizeCalls, 0);
    assert.equal(db.tracker.analysisV2Updates, 0);
  });
});

test('expired same-version Analysis V2 ownership is recovered before generation', async () => {
  await withScenario({
    analysisV2Enabled: true,
    analysisV2ClaimOutcome: 'recovered_expired_claim',
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.deepEqual(db.tracker.analysisV2ClaimOutcomes, ['recovered_expired_claim']);
    assert.equal(db.tracker.analysisV2Calls, 1);
    assert.deepEqual(db.tracker.analysisV2FinalizeOutcomes, ['stored']);
  });
});

test('versioned older Analysis V2 is replaced by the stronger authoritative transcript', async () => {
  const olderAnalysis = syntheticAnalysisV2(9);
  await withScenario({
    analysisV2Enabled: true,
    analysisV2: olderAnalysis,
    analysisV2ClaimState: 'completed',
    analysisV2ClaimVersion: 1,
    analysisV2CompletedTranscriptClaimVersion: 0,
    analysisV2CompletedTranscriptHash: 'a'.repeat(64),
    analysisV2CompletedClaimToken: syntheticAnalysisClaimToken(1),
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.deepEqual(db.tracker.analysisV2ClaimOutcomes, ['claimed']);
    assert.equal(db.tracker.analysisV2Calls, 1);
    assert.deepEqual(db.tracker.analysisV2FinalizeOutcomes, ['stored']);
    assert.notDeepEqual(db.interview.interview_analysis_v2, olderAnalysis);
  });
});

test('historical unversioned Analysis V2 is preserved without silent overwrite', async () => {
  const historicalAnalysis = syntheticAnalysisV2(1);
  await withScenario({
    analysisV2Enabled: true,
    analysisV2: historicalAnalysis,
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.deepEqual(db.tracker.analysisV2ClaimOutcomes, ['analysis_present_unversioned']);
    assert.equal(db.tracker.analysisV2Calls, 0);
    assert.equal(db.tracker.analysisV2FinalizeCalls, 0);
    assert.deepEqual(db.interview.interview_analysis_v2, historicalAnalysis);
  });
});

test('Analysis V2 generation failure releases exact ownership without changing HTTP acknowledgment', async () => {
  await withScenario({
    analysisV2Enabled: true,
    analysisV2Error: true,
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.analysisV2ClaimCalls, 1);
    assert.equal(db.tracker.analysisV2Calls, 1);
    assert.equal(db.tracker.analysisV2FinalizeCalls, 0);
    assert.equal(db.tracker.analysisV2ReleaseCalls, 1);
    assert.deepEqual(db.tracker.analysisV2ReleaseOutcomes, ['released']);
    assert.equal(db.tracker.analysisV2Updates, 0);
  });
});

test('Analysis V2 persistence failure releases ownership without partial result or source metadata', async () => {
  await withScenario({
    analysisV2Enabled: true,
    analysisV2FinalizeError: true,
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.analysisV2ClaimCalls, 1);
    assert.equal(db.tracker.analysisV2Calls, 1);
    assert.equal(db.tracker.analysisV2FinalizeCalls, 1);
    assert.equal(db.tracker.analysisV2ReleaseCalls, 1);
    assert.equal(db.tracker.analysisV2Updates, 0);
    assert.equal(db.analysisV2Claim.completed_transcript_claim_version, null);
    assert.equal(db.analysisV2Claim.completed_transcript_hash, null);
  });
});

test('invalid Analysis V2 generator output cannot reach persistence', async () => {
  await withScenario({
    analysisV2Enabled: true,
    analysisV2InvalidOutput: true,
  }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.analysisV2ClaimCalls, 1);
    assert.equal(db.tracker.analysisV2Calls, 1);
    assert.equal(db.tracker.analysisV2FinalizeCalls, 0);
    assert.equal(db.tracker.analysisV2ReleaseCalls, 1);
    assert.equal(db.tracker.analysisV2Updates, 0);
  });
});

test('new finalization does not invoke Analysis V2 when its existing gate is disabled', async () => {
  await withScenario({ analysisV2Enabled: false }, async (app, db) => {
    const response = await postTranscription(app);
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.analysisV2Calls, 0);
    assert.equal(db.tracker.analysisV2Updates, 0);
  });
});

test('identical duplicate delivery cannot duplicate Analysis V2 or reconciliation work', async () => {
  await withScenario({ analysisV2Enabled: true }, async (app, db) => {
    const first = await postTranscription(app);
    assert.equal(first.status, 200);
    await drainDeferred();
    db.options.claimOutcome = 'already_reconciled';
    const duplicate = await postTranscription(app);
    assert.equal(duplicate.status, 200);
    await drainDeferred();

    assert.equal(db.tracker.analysisV2Calls, 1);
    assert.equal(db.tracker.analysisV2Updates, 1);
    assert.equal(db.tracker.scoreCalls, 1);
    assert.equal(db.tracker.storageUploads, 1);
    assert.equal(db.tracker.finalizeCalls, 1);
  });
});

test('new finalization excludes an answered closing-stage candidate question and duplicate delivery is deterministic', async () => {
  await withScenario({}, async (app, db) => {
    const transcript = [
      { role: 'assistant', content: 'Do you have any questions before we wrap up?' },
      {
        role: 'user',
        content: 'I completed the synthetic project successfully. [[UNANSWERED_QUESTION: synthetic hidden question?]]',
      },
      { role: 'assistant', content: "I don't have that information, so I will note it for the hiring manager." },
    ];
    const first = await postTranscription(app, { transcript });
    assert.equal(first.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.questionRpcCalls, 0);
    assert.deepEqual(db.tracker.questionRpcOutcomes, []);
    assert.equal(db.tracker.questionUpdates, 0);
    assert.deepEqual(db.interview.unanswered_candidate_questions, []);

    db.options.claimOutcome = 'already_reconciled';
    const duplicate = await postTranscription(app, { transcript });
    assert.equal(duplicate.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.questionRpcCalls, 0);
    assert.equal(db.tracker.questionUpdates, 0);
  });
});

test('deferred weaker unanswered-question worker cannot write after stronger finalization', async () => {
  const weakerEntered = deferred();
  const releaseWeaker = deferred();
  const strongerStored = deferred();
  const options = {
    dynamicClaims: true,
    questionPersistenceBarrier: async ({ call }) => {
      if (call === 1) {
        weakerEntered.resolve();
        await releaseWeaker.promise;
      }
    },
    questionPersistenceComplete: ({ call, outcome }) => {
      if (call === 2 && outcome === 'stored') strongerStored.resolve();
    },
  };

  await withScenario(options, async (app, db) => {
    const weaker = await postTranscription(app, {
      transcript: [{
        role: 'user',
        content: 'I completed one synthetic task. [[UNANSWERED_QUESTION: weaker deferred question?]]',
      }],
    });
    assert.equal(weaker.status, 200);
    await weakerEntered.promise;

    const stronger = await postTranscription(app, {
      transcript: [
        {
          role: 'user',
          content: 'I completed two synthetic tasks with measurable results. [[UNANSWERED_QUESTION: stronger authoritative question?]]',
        },
        {
          role: 'user',
          content: 'I also improved the synthetic deployment workflow.',
        },
      ],
    });
    assert.equal(stronger.status, 200);
    await strongerStored.promise;
    releaseWeaker.resolve();
    await drainDeferred();

    assert.equal(db.finalTranscriptClaim.claim_version, 2);
    assert.equal(db.tracker.questionRpcCalls, 2);
    assert.deepEqual(
      [...db.tracker.questionRpcOutcomes].sort(),
      ['stored', 'superseded'],
    );
    assert.equal(db.tracker.questionUpdates, 1);
    assert.equal(db.interview.unanswered_candidate_questions.length, 1);
    assert.equal(
      db.interview.unanswered_candidate_questions[0].includes('stronger authoritative'),
      true,
    );
  });
});

test('authoritative question persistence treats existing values as immutable and null as empty', async () => {
  await withScenario({
    unansweredQuestions: ['Existing synthetic question?'],
  }, async (app, db) => {
    const response = await postTranscription(app, {
      transcript: [{
        role: 'user',
        content: 'I completed substantial synthetic work. [[UNANSWERED_QUESTION: replacement question?]]',
      }],
    });
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.questionRpcCalls, 1);
    assert.deepEqual(db.tracker.questionRpcOutcomes, ['already_present']);
    assert.equal(db.tracker.questionUpdates, 0);
    assert.equal(db.interview.unanswered_candidate_questions[0].startsWith('Existing'), true);
  });

  await withScenario({
    unansweredQuestions: null,
  }, async (app, db) => {
    const response = await postTranscription(app, {
      transcript: [{
        role: 'user',
        content: 'I completed substantial synthetic work. [[UNANSWERED_QUESTION: null-state question?]]',
      }],
    });
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.questionRpcCalls, 1);
    assert.deepEqual(db.tracker.questionRpcOutcomes, ['stored']);
    assert.equal(db.tracker.questionUpdates, 1);
  });
});

test('oversized unanswered-question payload is rejected before database persistence', async () => {
  await withScenario({}, async (app, db) => {
    const response = await postTranscription(app, {
      transcript: [{
        role: 'user',
        content: `I completed substantial synthetic work. [[UNANSWERED_QUESTION: ${'q'.repeat(1_001)}]]`,
      }],
    });
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.questionRpcCalls, 0);
    assert.equal(db.tracker.questionUpdates, 0);
  });
});

test('superseded callback cannot drive Analysis V2 or unanswered-question work', async () => {
  await withScenario({
    analysisV2Enabled: true,
    claimOutcome: 'superseded_by_stronger_evidence',
    transcript: 'STRONG_TRANSCRIPT_SENTINEL',
    transcriptUrl: 'STRONG_LINK_SENTINEL',
  }, async (app, db) => {
    const response = await postTranscription(app, {
      transcript: [{
        role: 'user',
        content: 'I completed substantial synthetic work. [[UNANSWERED_QUESTION: weaker hidden question?]]',
      }],
    });
    assert.equal(response.status, 200);
    await drainDeferred();
    assert.equal(db.tracker.analysisV2Calls, 0);
    assert.equal(db.tracker.questionUpdates, 0);
    assert.equal(db.interview.transcript, 'STRONG_TRANSCRIPT_SENTINEL');
    assert.equal(db.interview.transcript_url, 'STRONG_LINK_SENTINEL');
  });
});

test('busy, invalid, and failed reconciliation outcomes never run downstream work', async () => {
  const scenarios = [
    { options: { claimOutcome: 'busy' }, status: 503 },
    { options: { claimOutcome: 'invalid_snapshot' }, status: 422 },
    { options: { claimError: true }, status: 503 },
    { options: { scoringError: true }, status: 503 },
    { options: { uploadError: true }, status: 503 },
    { options: { finalizeError: true }, status: 503 },
  ];
  const transcript = [{
    role: 'user',
    content: 'I built a synthetic system and improved the project workflow. [[UNANSWERED_QUESTION: blocked hidden question?]]',
  }];

  for (const scenario of scenarios) {
    await withScenario({
      ...scenario.options,
      analysisV2Enabled: true,
    }, async (app, db) => {
      const response = await postTranscription(app, { transcript });
      assert.equal(response.status, scenario.status);
      await drainDeferred();
      assert.equal(db.tracker.analysisV2Calls, 0);
      assert.equal(db.tracker.analysisV2Updates, 0);
      assert.equal(db.tracker.questionUpdates, 0);
      assert.equal(db.tracker.questionRpcCalls, 0);
    });
  }
});

test('best-effort Analysis V2 failure remains acknowledged and emits only bounded telemetry', async () => {
  let scenarioDb;
  let responseBody;
  const captured = await captureConsole(async () => {
    await withScenario({
      analysisV2Enabled: true,
      analysisV2Error: true,
    }, async (app, db) => {
      scenarioDb = db;
      const response = await postTranscription(app);
      assert.equal(response.status, 200);
      responseBody = await response.json();
      await drainDeferred();
      assert.equal(db.tracker.analysisV2Calls, 1);
      assert.equal(db.tracker.analysisV2Updates, 0);
    });
  });

  assert.deepEqual(responseBody, {
    ok: true,
    outcome: 'finalized',
    retryable: false,
  });
  assert.equal(scenarioDb.tracker.sentryCaptures.length, 1);
  assert.equal(
    scenarioDb.tracker.sentryCaptures[0].error.message,
    'final_transcript_reconciliation_failed:analysis_generation_failed',
  );
  const allOutput = JSON.stringify({
    responseBody,
    captured,
    sentry: serializedSentry(scenarioDb.tracker),
  });
  assert.doesNotMatch(allOutput, /raw-supabase-diagnostic|database\.invalid|private-storage-reference/i);
  assert.doesNotMatch(allOutput, /76000000-|synthetic-final-transcript-conversation/i);
});

test('best-effort unanswered-question persistence failure remains acknowledged and sanitized', async () => {
  let scenarioDb;
  let responseBody;
  const captured = await captureConsole(async () => {
    await withScenario({ questionUpdateError: true }, async (app, db) => {
      scenarioDb = db;
      const response = await postTranscription(app, {
        transcript: [{
          role: 'user',
          content: 'I completed substantial synthetic work. [[UNANSWERED_QUESTION: hidden persistence question?]]',
        }],
      });
      assert.equal(response.status, 200);
      responseBody = await response.json();
      await drainDeferred();
      assert.equal(db.tracker.questionRpcCalls, 1);
      assert.equal(db.tracker.questionUpdates, 0);
    });
  });

  assert.equal(responseBody.outcome, 'finalized');
  const allOutput = JSON.stringify({
    responseBody,
    captured,
    sentry: serializedSentry(scenarioDb.tracker),
  });
  assert.doesNotMatch(allOutput, /raw-supabase-diagnostic|database\.invalid|private-storage-reference/i);
  assert.doesNotMatch(allOutput, /76000000-|synthetic-final-transcript-conversation/i);
});

test('final transcript logs contain bounded state only', async () => {
  const captured = await captureConsole(async () => {
    await withScenario({}, async (app) => {
      const response = await postTranscription(app);
      assert.equal(response.status, 200);
    });
  });
  const serialized = JSON.stringify(captured);
  assert.doesNotMatch(serialized, /76000000-|synthetic-final-transcript-conversation|synthetic-final-event/i);
  assert.doesNotMatch(serialized, /Describe a synthetic|built a synthetic|claim_token|candidate_id|interview_id|conversation_id/i);
});

test('real Sentry SDK final events contain only bounded allowlisted telemetry', async (t) => {
  const cases = [
    {
      scenario: 'binding',
      status: 503,
      category: 'binding_lookup_failed',
      stage: 'binding',
      retryable: true,
      httpClass: '5xx',
    },
    {
      scenario: 'claim',
      status: 503,
      category: 'claim_failed',
      stage: 'claim',
      retryable: true,
      httpClass: '5xx',
    },
    {
      scenario: 'scoring',
      status: 503,
      category: 'scoring_failed',
      stage: 'scoring',
      retryable: true,
      httpClass: '5xx',
    },
    {
      scenario: 'storage',
      status: 503,
      category: 'storage_failed',
      stage: 'upload',
      retryable: true,
      httpClass: '5xx',
    },
    {
      scenario: 'finalize',
      status: 503,
      category: 'finalize_failed',
      stage: 'finalize',
      retryable: true,
      httpClass: '5xx',
    },
    {
      scenario: 'invalid_scores',
      status: 503,
      category: 'invalid_transcript_scores',
      stage: 'scoring',
      retryable: true,
      httpClass: '5xx',
    },
    {
      scenario: 'unexpected',
      status: 503,
      category: 'unexpected_failure',
      stage: 'unexpected',
      retryable: true,
      httpClass: '5xx',
    },
    {
      scenario: 'analysis_claim',
      status: 200,
      category: 'analysis_claim_failed',
      stage: 'downstream_analysis',
      retryable: false,
      httpClass: '2xx',
    },
    {
      scenario: 'analysis_v2',
      status: 200,
      category: 'analysis_generation_failed',
      stage: 'downstream_analysis',
      retryable: false,
      httpClass: '2xx',
    },
    {
      scenario: 'analysis_finalize',
      status: 200,
      category: 'analysis_finalize_failed',
      stage: 'downstream_analysis',
      retryable: false,
      httpClass: '2xx',
    },
  ];

  for (const expected of cases) {
    await t.test(expected.scenario, () => {
      assertSafeProcessedSentryEvent(runRealSentryProbe(expected.scenario), expected);
    });
  }

  await t.test('unanswered-question persistence remains bounded without a Sentry event', () => {
    const probe = runRealSentryProbe('questions');
    assert.equal(probe.status, 200);
    assert.equal(probe.events.length, 0);
    assert.deepEqual(
      findPrivacyLeakLabels({
        responseBody: probe.responseBody,
        capturedConsole: probe.capturedConsole,
      }),
      [],
    );
  });
});
} else {
  runRealSentryProbeChild().catch((error) => {
    process.stderr.write(`real_sentry_probe_failed:${error?.name || 'Error'}\n`);
    process.exitCode = 1;
  });
}
