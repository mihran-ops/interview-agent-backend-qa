'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DENTAL_PRONUNCIATION_SEED } = require('../src/data/pronunciation/dentalSeed');
const DENTAL_CORPUS = require('./fixtures/dental-pronunciation-corpus.json');
const {
  compileTavusPronunciationRules,
  normalizePronunciationTerm,
  resolvePronunciationTerms,
  validatePronunciationTerm,
} = require('../src/services/pronunciationRegistry');

function term(overrides = {}) {
  return {
    id: overrides.id || 'a', canonical_term: 'alphaScreen', normalized_term: 'alphascreen',
    pronunciation_method: 'alias', pronunciation_value: 'alpha screen', scope_type: 'global',
    source: 'manual', verification_status: 'verified', is_active: true, version: 1,
    ...overrides,
  };
}

test('normalization preserves meaningful slash and hyphen distinctions', () => {
  assert.equal(normalizePronunciationTerm(' CAD/CAM '), 'cad/cam');
  assert.notEqual(normalizePronunciationTerm('CAD/CAM'), normalizePronunciationTerm('CAD-CAM'));
});

test('scope binding and bounded enums are validated', () => {
  assert.throws(() => validatePronunciationTerm(term({ scope_type: 'industry' })), /industry_scope_binding/);
  assert.throws(() => validatePronunciationTerm(term({ pronunciation_method: 'phonetic' })), /method_invalid/);
  assert.throws(() => validatePronunciationTerm(term({ source: 'free_text' })), /source_invalid/);
  assert.throws(() => validatePronunciationTerm(term({ normalized_term: 'wrong-key' })), /normalized_term_mismatch/);
  assert.throws(() => validatePronunciationTerm(term({ scope_type: 'client', client_id: 'client-a', industry_key: 'dental' })), /client_scope_binding/);
  assert.throws(() => validatePronunciationTerm(term({ scope_type: 'industry', industry_key: 'Dental Care' })), /industry_key_invalid/);
});

test('client precedence beats industry and global deterministically', () => {
  const rows = [
    term({ id: 'global', canonical_term: 'term', normalized_term: 'term', pronunciation_value: 'global' }),
    term({ id: 'industry', canonical_term: 'term', normalized_term: 'term', pronunciation_value: 'industry', scope_type: 'industry', industry_key: 'dental' }),
    term({ id: 'client', canonical_term: 'term', normalized_term: 'term', pronunciation_value: 'client', scope_type: 'client', client_id: 'client-a' }),
  ];
  assert.equal(resolvePronunciationTerms(rows, { industryKey: 'dental', clientId: 'client-a' })[0].pronunciation_value, 'client');
  assert.equal(resolvePronunciationTerms(rows, { industryKey: 'dental', clientId: 'client-b' })[0].pronunciation_value, 'industry');
  assert.equal(resolvePronunciationTerms(rows, {})[0].pronunciation_value, 'global');
});

test('inactive, suggested, rejected, and deprecated terms are excluded', () => {
  const rows = [
    term({ id: 'verified' }),
    term({ id: 'inactive', canonical_term: 'inactive', normalized_term: 'inactive', is_active: false }),
    term({ id: 'suggested', canonical_term: 'suggested', normalized_term: 'suggested', verification_status: 'suggested' }),
    term({ id: 'rejected', canonical_term: 'rejected', normalized_term: 'rejected', verification_status: 'rejected' }),
    term({ id: 'deprecated', canonical_term: 'deprecated', normalized_term: 'deprecated', verification_status: 'deprecated' }),
  ];
  assert.deepEqual(resolvePronunciationTerms(rows).map((row) => row.id), ['verified']);
});

test('unrelated clients are isolated by resolution', () => {
  const rows = [term({ scope_type: 'client', client_id: 'client-a' })];
  assert.equal(resolvePronunciationTerms(rows, { clientId: 'client-b' }).length, 0);
});

test('alias and IPA serialize explicitly without changing canonical text', () => {
  const rules = compileTavusPronunciationRules([
    term({ canonical_term: 'prosthodontics', normalized_term: 'prosthodontics', pronunciation_value: 'pros-thoh-DON-tiks' }),
    term({ id: 'ipa', canonical_term: 'bayou', normalized_term: 'bayou', pronunciation_method: 'ipa', pronunciation_value: 'ˈbɑju' }),
  ]);
  assert.deepEqual(rules.map((rule) => [rule.text, rule.type]), [['bayou', 'ipa'], ['prosthodontics', 'alias']]);
  assert.equal(rules[0].alphabet, 'ipa');
  assert.equal(Object.hasOwn(rules[1], 'alphabet'), false);
  assert.equal(rules[1].text, 'prosthodontics');
});

test('provider serialization independently excludes non-runtime records', () => {
  const rules = compileTavusPronunciationRules([
    term({ id: 'verified' }),
    term({ id: 'suggested', canonical_term: 'suggested', normalized_term: 'suggested', verification_status: 'suggested' }),
    term({ id: 'inactive', canonical_term: 'inactive', normalized_term: 'inactive', is_active: false }),
  ]);
  assert.deepEqual(rules.map((rule) => rule.text), ['alphaScreen']);
});

test('dental seed keeps unverified inventory out of runtime', () => {
  const runtime = resolvePronunciationTerms(DENTAL_PRONUNCIATION_SEED, { industryKey: 'dental' });
  assert.equal(runtime.length, 9);
  assert.equal(runtime.filter((row) => row.version === 2).length, 6);
  assert.deepEqual(runtime.filter((row) => row.version === 3).map((row) => row.canonical_term).sort(), ['orthodontics', 'prophylaxis']);
  assert.deepEqual(runtime.filter((row) => row.version === 5).map((row) => row.canonical_term), ['gingiva']);
  assert.equal(runtime.filter((row) => row.pronunciation_method === 'ipa').length, 7);
  assert.equal(runtime.find((row) => row.canonical_term === 'gingiva').pronunciation_value, 'jinjivuh');
  assert.ok(runtime.some((row) => row.canonical_term === 'CBCT'));
  assert.equal(runtime.find((row) => row.canonical_term === 'CBCT').pronunciation_value, 'see bee see tee');
  assert.ok(!runtime.some((row) => row.canonical_term === 'CAD/CAM'));
  assert.ok(!runtime.some((row) => row.canonical_term === 'Dentrix'));
});

test('contextual corpus covers every verified dental rule and keeps unresolved examples excluded', () => {
  const runtime = resolvePronunciationTerms(DENTAL_PRONUNCIATION_SEED, { industryKey: 'dental' });
  const cases = new Map(DENTAL_CORPUS.map((item) => [item.term, item]));
  assert.equal(DENTAL_CORPUS.length, 12);
  for (const item of runtime) {
    assert.equal(cases.get(item.canonical_term)?.expected, item.pronunciation_value, item.canonical_term);
    assert.match(cases.get(item.canonical_term)?.sentence || '', new RegExp(item.canonical_term.replace('/', '\\/'), 'i'));
  }
  assert.match(cases.get('CAD/CAM').expected, /excluded/);
  assert.match(cases.get('Dentrix').expected, /excluded/);
  assert.equal(cases.get('SyntheticSmileOS').scope, 'client:synthetic');
});
