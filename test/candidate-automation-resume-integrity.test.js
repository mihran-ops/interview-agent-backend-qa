'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { evaluateCandidateAutomation } = require('../src/services/candidateAutomationEvaluator');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
  }
  select() { return this; }
  eq() { return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() {
    if (this.table === 'roles') return Promise.resolve({ data: this.db.role, error: null });
    if (this.table === 'candidates') return Promise.resolve({ data: this.db.candidate, error: null });
    return Promise.resolve({ data: null, error: null });
  }
  then(resolve, reject) {
    let result = { data: [], error: null };
    if (this.table === 'reports') result = { data: this.db.reports, error: null };
    if (this.table === 'interviews') result = { data: this.db.interviews, error: null };
    return Promise.resolve(result).then(resolve, reject);
  }
}

function cleanIntegrity() {
  return {
    version: 'resume_integrity_r1_v1',
    mode: 'shadow_with_automation_gate',
    status: 'clean',
    manual_review_required: false,
    automation_eligible: true,
    format_assessment: 'structured_docx',
    content_sha256: 'a'.repeat(64),
    reason_codes: [],
    signal_counts: {}
  };
}

function fakeDb(integrity) {
  return {
    role: { id: 'role-1', client_id: 'client-1', title: 'Patient Coordinator' },
    candidate: {
      id: 'candidate-1',
      client_id: 'client-1',
      role_id: 'role-1',
      name: 'Synthetic Candidate',
      email: 'candidate@example.invalid',
      interview_status: 'pending',
      analysis_summary: {}
    },
    reports: [{
      id: 'report-1',
      candidate_id: 'candidate-1',
      client_id: 'client-1',
      role_id: 'role-1',
      resume_score: 88,
      interview_score: null,
      overall_score: 88,
      resume_breakdown: integrity === undefined ? {} : { resume_integrity: integrity }
    }],
    interviews: [],
    from(table) { return new FakeQuery(this, table); }
  };
}

const baseInput = {
  clientId: 'client-1',
  roleId: 'role-1',
  candidateId: 'candidate-1',
  criteriaConfig: {
    min_resume_score: 80,
    allow_resume_only: true
  }
};

test('clean R1 evidence permits existing resume-only automation behavior', async () => {
  const result = await evaluateCandidateAutomation({ ...baseInput, db: fakeDb(cleanIntegrity()) });
  assert.equal(result.matched, true);
  assert.equal(result.normalizedCandidateSnapshot.resume_score, 88);
  assert.equal(result.normalizedCandidateSnapshot.resume_integrity.status, 'clean');
  assert.equal(Object.hasOwn(result.normalizedCandidateSnapshot.resume_integrity, 'content_sha256'), false);
});

test('suspicious resume evidence nulls derived scores and blocks automation without rejection language', async () => {
  const suspicious = {
    ...cleanIntegrity(),
    status: 'suspicious',
    manual_review_required: true,
    automation_eligible: false,
    reason_codes: ['resume_instruction_override_language']
  };
  const result = await evaluateCandidateAutomation({ ...baseInput, db: fakeDb(suspicious) });

  assert.equal(result.matched, false);
  assert.equal(result.normalizedCandidateSnapshot.resume_score, null);
  assert.equal(result.normalizedCandidateSnapshot.overall_score, null);
  assert.ok(result.nonMatchReasons.some((reason) => reason.code === 'resume_integrity_manual_review_required'));
  assert.doesNotMatch(JSON.stringify(result), /dishonest|fraud|cheat/i);
});

test('legacy reports without integrity evidence fail closed as unassessed', async () => {
  const result = await evaluateCandidateAutomation({ ...baseInput, db: fakeDb(undefined) });
  assert.equal(result.matched, false);
  assert.equal(result.normalizedCandidateSnapshot.resume_score, null);
  assert.equal(result.normalizedCandidateSnapshot.resume_integrity.status, 'unassessed');
  assert.ok(result.nonMatchReasons.some((reason) => reason.code === 'resume_integrity_unassessed'));
});
