'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

process.env.ENABLE_INTERVIEW_ANALYSIS_V2 = 'true';

const analysisV2Path = require.resolve('../src/services/interviewAnalysisV2');
const actualAnalysisV2 = require(analysisV2Path);
const sentryPath = require.resolve('@sentry/node');
const supabaseClientPath = require.resolve('../src/clients/supabase');
const backfillPath = require.resolve('../scripts/backfillInterviews.js');
const tavusHttpClientPath = require.resolve('../src/clients/tavus');

let activeTracker = null;

require.cache[analysisV2Path] = {
  id: analysisV2Path,
  filename: analysisV2Path,
  loaded: true,
  exports: {
    ...actualAnalysisV2,
    async generateInterviewAnalysisV2(input) {
      activeTracker.generatorCalls += 1;
      activeTracker.generatorInputs.push(structuredClone(input));
      if (activeTracker.generatorError) throw activeTracker.generatorError;
      return syntheticAnalysisV2();
    },
  },
};

require.cache[sentryPath] = {
  id: sentryPath,
  filename: sentryPath,
  loaded: true,
  exports: {
    setTag() {},
    addBreadcrumb() {},
    captureException(error, context) {
      activeTracker.sentry.push({ error, context });
    },
  },
};

require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: null },
};

require.cache[backfillPath] = {
  id: backfillPath,
  filename: backfillPath,
  loaded: true,
  exports: {
    async analyzeInterviewTranscriptById() {
      return { ok: true, skipped: true, reason: 'empty_transcript' };
    },
  },
};

require.cache[tavusHttpClientPath] = {
  id: tavusHttpClientPath,
  filename: tavusHttpClientPath,
  loaded: true,
  exports: {
    tavusHttpClient: {
      async endConversation() {},
    },
  },
};

const router = require('../src/routes/webhooks/tavus');
const {
  analysisV2Eligibility,
  maybeGenerateInterviewAnalysisV2,
  queueInterviewAnalysisV2,
} = router._test;

const IDS = {
  interview: '71000000-0000-4000-8000-000000000001',
  candidate: '71000000-0000-4000-8000-000000000002',
  role: '71000000-0000-4000-8000-000000000003',
  claim: '71000000-0000-4000-8000-000000000004',
};

const WARMUP_QUESTION = 'What’s your favorite season, and what do you like about it?';

function syntheticAnalysisV2() {
  return {
    version: 'path_a_v1',
    scores: {
      response_specificity: 75,
      answer_directness: 75,
      answer_consistency: 75,
      communication_structure: 75,
    },
    conditions: {
      evaluation_conditions: 'good',
      audio_quality_issues: 'none',
      distraction_risk: 'low',
      signal_confidence: 'high',
    },
    risk: {
      integrity_risk: 'low',
      reason: 'Synthetic evidence-backed reason.',
    },
    evidence_summary: 'Synthetic evidence-backed summary.',
    evidence: ['The candidate described a concrete migration result.'],
    limitations: [],
  };
}

function substantiveTranscript() {
  return [
    'INTERVIEWER: Describe a project you owned.',
    'CANDIDATE: I led a migration that reduced processing time by thirty percent.',
  ].join('\n');
}

function baseRow(overrides = {}) {
  return {
    id: IDS.interview,
    candidate_id: IDS.candidate,
    role_id: IDS.role,
    transcript: substantiveTranscript(),
    transcript_scores: {
      overall: 75,
      role_fit: 75,
      technical_strength: 75,
      communication_quality: 75,
      confidence: 75,
    },
    perception_scores: {},
    perception_analysis_text: null,
    unanswered_candidate_questions: [],
    interview_summary: 'The candidate gave a concrete role-relevant example.',
    interview_analysis_v2: null,
    has_substantive_response: null,
    substantive_response_count: null,
    candidate_utterance_count: null,
    conversation_progress_state: null,
    failure_code: null,
    status: 'ReadyForAnalysis',
    ...overrides,
  };
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.operation = 'select';
    this.value = null;
    this.filters = [];
  }

  select() { return this; }
  update(value) { this.operation = 'update'; this.value = value; return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  maybeSingle() { return this.execute(); }
  then(resolve, reject) { return this.execute().then(resolve, reject); }

  async execute() {
    if (this.table === 'roles') {
      return {
        data: {
          id: IDS.role,
          title: 'Synthetic role',
          description: 'Synthetic role context.',
        },
        error: this.db.options.roleLookupError || null,
      };
    }
    assert.equal(this.table, 'interviews');
    if (this.operation === 'update') {
      this.db.tracker.analysisUpdates += Object.hasOwn(this.value || {}, 'interview_analysis_v2') ? 1 : 0;
      if (this.db.options.updateError) return { data: null, error: this.db.options.updateError };
      Object.assign(this.db.row, structuredClone(this.value));
      return { data: null, error: null };
    }
    if (this.db.options.lookupError) return { data: null, error: this.db.options.lookupError };
    return { data: structuredClone(this.db.row), error: null };
  }
}

