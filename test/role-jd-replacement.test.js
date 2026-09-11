'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://unit-test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'unit-test-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'unit-test-anon-key';
process.env.OPENAI_API_KEY ||= 'unit-test-openai-key';

const {
  RoleJdReplacementError,
  createRoleJdReplacementService
} = require('../src/services/roleJdReplacement');
const { createRoleJdReplacementRouter } = require('../src/routes/client/roleJdReplacement');
const { getPlanCapacity } = require('../src/services/planCapacity');
const {
  buildFallbackRubric,
  generateJdDerivedArtifactsForRole
} = require('../src/services/generateRubric');

const ROLE_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const REPLACEMENT_ID = '33333333-3333-4333-8333-333333333333';
const BASIC_SCORED_QUESTION_COUNT = getPlanCapacity('basic').scored_question_count;
const NEW_RUBRIC_QUESTIONS = buildFallbackRubric({
  title: 'Dental Hygienist',
  interview_type: 'leadership'
}, 'basic').questions;

function baseRole(overrides = {}) {
  return {
    id: ROLE_ID,
    client_id: CLIENT_ID,
    title: 'Dental Hygienist',
    description: 'Old JD excerpt',
    interview_type: 'DETAILED',
    membership_level: 'basic',
    manual_questions: null,
    status: 'active',
    job_description_url: 'job-descriptions/old/jd.pdf',
    job_description_text: 'Old JD text',
    rubric: { questions: [{ text: 'Old question', category: 'old' }] },
    rubric_questions: [{ text: 'Old question', category: 'old' }],
    kb_document_id: 'kb-old',
    tavus_document_id: 'tavus-old',
    tavus_prompt: 'Old JD-specific prompt',
    ...overrides
  };
}

function matches(row, filters) {
  return filters.every((filter) => {
    const value = row?.[filter.column];
    if (filter.type === 'is') return filter.value === null ? value == null : value === filter.value;
    return String(value ?? '') === String(filter.value ?? '');
  });
}

