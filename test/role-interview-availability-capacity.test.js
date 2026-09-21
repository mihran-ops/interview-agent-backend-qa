'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  getRoleInterviewAvailability,
} = require('../src/services/roleInterviewAvailability');

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
  }

  select(columns) {
    this.db.selects.push({ table: this.table, columns });
    return this;
  }

  eq(column, value) {
    this.filters.push([column, value]);
    return this;
  }

  filteredRows() {
    return (this.db.tables[this.table] || []).filter((row) => (
      this.filters.every(([column, value]) => String(row?.[column] ?? '') === String(value ?? ''))
    ));
  }

  async maybeSingle() {
    return { data: this.filteredRows()[0] || null, error: null };
  }

  async execute() {
    return { data: this.filteredRows(), error: null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

function createDatabase(interviews) {
  return {
    tables: {
      clients: [{ id: CLIENT_ID, parent_client_id: null }],
      client_plan_settings: [{ client_id: CLIENT_ID, included_interviews_per_role: 5 }],
      role_interview_purchases: [{
        client_id: CLIENT_ID,
        role_id: ROLE_ID,
        status: 'paid',
        quantity: 2,
      }],
      interviews: interviews.map((row, index) => ({
        id: `interview-${index + 1}`,
        client_id: CLIENT_ID,
        role_id: ROLE_ID,
        ...row,
      })),
    },
    selects: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

async function getAvailability(interviews) {
  const db = createDatabase(interviews);
  const availability = await getRoleInterviewAvailability({
    db,
    roleId: ROLE_ID,
    clientId: CLIENT_ID,
  });
  return { availability, db };
}

test('no-substantive interviews do not consume role capacity', async () => {
  const { availability, db } = await getAvailability([
    {
      status: 'Incomplete',
      transcript_scores: { overall: null },
      interview_summary: 'Interview ended before a substantive candidate response was recorded.',
      has_substantive_response: false,
      failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
      conversation_progress_state: 'NoSubstantiveCandidateResponse',
    },
    {
      status: 'Analyzed',
      transcript_scores: { overall: 82 },
      interview_summary: 'Stale analysis data must not override the current no-response marker.',
      has_substantive_response: false,
      failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
      conversation_progress_state: 'NoSubstantiveCandidateResponse',
    },
    {
      status: 'Ended',
      transcript_scores: { overall: null },
      interview_summary: 'Interview ended before any substantive responses were recorded. Please try again.',
    },
  ]);

  // The last four keys arrived with the billing models. This client has no
  // stored model, so the plan tier decides it; with no tier it is the default.
  assert.deepEqual(availability, {
    included_interviews_per_role: 5,
    purchased_interviews: 2,
    used_interviews: 0,
    remaining_interviews: 7,
    own_remaining_interviews: 7,
    credit_interviews: 0,
    rollover_drawn_offset: 0,
    billing_model: 'fixed',
  });

  const interviewSelect = db.selects.find(({ table }) => table === 'interviews');
  assert.ok(interviewSelect, 'expected the capacity query to select interviews');
  for (const field of [
    'has_substantive_response',
    'failure_code',
    'conversation_progress_state',
  ]) {
    assert.match(interviewSelect.columns, new RegExp(`(?:^|,)${field}(?:,|$)`));
  }
});

test('null transcript scores do not count as a numeric analyzed result', async () => {
  const { availability } = await getAvailability([
    {
      status: 'Started',
      transcript_scores: { overall: null },
      interview_summary: null,
      has_substantive_response: null,
      failure_code: null,
      conversation_progress_state: null,
    },
  ]);

  assert.equal(availability.used_interviews, 0);
  assert.equal(availability.remaining_interviews, 7);
});

test('substantive and legacy completed interviews still consume capacity', async () => {
  const { availability } = await getAvailability([
    {
      status: 'Analyzed',
      transcript_scores: { overall: 91 },
      interview_summary: 'Candidate supplied substantive answers.',
      has_substantive_response: true,
      failure_code: null,
      conversation_progress_state: 'Completed',
    },
    {
      status: 'Completed',
      transcript_scores: null,
      interview_summary: null,
    },
    {
      status: 'Analyzed',
      transcript_scores: { overall: 77 },
      interview_summary: 'Interview ended before a substantive candidate response was recorded.',
      has_substantive_response: true,
      failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
      conversation_progress_state: 'NoSubstantiveCandidateResponse',
    },
  ]);

  assert.equal(availability.used_interviews, 3);
  assert.equal(availability.remaining_interviews, 4);
});

test('structured no-substantive state excludes legacy rows without a boolean marker', async () => {
  const { availability } = await getAvailability([
    {
      status: 'Incomplete',
      transcript_scores: null,
      interview_summary: 'Provider ended the conversation.',
      failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
    },
    {
      status: 'Incomplete',
      transcript_scores: null,
      interview_summary: 'Provider ended the conversation.',
      conversation_progress_state: 'NoSubstantiveCandidateResponse',
    },
  ]);

  assert.equal(availability.used_interviews, 0);
  assert.equal(availability.remaining_interviews, 7);
});
