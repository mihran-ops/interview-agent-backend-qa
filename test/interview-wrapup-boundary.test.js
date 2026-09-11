'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_INTERVIEW_MINUTES,
  PROVIDER_CLOSING_GRACE_SECONDS,
  PROVIDER_MAX_CALL_DURATION_SECONDS,
  resolveProviderMaxCallDurationSeconds,
} = require('../src/services/interviewDuration');

const SYNTHETIC_INTERVIEW_ID = '11111111-1111-4111-8111-111111111111';

async function captureConversationPayload(maxInterviewMinutes = 10) {
  const previousEnv = {
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    TAVUS_API_KEY: process.env.TAVUS_API_KEY,
    TAVUS_PERSONA_ID: process.env.TAVUS_PERSONA_ID,
    TAVUS_REPLICA_ID: process.env.TAVUS_REPLICA_ID,
  };
  let payload = null;
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role-key';
  process.env.SUPABASE_ANON_KEY = 'synthetic-anon-key';
  process.env.TAVUS_API_KEY = 'synthetic-test-key';
  process.env.TAVUS_PERSONA_ID = 'synthetic-test-persona';
  process.env.TAVUS_REPLICA_ID = 'synthetic-test-replica';
  const tavusHttpClient = {
    async createConversation(body) {
      payload = body;
      return {
        conversation_id: 'synthetic-conversation',
        conversation_url: 'https://example.invalid/synthetic-conversation',
      };
    },
  };

  try {
    const { createTavusInterviewHandler } = require('../src/services/tavusInterview');
    await createTavusInterviewHandler(
      { id: 'synthetic-candidate', name: 'Synthetic Candidate' },
      {
        id: 'synthetic-role',
        title: 'Synthetic Role',
        tavus_document_id: 'synthetic-document',
        rubric_questions: ['Describe a synthetic project?'],
      },
      'https://example.invalid/webhook',
      {
        companyName: 'Synthetic Company',
        interviewId: SYNTHETIC_INTERVIEW_ID,
        maxInterviewMinutes,
        tavusHttpClient,
      },
    );
    return payload;
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('conversation context keeps browser warnings visual without hidden closing state', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.match(context, /two-minute and one-minute browser warnings are visual-only/i);
  assert.doesNotMatch(context, /runtime closing control state/i);
  assert.doesNotMatch(context, /briefly acknowledge that time is running low/i);
  assert.doesNotMatch(context, /If the system or front-end sends a time warning/i);
});

test('obsolete staged timing states and question lock are absent', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.doesNotMatch(context, /QUESTION_LOCKED|CLOSING_ONLY|TERMINATION_ONLY/);
  assert.doesNotMatch(context, /question-count goals|application farewell|provider-end backstop/i);
});

test('PAL context contains no application-owned candidate-question invitation or farewell', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.doesNotMatch(context, /application deterministically owns the final candidate-question invitation/i);
  assert.doesNotMatch(context, /Never create or repeat that invitation independently/i);
  assert.doesNotMatch(context, /answer at most one direct candidate question/i);
  assert.doesNotMatch(context, /candidate acknowledgment|final closing line/i);
  assert.doesNotMatch(context, /Do you have any questions for me before we wrap up\?/i);
  assert.doesNotMatch(context, /Any other questions\? If not, just say 'no'\./i);
});

test('PAL context contains no hidden closing or termination instructions', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.doesNotMatch(context, /CLOSING_ONLY|TERMINATION_ONLY/);
  assert.doesNotMatch(context, /application owns that invitation|application farewell|end-conversation backstop/i);
});

test('provider duration reserves bounded farewell grace beyond the visible product timer', async () => {
  const payload = await captureConversationPayload();

  assert.equal(payload?.properties?.max_call_duration, 620);
  assert.equal(payload?.properties?.participant_left_timeout, 60);
});

test('three-minute QA conversations preserve a three-minute product timer with provider-only grace', async () => {
  const payload = await captureConversationPayload(3);

  assert.equal(payload?.properties?.max_call_duration, 200);
  assert.match(String(payload?.conversational_context || ''), /Time limit: 3 minutes/i);
  assert.doesNotMatch(String(payload?.conversational_context || ''), /3 minutes and 20 seconds/i);
});

test('duration contract always reserves provider farewell headroom within Tavus limits', () => {
  assert.equal(PROVIDER_CLOSING_GRACE_SECONDS, 20);
  assert.equal(PROVIDER_MAX_CALL_DURATION_SECONDS, 3600);
  assert.equal(MAX_INTERVIEW_MINUTES, 59);
  assert.equal(resolveProviderMaxCallDurationSeconds(3), 200);
  assert.equal(resolveProviderMaxCallDurationSeconds(10), 620);
  assert.equal(resolveProviderMaxCallDurationSeconds(MAX_INTERVIEW_MINUTES), 3560);
});

test('provider maximum is fail-closed when farewell grace cannot be reserved', async () => {
  await assert.rejects(
    () => captureConversationPayload(60),
    (error) =>
      error?.code === 'INTERVIEW_DURATION_NOT_CONFIGURED' &&
      error?.durationReason === 'duration_above_provider_limit',
  );
});

test('provider handler fails closed before Tavus when duration is invalid', async () => {
  await assert.rejects(
    () => captureConversationPayload(null),
    (error) => error?.code === 'INTERVIEW_DURATION_NOT_CONFIGURED',
  );
});