class FakeQuery {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.filters = [];
    this.limitCount = null;
    this.insertPayload = null;
    this.updatePayload = null;
  }

  select() { return this; }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value });
    return this;
  }

  is(column, value) {
    this.filters.push({ type: 'is', column, value });
    return this;
  }

  limit(value) {
    this.limitCount = Number(value || 0);
    return this;
  }

  insert(payload) {
    this.insertPayload = { ...(payload || {}) };
    return this;
  }

  update(payload) {
    this.updatePayload = { ...(payload || {}) };
    return this;
  }

  rows() {
    if (this.table === 'roles') return this.state.roles;
    if (this.table === 'role_jd_replacements') return this.state.replacements;
    return this.state.activity[this.table] || [];
  }

  filteredRows() {
    const filtered = this.rows().filter((row) => matches(row, this.filters));
    return this.limitCount ? filtered.slice(0, this.limitCount) : filtered;
  }

  async maybeSingle() {
    const error = this.state.queryErrors[this.table] || null;
    return { data: error ? null : (this.filteredRows()[0] || null), error };
  }

  async execute() {
    if (this.insertPayload) {
      if (this.state.auditInsertError && this.table === 'role_jd_replacements') {
        return { data: null, error: this.state.auditInsertError };
      }
      this.rows().push({ ...this.insertPayload });
      this.state.writes.push({ table: this.table, type: 'insert', payload: this.insertPayload });
      return { data: this.insertPayload, error: null };
    }
    if (this.updatePayload) {
      const rows = this.filteredRows();
      for (const row of rows) Object.assign(row, this.updatePayload);
      this.state.writes.push({ table: this.table, type: 'update', payload: this.updatePayload });
      return { data: rows, error: null };
    }
    return { data: this.filteredRows(), error: this.state.queryErrors[this.table] || null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

function makeDb(overrides = {}) {
  const state = {
    roles: [baseRole(overrides.role)],
    replacements: [],
    activity: overrides.activity || {},
    queryErrors: overrides.queryErrors || {},
    auditInsertError: overrides.auditInsertError || null,
    rpcError: overrides.rpcError || null,
    writes: [],
    rpcCalls: [],
    storageUploads: [],
    storageDeletes: [],
    billing: {
      pending_role_purchases: [{ id: 'pending-1', finalized_role_id: ROLE_ID }],
      client_role_credits: [{ id: 'credit-1', used_by_role_id: ROLE_ID, status: 'used' }],
      role_interview_purchases: [{ id: 'purchase-1', role_id: ROLE_ID, status: 'paid' }]
    }
  };

  const db = {
    state,
    from(table) {
      return new FakeQuery(state, table);
    },
    storage: {
      from(bucket) {
        return {
          async upload(key, buffer, options) {
            state.storageUploads.push({ bucket, key, buffer, options });
            return { data: { path: key }, error: overrides.uploadError || null };
          },
          async remove(keys) {
            state.storageDeletes.push({ bucket, keys });
            return { data: null, error: null };
          }
        };
      }
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      if (state.rpcError) return { data: null, error: state.rpcError };
      assert.equal(name, 'complete_role_jd_replacement');
      const role = state.roles.find((item) => item.id === args.p_role_id && item.client_id === args.p_client_id);
      const replacement = state.replacements.find((item) => item.id === args.p_replacement_id);
      if (!role || !replacement) return { data: null, error: { message: 'ROLE_NOT_FOUND' } };
      Object.assign(role, {
        job_description_url: args.p_new_job_description_url,
        job_description_text: args.p_new_job_description_text,
        description: args.p_new_description,
        rubric: args.p_new_rubric,
        rubric_questions: args.p_new_rubric_questions,
        kb_document_id: args.p_new_kb_document_id,
        tavus_document_id: args.p_new_tavus_document_id,
        tavus_prompt: args.p_new_tavus_prompt
      });
      Object.assign(replacement, {
        status: 'completed',
        new_job_description_url: args.p_new_job_description_url,
        new_job_description_text: args.p_new_job_description_text,
        new_description: args.p_new_description,
        new_rubric: args.p_new_rubric,
        new_rubric_questions: args.p_new_rubric_questions,
        new_kb_document_id: args.p_new_kb_document_id,
        new_tavus_document_id: args.p_new_tavus_document_id,
        new_tavus_prompt: args.p_new_tavus_prompt,
        error_metadata: null
      });
      return { data: { ...role }, error: null };
    }
  };
  return db;
}

function makeService(db, overrides = {}) {
  const tavusCalls = [];
  const service = createRoleJdReplacementService({
    db,
    createId: () => REPLACEMENT_ID,
    parseBufferToText: overrides.parseBufferToText || (async (_buffer, _mime, filename) => `New JD text from ${filename}`),
    generateArtifacts: overrides.generateArtifacts || (async ({ role, jdText }) => {
      assert.equal(role.job_description_url, 'job-descriptions/old/jd.pdf');
      assert.match(jdText, /New JD text/);
      return {
        job_description_text: jdText,
        description: 'New JD excerpt',
        rubric: {
          membership_level: 'basic',
          interview_type: 'leadership',
          questions: NEW_RUBRIC_QUESTIONS
        },
        rubric_questions: NEW_RUBRIC_QUESTIONS,
        kb_document_id: 'kb-new'
      };
    }),
    ensureTavusDocument: overrides.ensureTavusDocument || (async (role, options) => {
      tavusCalls.push({ role, options });
      return 'tavus-new';
    }),
    logger: { error() {} }
  });
  return { service, tavusCalls };
}

function makeArtifactSupabase() {
  const uploads = [];
  return {
    uploads,
    client: {
      storage: {
        from(bucket) {
          return {
            async upload(key, body, options) {
              uploads.push({ bucket, key, body, options });
              return { data: { path: key }, error: null };
            }
          };
        }
      }
    }
  };
}

function makeOpenAiResponses(responses) {
  const prompts = [];
  let index = 0;
  return {
    prompts,
    client: {
      chat: {
        completions: {
          async create({ messages }) {
            prompts.push(messages?.[0]?.content || '');
            const next = responses[index++];
            if (next instanceof Error) throw next;
            const payload = next && typeof next === 'object' && Array.isArray(next.questions)
              ? { membership_level: 'basic', interview_type: 'leadership', ...next }
              : next;
            return {
              choices: [{
                message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) }
              }]
            };
          }
        }
      }
    }
  };
}

function replacementRequest(filename = 'replacement.pdf') {
  return {
    roleId: ROLE_ID,
    clientId: CLIENT_ID,
    file: { originalname: filename, buffer: Buffer.from('fixture') },
    reason: 'Wrong JD uploaded',
    actorUserId: '44444444-4444-4444-8444-444444444444',
    actorType: 'client_member'
  };
}

