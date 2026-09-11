'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { discoverPronunciationCandidates } = require('../src/services/pronunciationDiscovery');

test('role title, JD, and rubric scanning detects dental terms and acronyms', () => {
  const results = discoverPronunciationCandidates({
    roleTitle: 'Endodontic Assistant',
    jobDescription: 'Support periodontics workflows and review CBCT images.',
    rubricQuestions: ['How do you explain xerostomia?'],
    industryKey: 'dental',
  });
  assert.ok(results.some((item) => item.term === 'endodontics' && item.source_context === 'role_title'));
  assert.ok(results.some((item) => item.term === 'periodontics' && item.source_context === 'job_description'));
  assert.ok(results.some((item) => item.term === 'xerostomia' && item.source_context === 'rubric'));
  assert.ok(results.some((item) => item.term === 'CBCT'));
  assert.ok(results.every((item) => item.verification_status === 'suggested' && item.auto_publish === false));
});

test('matching uses token boundaries and preserves slash acronyms', () => {
  const results = discoverPronunciationCandidates({
    roleTitle: 'Dental Assistant',
    jobDescription: 'Review CAD/CAM records without flagging an ordinary learning curve or curvature language.',
    industryKey: 'dental',
  });
  assert.ok(results.some((item) => item.term === 'CAD/CAM'));
  assert.ok(!results.some((item) => item.term === 'Curve'));
});

test('common-noun brands require explicit approved client terminology', () => {
  const results = discoverPronunciationCandidates({
    roleTitle: 'Practice Manager',
    jobDescription: 'Describe the learning curve for a new scheduling workflow.',
    approvedClientTerminology: ['Curve'],
    clientId: 'client-a',
    industryKey: 'dental',
  });
  assert.ok(results.some((item) => item.term === 'Curve' && item.source_context === 'approved_client_terminology'));
  assert.ok(!results.some((item) => item.term === 'Curve' && item.source_context === 'job_description'));
});

test('ordinary English is not broadly flagged', () => {
  assert.deepEqual(discoverPronunciationCandidates({ roleTitle: 'Practice Manager', jobDescription: 'Help patients schedule visits and answer questions.', industryKey: 'dental' }), []);
});

test('duplicates deduplicate and known terms resolve instead of re-suggesting', () => {
  const results = discoverPronunciationCandidates({
    roleTitle: 'CBCT Assistant', jobDescription: 'Review CBCT scans and CBCT records.', industryKey: 'dental',
  }, { knownTerms: ['CBCT'] });
  assert.ok(!results.some((item) => item.term === 'CBCT'));
});

test('personal name fields are not scanned or auto-published', () => {
  const results = discoverPronunciationCandidates({ roleTitle: 'Dental Assistant', jobDescription: 'Welcome each patient.', candidateName: 'Unusualname', managerName: 'Anothername', industryKey: 'dental' });
  assert.ok(!results.some((item) => /Unusualname|Anothername/.test(item.term)));
});

test('AI suggestions remain suggestions without an auto-verification path', () => {
  const results = discoverPronunciationCandidates({ jobDescription: 'Experience with ZYQX systems.', clientId: 'client-a' });
  assert.equal(results[0].verification_status, 'suggested');
  assert.equal(results[0].suggested_pronunciation, null);
  assert.equal(results[0].auto_publish, false);
});
