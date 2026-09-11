'use strict';

const {
  compileTavusPronunciationRules,
  nonPronunciationPalConfig,
  resolvePronunciationTerms,
  stableHash,
} = require('./pronunciationRegistry');

const DICTIONARY_NAME = 'alphaScreen QA Dental Pronunciation';

function assertQaOnly({ environment, palId, expectedQaPalId, productionPalIds = [] }) {
  if (String(environment || '').toLowerCase() !== 'qa') throw new Error('pronunciation_sync_qa_only');
  if (!palId || !expectedQaPalId || palId !== expectedQaPalId) throw new Error('pronunciation_sync_pal_not_allowlisted');
  if (productionPalIds.includes(palId)) throw new Error('pronunciation_sync_production_pal_rejected');
}

function compileResolvedDictionary(terms, context = {}) {
  const resolvedTerms = resolvePronunciationTerms(terms, context);
  const rules = compileTavusPronunciationRules(resolvedTerms);
  if (!rules.length) throw new Error('pronunciation_dictionary_has_no_verified_terms');
  return Object.freeze({
    name: DICTIONARY_NAME,
    rules,
    resolvedTerms,
    sourceHash: stableHash(resolvedTerms.map((term) => ({
      normalized_term: term.normalized_term,
      pronunciation_method: term.pronunciation_method,
      pronunciation_value: term.pronunciation_value,
      scope_type: term.scope_type,
      industry_key: term.industry_key,
      client_id: term.client_id,
      version: term.version,
    }))),
    providerPayloadHash: stableHash(rules),
  });
}

async function findMatchingUnboundDictionary(tavusHttpClient, compiled) {
  const matches = [];
  let namedResources = 0;
  for (let page = 0; page < 20; page += 1) {
    const response = await tavusHttpClient.listPronunciationDictionaries({ limit: 100, page, sort: 'asc' });
    const dictionaries = Array.isArray(response?.data) ? response.data : [];
    for (const summary of dictionaries) {
      if (summary?.name !== compiled.name) continue;
      namedResources += 1;
      const id = providerDictionaryId(summary);
      if (!id) continue;
      const candidate = await tavusHttpClient.getPronunciationDictionary(id);
      if (stableHash(candidate?.rules || []) === compiled.providerPayloadHash) matches.push(candidate);
    }
    const total = Number(response?.total_count);
    if (dictionaries.length < 100 || !Number.isFinite(total) || ((page + 1) * 100 >= total)) break;
    if (page === 19) throw new Error('tavus_pronunciation_reconciliation_page_limit');
  }
  if (matches.length > 1) throw new Error('tavus_pronunciation_reconciliation_ambiguous');
  if (namedResources && !matches.length) throw new Error('tavus_pronunciation_reconciliation_conflict');
  return matches[0] || null;
}

function providerDictionaryId(dictionary) {
  return dictionary?.pronunciation_dictionary_id || dictionary?.id || null;
}

function classifySyncFailure({ error, priorSyncState, providerDictionaryId: boundProviderDictionaryId }) {
  const providerCategory = error?.name === 'TavusProviderError' ? error.category : null;
  const ambiguousTransport = ['network', 'timeout'].includes(providerCategory);
  const operation = String(error?.operation || '');
  const message = String(error?.message || '');
  if (!boundProviderDictionaryId && ((ambiguousTransport && operation === 'create_pronunciation_dictionary')
    || ['creating', 'create_ambiguous'].includes(priorSyncState)
    || message === 'pronunciation_dictionary_creation_requires_manual_reconciliation')) return 'create_ambiguous';
  if (boundProviderDictionaryId && ((ambiguousTransport && operation === 'update_pronunciation_dictionary')
    || ['updating', 'update_ambiguous'].includes(priorSyncState)
    || message === 'pronunciation_dictionary_update_requires_manual_reconciliation')) return 'update_ambiguous';
  if (boundProviderDictionaryId && ((ambiguousTransport && ['patch_pal', 'publish_pal'].includes(operation))
    || ['attaching', 'attachment_ambiguous'].includes(priorSyncState))) return 'attachment_ambiguous';
  return 'failed';
}