for (const filename of ['replacement.pdf', 'replacement.docx']) {
  test(`successful ${path.extname(filename).slice(1).toUpperCase()} replacement preserves identity and snapshots old/new artifacts`, async () => {
    const db = makeDb();
    const billingBefore = structuredClone(db.state.billing);
    const { service, tavusCalls } = makeService(db);

    const result = await service.replaceJobDescription(replacementRequest(filename));

    assert.equal(result.ok, true);
    assert.equal(result.replacement_id, REPLACEMENT_ID);
    assert.equal(result.role.id, ROLE_ID);
    assert.equal(result.role.client_id, CLIENT_ID);
    assert.equal(result.role.job_description_text, `New JD text from ${filename}`);
    assert.equal(result.role.kb_document_id, 'kb-new');
    assert.equal(result.role.tavus_document_id, 'tavus-new');
    assert.equal(result.role.tavus_prompt, null);
    assert.equal(result.role.rubric_questions.length, BASIC_SCORED_QUESTION_COUNT);
    assert.deepEqual(db.state.billing, billingBefore);

    const history = db.state.replacements[0];
    assert.equal(history.status, 'completed');
    assert.equal(history.old_job_description_url, 'job-descriptions/old/jd.pdf');
    assert.match(history.new_job_description_url, new RegExp(`/replacements/${REPLACEMENT_ID}/replacement\\.${path.extname(filename).slice(1)}$`));
    assert.equal(history.old_kb_document_id, 'kb-old');
    assert.equal(history.new_kb_document_id, 'kb-new');
    assert.equal(history.old_tavus_document_id, 'tavus-old');
    assert.equal(history.new_tavus_document_id, 'tavus-new');
    assert.equal(history.old_tavus_prompt, 'Old JD-specific prompt');
    assert.equal(history.new_tavus_prompt, null);
    assert.deepEqual(history.old_rubric, { questions: [{ text: 'Old question', category: 'old' }] });
    assert.deepEqual(history.new_rubric, {
      membership_level: 'basic',
      interview_type: 'leadership',
      questions: NEW_RUBRIC_QUESTIONS
    });
    assert.equal(db.state.storageDeletes.length, 0);
    assert.equal(tavusCalls.length, 1);
    assert.equal(tavusCalls[0].role.tavus_document_id, null);
    assert.equal(tavusCalls[0].options.forceRefresh, true);
    assert.equal(tavusCalls[0].options.persist, false);
  });
}

test('replacement artifact generation accepts a valid minimum rubric without retry', async () => {
  const { client, uploads } = makeArtifactSupabase();
  const { client: openaiClient, prompts } = makeOpenAiResponses([
    { questions: NEW_RUBRIC_QUESTIONS }
  ]);

  const artifacts = await generateJdDerivedArtifactsForRole(
    { role: baseRole(), jdText: 'Replacement job description' },
    { supabaseClient: client, openaiClient, logger: { error() {} }, kbId: 'quality-kb-valid' }
  );

  assert.equal(prompts.length, 1);
  assert.equal(uploads.length, 1);
  assert.equal(artifacts.rubric_questions.length, BASIC_SCORED_QUESTION_COUNT);
  assert.deepEqual(artifacts.rubric.questions, NEW_RUBRIC_QUESTIONS);
});

test('replacement artifact generation retries once and deduplicates valid questions', async () => {
  const { client, uploads } = makeArtifactSupabase();
  const { client: openaiClient, prompts } = makeOpenAiResponses([
    { questions: [NEW_RUBRIC_QUESTIONS[0]] },
    {
      questions: [
        NEW_RUBRIC_QUESTIONS[0],
        { ...NEW_RUBRIC_QUESTIONS[0], text: `  ${NEW_RUBRIC_QUESTIONS[0].text.toLowerCase()}  ` },
        ...NEW_RUBRIC_QUESTIONS.slice(1)
      ]
    }
  ]);

  const artifacts = await generateJdDerivedArtifactsForRole(
    { role: baseRole(), jdText: 'Replacement job description' },
    { supabaseClient: client, openaiClient, logger: { error() {} }, kbId: 'quality-kb-retry' }
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /QUALITY CORRECTION/);
  assert.equal(uploads.length, 1);
  assert.equal(artifacts.rubric_questions.length, BASIC_SCORED_QUESTION_COUNT);
  assert.deepEqual(
    artifacts.rubric_questions.map((question) => question.text),
    NEW_RUBRIC_QUESTIONS.map((question) => question.text)
  );
});

