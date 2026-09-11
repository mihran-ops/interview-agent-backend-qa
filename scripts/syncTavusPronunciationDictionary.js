'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { tavusHttpClient } = require('../src/clients/tavus');
const { TavusProviderError } = require('../src/clients/tavus');
const { assertQaOnly, classifySyncFailure, synchronizeTavusPronunciation } = require('../src/services/tavusPronunciationSync');

const APPLY = process.argv.includes('--apply');
const ENVIRONMENT = String(process.env.APP_ENV || process.env.NODE_ENV || '').trim().toLowerCase();
const PAL_ID = String(process.env.TAVUS_PERSONA_ID || '').trim();
const EXPECTED_QA_PAL_ID = String(process.env.PRONUNCIATION_QA_PAL_ID || '').trim();
const DICTIONARY_KEY = `qa:dental:${EXPECTED_QA_PAL_ID}`;

function required(name, value) {
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function createStore() {
  const url = required('SUPABASE_URL', String(process.env.SUPABASE_URL || '').trim());
  const key = required('SUPABASE_SERVICE_ROLE_KEY', String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function loadTerms(db) {
  const { data, error } = await db.from('pronunciation_terms').select('*').in('scope_type', ['global', 'industry', 'client']);
  if (error) throw new Error(`pronunciation_terms_read_failed:${error.code || 'unknown'}`);
  return data || [];
}

async function loadSync(db) {
  const { data, error } = await db.from('pronunciation_dictionary_syncs').select('*').eq('dictionary_key', DICTIONARY_KEY).maybeSingle();
  if (error) throw new Error(`pronunciation_sync_read_failed:${error.code || 'unknown'}`);
  return data || null;
}

async function updateSync(db, values) {
  const payload = {
    dictionary_key: DICTIONARY_KEY,
    environment: 'qa',
    provider: 'tavus',
    updated_at: new Date().toISOString(),
    ...values,
  };
  const { data, error } = await db.from('pronunciation_dictionary_syncs').upsert(payload, { onConflict: 'dictionary_key' }).select('*').single();
  if (error) throw new Error(`pronunciation_sync_write_failed:${error.code || 'unknown'}`);
  return data;
}

async function main() {
  required('TAVUS_API_KEY', String(process.env.TAVUS_API_KEY || '').trim());
  required('TAVUS_PERSONA_ID', PAL_ID);
  required('PRONUNCIATION_QA_PAL_ID', EXPECTED_QA_PAL_ID);
  const productionPalIds = String(process.env.PRONUNCIATION_PRODUCTION_PAL_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
  assertQaOnly({ environment: ENVIRONMENT, palId: PAL_ID, expectedQaPalId: EXPECTED_QA_PAL_ID, productionPalIds });
  const db = createStore();
  const terms = await loadTerms(db);
  let sync = await loadSync(db);
  const priorSyncState = sync?.sync_state || null;
  if (APPLY && !sync) sync = await updateSync(db, { sync_state: 'planned' });

  try {
    const result = await synchronizeTavusPronunciation({
      tavusHttpClient,
      terms,
      context: { industryKey: 'dental', clientId: null },
      environment: ENVIRONMENT,
      palId: PAL_ID,
      expectedQaPalId: EXPECTED_QA_PAL_ID,
      productionPalIds,
      dictionaryId: sync?.provider_dictionary_id || null,
      apply: APPLY,
      allowCreate: !['creating', 'create_ambiguous'].includes(priorSyncState),
      allowUpdate: !['updating', 'update_ambiguous'].includes(priorSyncState),
      beforeCreate: async () => { sync = await updateSync(db, { sync_state: 'creating', last_error_category: null }); },
      beforeUpdate: async () => { sync = await updateSync(db, { sync_state: 'updating', last_error_category: null }); },
      beforeAttachmentMutation: async () => { sync = await updateSync(db, { sync_state: 'attaching', last_error_category: null }); },
      persistProviderIdentity: async (providerDictionaryId) => {
        sync = await updateSync(db, { provider_dictionary_id: providerDictionaryId, sync_state: 'planned' });
      },
    });
    if (APPLY) {
      await updateSync(db, {
        provider_dictionary_id: result.dictionaryId,
        source_hash: result.sourceHash,
        provider_payload_hash: result.providerPayloadHash,
        term_count: result.termCount,
        attached_pal_id: PAL_ID,
        sync_state: 'synchronized',
        last_error_category: null,
        synchronized_at: new Date().toISOString(),
      });
    }
    console.log(JSON.stringify({
      mode: APPLY ? 'apply' : 'dry_run',
      environment: ENVIRONMENT,
      pal_id: PAL_ID,
      dictionary_id: result.dictionaryId || sync?.provider_dictionary_id || null,
      action: result.action,
      attachment_action: result.attachmentAction || null,
      term_count: result.termCount || result.rules?.length || 0,
      source_hash: result.sourceHash,
      provider_payload_hash: result.providerPayloadHash,
      non_pronunciation_hash_unchanged: result.beforeNonPronunciationHash
        ? result.beforeNonPronunciationHash === result.afterNonPronunciationHash
        : null,
    }));
  } catch (error) {
    if (APPLY) {
      const category = error instanceof TavusProviderError ? error.category : 'failed';
      const state = classifySyncFailure({
        error,
        priorSyncState,
        providerDictionaryId: sync?.provider_dictionary_id || null,
      });
      await updateSync(db, { sync_state: state, last_error_category: category });
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: String(error?.message || 'pronunciation_sync_failed').slice(0, 180) }));
  process.exitCode = 1;
});
