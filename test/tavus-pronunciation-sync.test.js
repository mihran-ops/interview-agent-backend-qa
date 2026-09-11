'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DENTAL_PRONUNCIATION_SEED } = require('../src/data/pronunciation/dentalSeed');
const { TavusProviderError } = require('../src/clients/tavus');
const { assertQaOnly, classifySyncFailure, compileResolvedDictionary, synchronizeTavusPronunciation } = require('../src/services/tavusPronunciationSync');

function harness(options = {}) {
  const calls = [];
  let dictionary = options.dictionary || null;
  let livePal = {
    pal_id: 'qa-pal', system_prompt: 'unchanged', layers: { tts: { tts_engine: 'cartesia', external_voice_id: 'voice' }, stt: { engine: 'sparrow' } },
  };
  let draftPal = JSON.parse(JSON.stringify(livePal));
  let publishFailuresRemaining = options.publishFailures || 0;
  return {
    calls,
    state: {
      get livePal() { return livePal; },
      get draftPal() { return draftPal; },
    },
    client: {
      async listPronunciationDictionaries() {
        calls.push(['list_dictionaries']);
        const data = options.listDictionaries || [];
        return { data, total_count: data.length };
      },
      async getPronunciationDictionary(id) { calls.push(['get_dictionary', id]); return dictionary; },
      async createPronunciationDictionary(body) { calls.push(['create_dictionary', body]); dictionary = { pronunciation_dictionary_id: 'dict-1', ...body }; return dictionary; },
      async updatePronunciationDictionary(id, patch) { calls.push(['update_dictionary', id, patch]); dictionary = { pronunciation_dictionary_id: id, name: patch[0].value, rules: patch[1].value }; return dictionary; },
      async getPal(_id, query = {}) {
        calls.push(['get_pal', query]);
        if (query.source === 'draft') return { ...JSON.parse(JSON.stringify(draftPal)), has_unpublished_changes: Boolean(draftPal.has_unpublished_changes) };
        return JSON.parse(JSON.stringify(livePal));
      },
      async patchPal(_id, patch) {
        calls.push(['patch_pal', patch]);
        if (options.patchTarget === 'draft') {
          draftPal.layers.tts.pronunciation_dictionary_id = patch[0].value;
          draftPal.has_unpublished_changes = true;
          return { edit_target: 'draft' };
        }
        livePal.layers.tts.pronunciation_dictionary_id = patch[0].value;
        draftPal = JSON.parse(JSON.stringify(livePal));
        return { edit_target: 'live' };
      },
      async publishPal() {
        calls.push(['publish_pal']);
        if (publishFailuresRemaining > 0) {
          publishFailuresRemaining -= 1;
          throw new TavusProviderError({ operation: 'publish_pal', category: 'timeout', timeout: true });
        }
        livePal = JSON.parse(JSON.stringify(draftPal));
        delete livePal.has_unpublished_changes;
        draftPal = JSON.parse(JSON.stringify(livePal));
        return livePal;
      },
    },
  };
}

test('QA-only guard rejects production and mismatched PALs', () => {
  assert.throws(() => assertQaOnly({ environment: 'production', palId: 'prod', expectedQaPalId: 'prod' }), /qa_only/);
  assert.throws(() => assertQaOnly({ environment: 'qa', palId: 'prod', expectedQaPalId: 'qa', productionPalIds: ['prod'] }), /not_allowlisted/);
  assert.throws(() => assertQaOnly({ environment: 'qa', palId: 'prod', expectedQaPalId: 'prod', productionPalIds: ['prod'] }), /production_pal/);
});

test('compiled source and provider hashes are deterministic', () => {
  const one = compileResolvedDictionary(DENTAL_PRONUNCIATION_SEED, { industryKey: 'dental' });
  const two = compileResolvedDictionary([...DENTAL_PRONUNCIATION_SEED].reverse(), { industryKey: 'dental' });
  assert.equal(one.sourceHash, two.sourceHash);
  assert.equal(one.providerPayloadHash, two.providerPayloadHash);
  assert.equal(one.rules.length, 9);
});

test('dry-run plans without provider calls', async () => {
  const h = harness();
  const result = await synchronizeTavusPronunciation({ tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' }, environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal' });
  assert.equal(result.applied, false);
  assert.equal(h.calls.length, 0);
});

test('first sync creates one dictionary, persists identity, attaches, and preserves PAL config', async () => {
  const h = harness();
  const persisted = [];
  const result = await synchronizeTavusPronunciation({
    tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' },
    environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', apply: true,
    persistProviderIdentity: async (id) => persisted.push(id),
  });
  assert.deepEqual(persisted, ['dict-1']);
  assert.equal(h.calls.filter(([name]) => name === 'create_dictionary').length, 1);
  assert.equal(result.attachmentAction, 'attached');
  assert.equal(result.beforeNonPronunciationHash, result.afterNonPronunciationHash);
  assert.ok(h.calls.findIndex(([name]) => name === 'list_dictionaries') < h.calls.findIndex(([name]) => name === 'create_dictionary'));
});