test('replacement artifact generation fails before KB upload when retry remains below minimum', async () => {
  const { client, uploads } = makeArtifactSupabase();
  const { client: openaiClient, prompts } = makeOpenAiResponses([
    { questions: [NEW_RUBRIC_QUESTIONS[0]] },
    { questions: [{ text: 'tell me about relevant patient-care experience.', category: 'experience' }] }
  ]);

  await assert.rejects(
    generateJdDerivedArtifactsForRole(
      { role: baseRole(), jdText: 'Replacement job description' },
      { supabaseClient: client, openaiClient, logger: { error() {} }, kbId: 'quality-kb-failed' }
    ),
    (error) => error.code === 'RUBRIC_QUESTION_QUALITY_FAILED'
      && error.detail.minimum === BASIC_SCORED_QUESTION_COUNT
      && error.detail.valid_question_count === 1
  );
  assert.equal(prompts.length, 2);
  assert.equal(uploads.length, 0);
});

test('replacement retry success activates the role with deduplicated questions', async () => {
  const db = makeDb();
  const billingBefore = structuredClone(db.state.billing);
  const { client: openaiClient, prompts } = makeOpenAiResponses([
    { questions: [NEW_RUBRIC_QUESTIONS[0]] },
    { questions: NEW_RUBRIC_QUESTIONS }
  ]);
  const { service, tavusCalls } = makeService(db, {
    generateArtifacts: ({ role, jdText }, options) => generateJdDerivedArtifactsForRole(
      { role, jdText },
      { ...options, openaiClient, kbId: 'quality-kb-activation' }
    )
  });

  const result = await service.replaceJobDescription(replacementRequest());

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.equal(result.role.rubric_questions.length, BASIC_SCORED_QUESTION_COUNT);
  assert.equal(db.state.rpcCalls.length, 1);
  assert.equal(tavusCalls.length, 1);
  assert.equal(db.state.storageUploads.filter((item) => item.bucket === 'kbs').length, 1);
  assert.equal(db.state.replacements[0].status, 'completed');
  assert.deepEqual(db.state.billing, billingBefore);
});

test('replacement retry quality failure leaves the active role unchanged before KB or Tavus work', async () => {
  const db = makeDb();
  const billingBefore = structuredClone(db.state.billing);
  const roleBefore = structuredClone(db.state.roles[0]);
  const { client: openaiClient, prompts } = makeOpenAiResponses([
    { questions: [NEW_RUBRIC_QUESTIONS[0]] },
    { questions: [{ text: ' tell me about relevant patient-care experience. ', category: 'experience' }] }
  ]);
  const { service, tavusCalls } = makeService(db, {
    generateArtifacts: ({ role, jdText }, options) => generateJdDerivedArtifactsForRole(
      { role, jdText },
      { ...options, openaiClient, kbId: 'quality-kb-never-uploaded' }
    )
  });

  await assert.rejects(
    service.replaceJobDescription(replacementRequest()),
    (error) => error.code === 'RUBRIC_QUESTION_QUALITY_FAILED' && error.stage === 'rubric_quality'
  );

  assert.equal(prompts.length, 2);
  assert.deepEqual(db.state.roles[0], roleBefore);
  assert.deepEqual(db.state.billing, billingBefore);
  assert.equal(db.state.rpcCalls.length, 0);
  assert.equal(tavusCalls.length, 0);
  assert.equal(db.state.storageUploads.filter((item) => item.bucket === 'kbs').length, 0);
  assert.equal(db.state.replacements[0].status, 'failed');
  assert.equal(db.state.replacements[0].error_metadata.code, 'RUBRIC_QUESTION_QUALITY_FAILED');
  assert.equal(db.state.replacements[0].error_metadata.stage, 'rubric_quality');
  assert.equal(db.state.storageDeletes.length, 0);
});

test('role/client mismatch is rejected without upload or audit creation', async () => {
  const db = makeDb();
  const { service } = makeService(db);
  await assert.rejects(
    service.replaceJobDescription({ ...replacementRequest(), clientId: '55555555-5555-4555-8555-555555555555' }),
    (error) => error.code === 'ROLE_NOT_FOUND' && error.status === 404
  );
  assert.equal(db.state.storageUploads.length, 0);
  assert.equal(db.state.replacements.length, 0);
});