function makeDb(row, options = {}) {
  const tracker = {
    generatorCalls: 0,
    generatorInputs: [],
    analysisUpdates: 0,
    claimCalls: 0,
    releaseCalls: 0,
    releaseCategories: [],
    finalizeCalls: 0,
    sentry: [],
    generatorError: options.generatorError || null,
  };
  const db = {
    row: structuredClone(row),
    options,
    tracker,
    from(table) { return new FakeQuery(db, table); },
    async rpc(name, args = {}) {
      if (name === 'claim_interview_analysis_v2_if_authoritative') {
        tracker.claimCalls += 1;
        return {
          data: [{
            outcome: 'claimed',
            analysis_claim_token: IDS.claim,
            analysis_claim_version: 1,
          }],
          error: null,
        };
      }
      if (name === 'release_interview_analysis_v2_claim') {
        tracker.releaseCalls += 1;
        tracker.releaseCategories.push(args.p_failure_category);
        const allowedReleaseCategories = new Set([
          'analysis_generation_failed',
          'analysis_finalize_failed',
          'analysis_superseded',
          'worker_shutdown',
        ]);
        if (!allowedReleaseCategories.has(args.p_failure_category)) {
          return { data: null, error: new Error('analysis_v2_failure_category_invalid') };
        }
        return {
          data: options.releaseError ? null : 'released',
          error: options.releaseError || null,
        };
      }
      if (name === 'finalize_interview_analysis_v2_if_authoritative') {
        tracker.finalizeCalls += 1;
        return { data: [{ outcome: 'stored' }], error: null };
      }
      throw new Error(`unexpected_rpc:${name}`);
    },
  };
  activeTracker = tracker;
  router._setSupabaseAdminForTest(db);
  return { db, tracker };
}

function analysisInput(overrides = {}) {
  return {
    interview: {
      id: IDS.interview,
      candidate_id: IDS.candidate,
      role_id: IDS.role,
    },
    requestId: 'synthetic-request',
    conversationId: 'synthetic-conversation',
    ...overrides,
  };
}

async function flushImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('direct generator keeps the strict missing-transcript contract for warm-up-only input', async () => {
  await assert.rejects(
    actualAnalysisV2.generateInterviewAnalysisV2({
      transcript: `INTERVIEWER: ${WARMUP_QUESTION}`,
    }),
    /missing_transcript/,
  );
});

test('raw warm-up question without a candidate response skips v2 before OpenAI or Sentry', async () => {
  const { tracker } = makeDb(baseRow({
    transcript: `INTERVIEWER: ${WARMUP_QUESTION}`,
  }));
  const result = await maybeGenerateInterviewAnalysisV2(analysisInput());
  assert.deepEqual(result, { skipped: true, reason: 'missing_evaluative_transcript' });
  assert.equal(tracker.generatorCalls, 0);
  assert.equal(tracker.analysisUpdates, 0);
  assert.equal(tracker.sentry.length, 0);
});

test('warm-up response without scored interview content skips v2 before OpenAI or Sentry', async () => {
  const { tracker } = makeDb(baseRow({
    transcript: [
      `INTERVIEWER: ${WARMUP_QUESTION}`,
      'CANDIDATE: Winter, because I like the snow.',
    ].join('\n'),
  }));
  const result = await maybeGenerateInterviewAnalysisV2(analysisInput());
  assert.deepEqual(result, { skipped: true, reason: 'missing_evaluative_transcript' });
  assert.equal(tracker.generatorCalls, 0);
  assert.equal(tracker.analysisUpdates, 0);
  assert.equal(tracker.sentry.length, 0);
});

test('empty-transcript scoring result prevents fallback queueing', async () => {
  const { tracker } = makeDb(baseRow());
  const queued = queueInterviewAnalysisV2(analysisInput({
    substantiveEvidence: false,
    skipReason: 'empty_transcript',
  }));
  assert.equal(queued, false);
  await flushImmediate();
  assert.equal(tracker.generatorCalls, 0);
  assert.equal(tracker.analysisUpdates, 0);
  assert.equal(tracker.sentry.length, 0);
});

test('shutdown then perception refresh stays informational for the same non-substantive interview', async () => {
  const { tracker } = makeDb(baseRow({
    transcript: `INTERVIEWER: ${WARMUP_QUESTION}`,
    has_substantive_response: false,
    substantive_response_count: 0,
    candidate_utterance_count: 0,
    conversation_progress_state: 'NoSubstantiveCandidateResponse',
    failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
    status: 'Incomplete',
    perception_scores: { clarity: 70 },
  }));
  const shutdown = await maybeGenerateInterviewAnalysisV2(analysisInput());
  const perception = await maybeGenerateInterviewAnalysisV2(analysisInput({
    refreshOnMissingPerception: true,
  }));
  assert.equal(shutdown.reason, 'missing_evaluative_transcript');
  assert.equal(perception.reason, 'missing_evaluative_transcript');
  assert.equal(tracker.generatorCalls, 0);
  assert.equal(tracker.analysisUpdates, 0);
  assert.equal(tracker.sentry.length, 0);
});