test('draft-routed attachment publishes and preserves non-pronunciation PAL config', async () => {
  const h = harness({ patchTarget: 'draft' });
  const stages = [];
  const result = await synchronizeTavusPronunciation({
    tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' },
    environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', apply: true,
    beforeAttachmentMutation: async (stage) => stages.push(stage),
  });
  assert.deepEqual(stages, ['patch', 'publish_new_draft']);
  assert.equal(h.calls.filter(([name]) => name === 'publish_pal').length, 1);
  assert.equal(result.beforeNonPronunciationHash, result.afterNonPronunciationHash);
});

test('lost publish response recovers the existing safe draft without re-patching', async () => {
  const compiled = compileResolvedDictionary(DENTAL_PRONUNCIATION_SEED, { industryKey: 'dental' });
  const h = harness({
    patchTarget: 'draft', publishFailures: 1,
    dictionary: { pronunciation_dictionary_id: 'dict-1', name: compiled.name, rules: compiled.rules },
  });
  const base = {
    tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' },
    environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', dictionaryId: 'dict-1', apply: true,
  };
  await assert.rejects(() => synchronizeTavusPronunciation(base), /Tavus request timed out/);
  const patchCount = h.calls.filter(([name]) => name === 'patch_pal').length;
  const recovered = await synchronizeTavusPronunciation(base);
  assert.equal(recovered.attachmentAction, 'published_existing_draft');
  assert.equal(h.calls.filter(([name]) => name === 'patch_pal').length, patchCount);
  assert.equal(h.calls.filter(([name]) => name === 'publish_pal').length, 2);
});

test('unbound provider state reconciles by exact name and payload without duplicate creation', async () => {
  const compiled = compileResolvedDictionary(DENTAL_PRONUNCIATION_SEED, { industryKey: 'dental' });
  const providerDictionary = { pronunciation_dictionary_id: 'dict-existing', name: compiled.name, rules: compiled.rules };
  const h = harness({ dictionary: providerDictionary, listDictionaries: [{ pronunciation_dictionary_id: 'dict-existing', name: compiled.name }] });
  const persisted = [];
  const result = await synchronizeTavusPronunciation({
    tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' },
    environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', apply: true, allowCreate: false,
    persistProviderIdentity: async (id) => persisted.push(id),
  });
  assert.equal(result.action, 'reconciled');
  assert.deepEqual(persisted, ['dict-existing']);
  assert.equal(h.calls.filter(([name]) => name === 'create_dictionary').length, 0);
});

test('ambiguous create and update outcomes fail closed instead of replaying mutations', async () => {
  const create = harness();
  await assert.rejects(() => synchronizeTavusPronunciation({
    tavusHttpClient: create.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' },
    environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', apply: true, allowCreate: false,
  }), /creation_requires_manual_reconciliation/);
  assert.equal(create.calls.filter(([name]) => name === 'create_dictionary').length, 0);

  const update = harness({ dictionary: { pronunciation_dictionary_id: 'dict-1', name: 'old', rules: [] } });
  await assert.rejects(() => synchronizeTavusPronunciation({
    tavusHttpClient: update.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' },
    environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', dictionaryId: 'dict-1', apply: true, allowUpdate: false,
  }), /update_requires_manual_reconciliation/);
  assert.equal(update.calls.filter(([name]) => name === 'update_dictionary').length, 0);
});

test('ambiguous sync states remain sticky until provider reconciliation succeeds', () => {
  assert.equal(classifySyncFailure({ error: new Error('pronunciation_dictionary_creation_requires_manual_reconciliation'), priorSyncState: 'create_ambiguous', providerDictionaryId: null }), 'create_ambiguous');
  assert.equal(classifySyncFailure({ error: new Error('pronunciation_dictionary_update_requires_manual_reconciliation'), priorSyncState: 'update_ambiguous', providerDictionaryId: 'dict-1' }), 'update_ambiguous');
  assert.equal(classifySyncFailure({ error: new Error('bounded validation'), priorSyncState: 'synchronized', providerDictionaryId: 'dict-1' }), 'failed');
  assert.equal(classifySyncFailure({ error: new TavusProviderError({ operation: 'list_pronunciation_dictionaries', category: 'timeout', timeout: true }), priorSyncState: 'planned', providerDictionaryId: null }), 'failed');
  assert.equal(classifySyncFailure({ error: new TavusProviderError({ operation: 'create_pronunciation_dictionary', category: 'timeout', timeout: true }), priorSyncState: 'planned', providerDictionaryId: null }), 'create_ambiguous');
  assert.equal(classifySyncFailure({ error: new TavusProviderError({ operation: 'update_pronunciation_dictionary', category: 'network' }), priorSyncState: 'synchronized', providerDictionaryId: 'dict-1' }), 'update_ambiguous');
  assert.equal(classifySyncFailure({ error: new TavusProviderError({ operation: 'patch_pal', category: 'timeout', timeout: true }), priorSyncState: 'synchronized', providerDictionaryId: 'dict-1' }), 'attachment_ambiguous');
  assert.equal(classifySyncFailure({ error: new TavusProviderError({ operation: 'get_pal', category: 'timeout', timeout: true }), priorSyncState: 'synchronized', providerDictionaryId: 'dict-1' }), 'failed');
});