test('invalid file type is rejected before upload or audit creation', async () => {
  const db = makeDb();
  const { service } = makeService(db);
  await assert.rejects(
    service.replaceJobDescription(replacementRequest('replacement.txt')),
    (error) => error.code === 'UNSUPPORTED_JD_FILE' && error.status === 415
  );
  assert.equal(db.state.storageUploads.length, 0);
  assert.equal(db.state.replacements.length, 0);
});

const directBlockers = [
  'candidates',
  'interviews',
  'reports',
  'otp_tokens',
  'accommodation_requests',
  'automation_evaluations',
  'automation_actions',
  'automation_digest_deliveries',
  'digest_logs'
];

test('candidate, interview, report, OTP, accommodation, automation, and digest activity block replacement', async (t) => {
  for (const table of directBlockers) {
    await t.test(table, async () => {
      const db = makeDb({ activity: { [table]: [{ id: `${table}-1`, role_id: ROLE_ID }] } });
      const { service } = makeService(db);
      await assert.rejects(
        service.replaceJobDescription(replacementRequest()),
        (error) => error.code === 'ROLE_ACTIVITY_EXISTS' && error.detail.includes(table)
      );
      assert.equal(db.state.storageUploads.length, 0);
      assert.equal(db.state.replacements.length, 0);
    });
  }
});

test('only non-archived automation rules block replacement', async () => {
  const activeDb = makeDb({ activity: { automation_rules: [{ id: 'rule-active', role_id: ROLE_ID, archived_at: null }] } });
  await assert.rejects(
    makeService(activeDb).service.replaceJobDescription(replacementRequest()),
    (error) => error.code === 'ROLE_ACTIVITY_EXISTS' && error.detail.includes('automation_rules')
  );

  const archivedDb = makeDb({ activity: { automation_rules: [{ id: 'rule-archived', role_id: ROLE_ID, archived_at: '2026-07-01T00:00:00Z' }] } });
  const result = await makeService(archivedDb).service.replaceJobDescription(replacementRequest());
  assert.equal(result.ok, true);
});

test('generation failure leaves active role unchanged and records failed history', async () => {
  const db = makeDb();
  const roleBefore = structuredClone(db.state.roles[0]);
  const { service } = makeService(db, {
    generateArtifacts: async () => { throw new Error('KB unavailable'); }
  });

  await assert.rejects(
    service.replaceJobDescription(replacementRequest()),
    (error) => error.code === 'JD_ARTIFACT_GENERATION_FAILED'
  );
  assert.deepEqual(db.state.roles[0], roleBefore);
  assert.equal(db.state.rpcCalls.length, 0);
  assert.equal(db.state.replacements[0].status, 'failed');
  assert.equal(db.state.replacements[0].error_metadata.stage, 'generation');
  assert.equal(db.state.storageDeletes.length, 0);
});

test('rubric quality failure leaves the active role unchanged and records structured history', async () => {
  const db = makeDb();
  const billingBefore = structuredClone(db.state.billing);
  const roleBefore = structuredClone(db.state.roles[0]);
  const qualityError = Object.assign(new Error('not enough valid questions'), {
    code: 'RUBRIC_QUESTION_QUALITY_FAILED',
    stage: 'rubric_quality',
    detail: { minimum: BASIC_SCORED_QUESTION_COUNT, valid_question_count: 1, attempts: 2 }
  });
  const { service, tavusCalls } = makeService(db, {
    generateArtifacts: async () => { throw qualityError; }
  });

  await assert.rejects(
    service.replaceJobDescription(replacementRequest()),
    (error) => error.code === 'RUBRIC_QUESTION_QUALITY_FAILED' && error.stage === 'rubric_quality'
  );
  assert.deepEqual(db.state.roles[0], roleBefore);
  assert.deepEqual(db.state.billing, billingBefore);
  assert.equal(db.state.rpcCalls.length, 0);
  assert.equal(tavusCalls.length, 0);
  assert.equal(db.state.replacements[0].status, 'failed');
  assert.equal(db.state.replacements[0].error_metadata.code, 'RUBRIC_QUESTION_QUALITY_FAILED');
  assert.equal(db.state.replacements[0].error_metadata.stage, 'rubric_quality');
  assert.equal(db.state.replacements[0].error_metadata.detail.valid_question_count, 1);
  assert.equal(db.state.storageDeletes.length, 0);
});