async function synchronizeTavusPronunciation(options) {
  const {
    tavusHttpClient,
    terms,
    context,
    environment,
    palId,
    expectedQaPalId,
    productionPalIds,
    dictionaryId = null,
    apply = false,
    allowCreate = true,
    allowUpdate = true,
    beforeCreate = async () => {},
    beforeUpdate = async () => {},
    beforeAttachmentMutation = async () => {},
    persistProviderIdentity = async () => {},
  } = options;
  assertQaOnly({ environment, palId, expectedQaPalId, productionPalIds });
  const compiled = compileResolvedDictionary(terms, context);
  if (!apply) return { applied: false, action: dictionaryId ? 'readback_or_update' : 'create', ...compiled };

  let dictionary;
  let action = 'unchanged';
  if (dictionaryId) {
    dictionary = await tavusHttpClient.getPronunciationDictionary(dictionaryId);
    if (stableHash(dictionary?.rules || []) !== compiled.providerPayloadHash) {
      if (!allowUpdate) throw new Error('pronunciation_dictionary_update_requires_manual_reconciliation');
      await beforeUpdate();
      dictionary = await tavusHttpClient.updatePronunciationDictionary(dictionaryId, [
        { op: 'replace', path: '/name', value: compiled.name },
        { op: 'replace', path: '/rules', value: compiled.rules },
      ]);
      action = 'updated';
    }
  } else {
    dictionary = await findMatchingUnboundDictionary(tavusHttpClient, compiled);
    if (dictionary) {
      await persistProviderIdentity(providerDictionaryId(dictionary));
      action = 'reconciled';
    } else {
      if (!allowCreate) throw new Error('pronunciation_dictionary_creation_requires_manual_reconciliation');
      await beforeCreate();
      dictionary = await tavusHttpClient.createPronunciationDictionary({ name: compiled.name, rules: compiled.rules });
      const createdId = providerDictionaryId(dictionary);
      if (!createdId) throw new Error('tavus_pronunciation_dictionary_id_missing');
      await persistProviderIdentity(createdId);
      action = 'created';
    }
  }

  const resolvedDictionaryId = providerDictionaryId(dictionary) || dictionaryId;
  const readback = await tavusHttpClient.getPronunciationDictionary(resolvedDictionaryId);
  if (stableHash(readback?.rules || []) !== compiled.providerPayloadHash) throw new Error('tavus_pronunciation_readback_mismatch');

  const beforePal = await tavusHttpClient.getPal(palId);
  const beforeHash = stableHash(nonPronunciationPalConfig(beforePal));
  let attachmentAction = 'unchanged';
  if (beforePal?.layers?.tts?.pronunciation_dictionary_id !== resolvedDictionaryId) {
    const draft = await tavusHttpClient.getPal(palId, { source: 'draft' });
    if (draft?.has_unpublished_changes) {
      const draftOnlyContainsDesiredAttachment = draft?.layers?.tts?.pronunciation_dictionary_id === resolvedDictionaryId
        && stableHash(nonPronunciationPalConfig(draft)) === beforeHash;
      if (!draftOnlyContainsDesiredAttachment) throw new Error('qa_pal_has_unrelated_unpublished_draft_changes');
      await beforeAttachmentMutation('publish_existing_draft');
      await tavusHttpClient.publishPal(palId);
      attachmentAction = 'published_existing_draft';
    } else {
      const patch = [{
        op: beforePal?.layers?.tts && Object.prototype.hasOwnProperty.call(beforePal.layers.tts, 'pronunciation_dictionary_id') ? 'replace' : 'add',
        path: '/layers/tts/pronunciation_dictionary_id',
        value: resolvedDictionaryId,
      }];
      await beforeAttachmentMutation('patch');
      const patched = await tavusHttpClient.patchPal(palId, patch);
      if (patched?.edit_target === 'draft') {
        await beforeAttachmentMutation('publish_new_draft');
        await tavusHttpClient.publishPal(palId);
      }
      attachmentAction = 'attached';
    }
  }
  const afterPal = await tavusHttpClient.getPal(palId);
  const afterHash = stableHash(nonPronunciationPalConfig(afterPal));
  if (beforeHash !== afterHash) throw new Error('qa_pal_non_pronunciation_drift');
  if (afterPal?.layers?.tts?.pronunciation_dictionary_id !== resolvedDictionaryId) throw new Error('qa_pal_pronunciation_attachment_missing');
  return {
    applied: true,
    action,
    attachmentAction,
    dictionaryId: resolvedDictionaryId,
    termCount: compiled.rules.length,
    sourceHash: compiled.sourceHash,
    providerPayloadHash: compiled.providerPayloadHash,
    beforeNonPronunciationHash: beforeHash,
    afterNonPronunciationHash: afterHash,
  };
}

module.exports = {
  DICTIONARY_NAME,
  assertQaOnly,
  compileResolvedDictionary,
  classifySyncFailure,
  findMatchingUnboundDictionary,
  synchronizeTavusPronunciation,
};