test('unrelated unpublished PAL draft fails closed without patch or publish', async () => {
  const compiled = compileResolvedDictionary(DENTAL_PRONUNCIATION_SEED, { industryKey: 'dental' });
  const h = harness({
    patchTarget: 'draft', publishFailures: 1,
    dictionary: { pronunciation_dictionary_id: 'dict-1', name: compiled.name, rules: compiled.rules },
  });
  const base = {
    tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' },
    environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', dictionaryId: 'dict-1', apply: true,
  };
  await assert.rejects(() => synchronizeTavusPronunciation(base), /timed out/);
  h.state.draftPal.system_prompt = 'unrelated draft edit';
  const patches = h.calls.filter(([name]) => name === 'patch_pal').length;
  const publishes = h.calls.filter(([name]) => name === 'publish_pal').length;
  await assert.rejects(() => synchronizeTavusPronunciation(base), /unrelated_unpublished_draft_changes/);
  assert.equal(h.calls.filter(([name]) => name === 'patch_pal').length, patches);
  assert.equal(h.calls.filter(([name]) => name === 'publish_pal').length, publishes);
});

test('an unbound same-name dictionary with different content blocks creation', async () => {
  const h = harness({
    dictionary: { pronunciation_dictionary_id: 'dict-conflict', name: 'alphaScreen QA Dental Pronunciation', rules: [] },
    listDictionaries: [{ pronunciation_dictionary_id: 'dict-conflict', name: 'alphaScreen QA Dental Pronunciation' }],
  });
  await assert.rejects(() => synchronizeTavusPronunciation({
    tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' },
    environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', apply: true,
  }), /reconciliation_conflict/);
  assert.equal(h.calls.filter(([name]) => name === 'create_dictionary').length, 0);
});

test('repeated sync with matching provider state is idempotent', async () => {
  const compiled = compileResolvedDictionary(DENTAL_PRONUNCIATION_SEED, { industryKey: 'dental' });
  const h = harness({ dictionary: { pronunciation_dictionary_id: 'dict-1', name: compiled.name, rules: compiled.rules } });
  await synchronizeTavusPronunciation({ tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' }, environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', dictionaryId: 'dict-1', apply: true });
  assert.equal(h.calls.filter(([name]) => name === 'create_dictionary').length, 0);
  assert.equal(h.calls.filter(([name]) => name === 'update_dictionary').length, 0);
});

test('relevant term change updates full rules once and changes hash', async () => {
  const original = compileResolvedDictionary(DENTAL_PRONUNCIATION_SEED, { industryKey: 'dental' });
  const changed = DENTAL_PRONUNCIATION_SEED.map((item) => item.canonical_term === 'gingiva' ? { ...item, pronunciation_value: 'changed', version: 2 } : item);
  const next = compileResolvedDictionary(changed, { industryKey: 'dental' });
  const h = harness({ dictionary: { pronunciation_dictionary_id: 'dict-1', rules: original.rules } });
  const result = await synchronizeTavusPronunciation({ tavusHttpClient: h.client, terms: changed, context: { industryKey: 'dental' }, environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', dictionaryId: 'dict-1', apply: true });
  assert.notEqual(original.sourceHash, next.sourceHash);
  assert.equal(result.action, 'updated');
  assert.equal(h.calls.filter(([name]) => name === 'update_dictionary').length, 1);
});

test('unrelated PAL drift fails closed', async () => {
  const h = harness();
  let reads = 0;
  const originalGet = h.client.getPal;
  h.client.getPal = async (...args) => {
    const value = await originalGet(...args);
    if (!args[1]?.source && ++reads === 2) value.system_prompt = 'drifted';
    return value;
  };
  await assert.rejects(() => synchronizeTavusPronunciation({ tavusHttpClient: h.client, terms: DENTAL_PRONUNCIATION_SEED, context: { industryKey: 'dental' }, environment: 'qa', palId: 'qa-pal', expectedQaPalId: 'qa-pal', apply: true }), /non_pronunciation_drift/);
});