test('replacement service removes duplicate generated questions before activation', async () => {
  const db = makeDb();
  const duplicatedQuestions = [
    NEW_RUBRIC_QUESTIONS[0],
    { ...NEW_RUBRIC_QUESTIONS[0], text: ` ${NEW_RUBRIC_QUESTIONS[0].text.toLowerCase()} `, category: 'duplicate' },
    ...NEW_RUBRIC_QUESTIONS.slice(1)
  ];
  const { service } = makeService(db, {
    generateArtifacts: async () => ({
      description: 'New JD excerpt',
      rubric: {
        membership_level: 'basic',
        interview_type: 'leadership',
        questions: duplicatedQuestions
      },
      rubric_questions: duplicatedQuestions,
      kb_document_id: 'kb-new'
    })
  });

  const result = await service.replaceJobDescription(replacementRequest());
  assert.equal(result.ok, true);
  assert.equal(result.role.rubric_questions.length, BASIC_SCORED_QUESTION_COUNT);
  assert.deepEqual(
    result.role.rubric_questions.map((question) => question.text),
    NEW_RUBRIC_QUESTIONS.map((question) => question.text)
  );
});

test('replacement service rejects too many questions and missing plan metadata before activation', async () => {
  for (const rubric of [
    {
      membership_level: 'basic',
      interview_type: 'leadership',
      questions: [
        ...NEW_RUBRIC_QUESTIONS,
        { ...NEW_RUBRIC_QUESTIONS[0], text: 'Describe a distinct sixth competency.' }
      ]
    },
    { interview_type: 'leadership', questions: NEW_RUBRIC_QUESTIONS }
  ]) {
    const db = makeDb();
    const { service, tavusCalls } = makeService(db, {
      generateArtifacts: async () => ({
        description: 'New JD excerpt',
        rubric,
        rubric_questions: rubric.questions,
        kb_document_id: 'kb-rejected-exact-gate'
      })
    });

    await assert.rejects(
      service.replaceJobDescription(replacementRequest()),
      (error) => error.code === 'RUBRIC_QUESTION_QUALITY_FAILED'
    );
    assert.equal(db.state.rpcCalls.length, 0);
    assert.equal(tavusCalls.length, 0);
  }
});

test('quality rejection preserves a generated KB reference in failed history without Tavus activation', async () => {
  const db = makeDb();
  const { service, tavusCalls } = makeService(db, {
    generateArtifacts: async () => ({
      description: 'New JD excerpt',
      rubric: {
        membership_level: 'basic',
        interview_type: 'leadership',
        questions: [NEW_RUBRIC_QUESTIONS[0]]
      },
      rubric_questions: [NEW_RUBRIC_QUESTIONS[0]],
      kb_document_id: 'kb-preserved-failed-attempt'
    })
  });

  await assert.rejects(
    service.replaceJobDescription(replacementRequest()),
    (error) => error.code === 'RUBRIC_QUESTION_QUALITY_FAILED'
  );

  assert.equal(db.state.replacements[0].status, 'failed');
  assert.equal(db.state.replacements[0].new_kb_document_id, 'kb-preserved-failed-attempt');
  assert.equal(db.state.rpcCalls.length, 0);
  assert.equal(tavusCalls.length, 0);
  assert.equal(db.state.storageDeletes.length, 0);
});

test('Tavus failure leaves active role and stale prompt unchanged until a later successful attempt', async () => {
  const db = makeDb();
  const roleBefore = structuredClone(db.state.roles[0]);
  const { service } = makeService(db, {
    ensureTavusDocument: async () => { throw new Error('Tavus unavailable'); }
  });

  await assert.rejects(
    service.replaceJobDescription(replacementRequest()),
    (error) => error.code === 'TAVUS_DOCUMENT_CREATION_FAILED'
  );
  assert.deepEqual(db.state.roles[0], roleBefore);
  assert.equal(db.state.rpcCalls.length, 0);
  assert.equal(db.state.replacements[0].status, 'failed');
  assert.equal(db.state.storageDeletes.length, 0);
});