test('structured no-substantive state and the canonical summary both skip cleanly', async () => {
  for (const overrides of [
    { has_substantive_response: false },
    { conversation_progress_state: 'NoSubstantiveCandidateResponse' },
    { failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE' },
    { interview_summary: 'Interview ended before a substantive candidate response was recorded.' },
  ]) {
    const row = baseRow(overrides);
    assert.deepEqual(analysisV2Eligibility(row), {
      eligible: false,
      reason: 'no_substantive_responses',
    });
    const { tracker } = makeDb(row);
    const result = await maybeGenerateInterviewAnalysisV2(analysisInput());
    assert.equal(result.reason, 'no_substantive_responses');
    assert.equal(tracker.generatorCalls, 0);
    assert.equal(tracker.sentry.length, 0);
  }
});

test('current substantive evidence is not overridden by a stale no-substantive failure code', () => {
  assert.deepEqual(analysisV2Eligibility(baseRow({
    has_substantive_response: true,
    conversation_progress_state: 'CandidateResponded',
    failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
  })), {
    eligible: true,
    reason: null,
  });
});

test('legacy substantive row with null structured fields still generates and stores v2', async () => {
  const { db, tracker } = makeDb(baseRow({
    has_substantive_response: null,
    substantive_response_count: null,
    conversation_progress_state: null,
    failure_code: null,
  }));
  const result = await maybeGenerateInterviewAnalysisV2(analysisInput());
  assert.equal(result, undefined);
  assert.equal(tracker.generatorCalls, 1);
  assert.equal(tracker.analysisUpdates, 1);
  assert.equal(db.row.interview_analysis_v2.version, 'path_a_v1');
  assert.equal(tracker.sentry.length, 0);
});

test('genuine generator and persistence failures still reach Sentry', async () => {
  {
    const { tracker } = makeDb(baseRow(), { generatorError: new Error('synthetic_openai_failure') });
    await maybeGenerateInterviewAnalysisV2(analysisInput());
    assert.equal(tracker.generatorCalls, 1);
    assert.equal(tracker.sentry.length, 1);
    assert.match(tracker.sentry[0].error.message, /synthetic_openai_failure/);
  }
  {
    const { tracker } = makeDb(baseRow(), { updateError: new Error('synthetic_database_failure') });
    await maybeGenerateInterviewAnalysisV2(analysisInput());
    assert.equal(tracker.generatorCalls, 1);
    assert.equal(tracker.sentry.length, 1);
    assert.match(tracker.sentry[0].error.message, /synthetic_database_failure/);
  }
});

test('bounded warm-up skip releases its v2 analysis claim before returning', async () => {
  const row = baseRow({ transcript: `INTERVIEWER: ${WARMUP_QUESTION}` });
  const { tracker } = makeDb(row);
  const transcriptHash = crypto.createHash('sha256').update(row.transcript).digest('hex');
  const result = await maybeGenerateInterviewAnalysisV2(analysisInput({
    boundedTelemetry: true,
    authoritativeTranscriptClaimVersion: 1,
    authoritativeTranscriptHash: transcriptHash,
  }));
  assert.deepEqual(result, { skipped: true, reason: 'missing_evaluative_transcript' });
  assert.equal(tracker.claimCalls, 1);
  assert.equal(tracker.releaseCalls, 1);
  assert.deepEqual(tracker.releaseCategories, ['analysis_superseded']);
  assert.equal(tracker.generatorCalls, 0);
  assert.equal(tracker.finalizeCalls, 0);
  assert.equal(tracker.sentry.length, 0);
});

test('bounded warm-up skip does not report a clean skip when claim release fails', async () => {
  const row = baseRow({ transcript: `INTERVIEWER: ${WARMUP_QUESTION}` });
  const { tracker } = makeDb(row, { releaseError: new Error('synthetic_release_failure') });
  const transcriptHash = crypto.createHash('sha256').update(row.transcript).digest('hex');
  const result = await maybeGenerateInterviewAnalysisV2(analysisInput({
    boundedTelemetry: true,
    authoritativeTranscriptClaimVersion: 1,
    authoritativeTranscriptHash: transcriptHash,
  }));
  assert.deepEqual(result, { skipped: false, reason: 'analysis_claim_release_failed' });
  assert.equal(tracker.claimCalls, 1);
  assert.equal(tracker.releaseCalls, 1);
  assert.deepEqual(tracker.releaseCategories, ['analysis_superseded']);
  assert.equal(tracker.generatorCalls, 0);
  assert.equal(tracker.finalizeCalls, 0);
});