test('activity race reported by completion RPC does not partially update active role', async () => {
  const db = makeDb({ rpcError: { message: 'ROLE_ACTIVITY_EXISTS' } });
  const roleBefore = structuredClone(db.state.roles[0]);
  const { service } = makeService(db);

  await assert.rejects(
    service.replaceJobDescription(replacementRequest()),
    (error) => error.code === 'ROLE_ACTIVITY_EXISTS' && error.stage === 'completion'
  );
  assert.deepEqual(db.state.roles[0], roleBefore);
  assert.equal(db.state.replacements[0].status, 'failed');
});

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function routeApp({ authenticated = true, membershipRole = 'manager', service } = {}) {
  const app = express();
  const requireAuth = (req, res, next) => {
    if (!authenticated) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: 'user-1', email: 'manager@example.com' };
    return next();
  };
  const withClientScope = (req, _res, next) => {
    req.clientScope = { memberships: [{ client_id: CLIENT_ID, role: membershipRole }] };
    return next();
  };
  app.use('/roles', createRoleJdReplacementRouter({
    requireAuth,
    withClientScope,
    service: service || { replaceJobDescription: async () => ({ ok: true }) }
  }));
  return app;
}

function multipartBody(filename = 'replacement.pdf') {
  const form = new FormData();
  form.append('client_id', CLIENT_ID);
  form.append('reason', 'Wrong upload');
  form.append('file', new Blob(['fixture']), filename);
  return form;
}

test('unauthenticated replacement request is rejected', async () => {
  await withServer(routeApp({ authenticated: false }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/roles/${ROLE_ID}/job-description-replacement`, {
      method: 'POST',
      body: multipartBody()
    });
    assert.equal(response.status, 401);
  });
});

test('read-only scoped member is rejected by backend authorization', async () => {
  let called = false;
  const service = { replaceJobDescription: async () => { called = true; } };
  await withServer(routeApp({ membershipRole: 'member', service }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/roles/${ROLE_ID}/job-description-replacement`, {
      method: 'POST',
      body: multipartBody()
    });
    assert.equal(response.status, 403);
    assert.equal(called, false);
  });
});

test('multipart route rejects unsupported files', async () => {
  await withServer(routeApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/roles/${ROLE_ID}/job-description-replacement`, {
      method: 'POST',
      body: multipartBody('replacement.txt')
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, 'UNSUPPORTED_JD_FILE');
  });
});

test('migration creates protected history, ensures Tavus column, and atomically rechecks activity', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const migration = fs.readdirSync(migrationsDir)
    .find((filename) => filename.endsWith('_role_jd_replacement_foundation.sql'));
  assert.ok(migration);
  const sql = fs.readFileSync(path.join(migrationsDir, migration), 'utf8');

  assert.match(sql, /add column if not exists tavus_document_id text/i);
  assert.match(sql, /create table if not exists public\.role_jd_replacements/i);
  assert.match(sql, /old_tavus_prompt text/i);
  assert.match(sql, /new_tavus_prompt text/i);
  assert.match(sql, /alter table public\.role_jd_replacements enable row level security/i);
  assert.match(sql, /grant select, insert, update on table public\.role_jd_replacements to service_role/i);
  assert.match(sql, /create or replace function public\.complete_role_jd_replacement/i);
  assert.match(sql, /for update/i);
  for (const table of directBlockers.concat('automation_rules')) {
    assert.match(sql, new RegExp(`public\\.${table}`));
  }
  assert.match(sql, /automation_action_approval_tokens/i);
  assert.match(sql, /automation_digest_approval_tokens/i);
  assert.doesNotMatch(sql, /update public\.(pending_role_purchases|client_role_credits|role_interview_purchases)/i);
});

test('route and service do not contain storage or Tavus deletion calls', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'roleJdReplacement.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'client', 'roleJdReplacement.js'), 'utf8');
  assert.doesNotMatch(serviceSource, /\.remove\s*\(|deleteTavus|\/documents\//i);
  assert.doesNotMatch(routeSource, /\.remove\s*\(|deleteTavus|\/documents\//i);
});

test('replacement errors retain structured status and code', () => {
  const error = new RoleJdReplacementError('blocked', { status: 409, code: 'ROLE_ACTIVITY_EXISTS' });
  assert.equal(error.status, 409);
  assert.equal(error.code, 'ROLE_ACTIVITY_EXISTS');
});
