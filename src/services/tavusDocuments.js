// lib/tavusDocuments.js
'use strict';

/**
 * KB flow overview:
 *  - generateRubricAndKBForRole builds a rubric and drops a JSON KB file into
 *    Supabase storage (bucket kbs), storing the UUID in roles.kb_document_id.
 *  - ensureTavusDocumentForRole reads that JSON, POSTs it to Tavus /v2/documents,
 *    and persists the Tavus document id in roles.tavus_document_id.
 *  - handlers/createTavusInterview consumes roles.tavus_document_id when
 *    launching Daily/Tavus interviews (falling back to syncing on demand).
 */

const { supabase } = require('../clients/supabase');
const { tavusHttpClient: defaultTavusHttpClient } = require('../clients/tavus');

const KB_BUCKET = process.env.SUPABASE_KB_BUCKET || 'kbs';
const KB_SIGNED_URL_TTL_SECONDS = Math.max(
  Number(process.env.TAVUS_KB_SIGNED_URL_TTL || 60 * 60 * 24 * 7),
  3600
); // default 7 days, at least 1 hour

function missingTavusKbError(roleId, detail) {
  const err = new Error(detail || 'Role is missing Tavus KB ID');
  err.code = 'missing_tavus_kb';
  err.status = 500;
  err.role_id = roleId || null;
  return err;
}

function kbNotReadyError(roleId) {
  const err = new Error('KB JSON is empty or missing required content after retry');
  err.code = 'kb_not_ready';
  err.status = 409;
  err.role_id = roleId || null;
  return err;
}

function hasMeaningfulRubricContent(rubric) {
  if (!rubric || typeof rubric !== 'object') return false;
  const keys = Object.keys(rubric);
  if (keys.length === 0) return false;
  if (Array.isArray(rubric.questions)) return rubric.questions.length > 0;
  return true;
}

function normalizeKbKey(kbId) {
  if (!kbId) return null;
  return kbId.endsWith('.json') ? kbId : `${kbId}.json`;
}

async function fetchKbJson({ supabaseClient, kbId, roleId }) {
  const key = normalizeKbKey(kbId);
  if (!key) return { error: missingTavusKbError(roleId, 'Invalid KB key') };
  const { data, error } = await supabaseClient.storage.from(KB_BUCKET).download(key);
  if (error) return { error };
  let buf;
  if (typeof data?.arrayBuffer === 'function') {
    const ab = await data.arrayBuffer();
    buf = Buffer.from(ab);
  } else if (Buffer.isBuffer(data)) {
    buf = data;
  } else {
    buf = Buffer.from(String(data || ''), 'utf8');
  }
  try {
    return { json: JSON.parse(buf.toString('utf8')) };
  } catch (e) {
    return { error: e };
  }
}

async function buildKbUrl({ kbId, supabaseClient, roleId }) {
  const key = normalizeKbKey(kbId);
  if (!key) return { error: missingTavusKbError(roleId, 'Invalid KB key') };
  const storage = supabaseClient.storage.from(KB_BUCKET);
  const { data: signed, error } = await storage.createSignedUrl(key, KB_SIGNED_URL_TTL_SECONDS);
  if (error || !signed?.signedUrl) {
    return { error: error || new Error('signed_url_missing') };
  }
  console.log(
    `[tavus-doc] Using signed KB URL for role=${roleId || 'unknown'} key=${key} ttl=${KB_SIGNED_URL_TTL_SECONDS}s`
  );
  return { url: signed.signedUrl, key, type: 'signed' };
}

async function createTavusDocument({
  role,
  kbUrl,
  supabaseClient,
  rubric,
  persist = true,
  tavusHttpClient = defaultTavusHttpClient,
}) {
  const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
  if (!API_KEY) {
    console.warn('[tavus-doc] TAVUS_API_KEY not set; skipping Tavus document creation');
    return null;
  }
  if (!kbUrl) throw missingTavusKbError(role?.id, 'KB URL missing for Tavus sync');

  const roleName = role?.title ? role.title : `Role ${role?.id || ''}`.trim();
  const document_name = roleName ? `${roleName} KB` : 'Interview KB';
  const payload = {
    document_url: kbUrl,
    document_name,
    tags: Array.from(
      new Set(
        ['interview-agent', role?.id ? String(role.id) : null].filter(Boolean)
      )
    )
  };

  console.log(
    `[tavus-doc] Creating Tavus document for role=${role?.id || 'unknown'} using kb_document_id=${role?.kb_document_id}`
  );
  const data = await tavusHttpClient.createDocument(payload);
  const docId = data?.document_id || data?.id;
  if (!docId) throw new Error('tavus_document_id_missing');
  console.log(`[tavus-doc] Created Tavus document ${docId} for role=${role?.id || 'unknown'}`);

  if (!persist) return docId;

  const updateFields = { tavus_document_id: docId };
  const { data: persistedRole, error: persistErr } = await supabaseClient
    .from('roles')
    .update(updateFields)
    .eq('id', role.id)
    .select('id,tavus_document_id')
    .single();
  if (persistErr) throw persistErr;
  if (String(persistedRole?.tavus_document_id || '') !== String(docId)) {
    throw new Error('tavus_document_persist_mismatch');
  }
  return persistedRole.tavus_document_id;
}

async function ensureTavusDocumentForRole(roleInput, opts = {}) {
  const supabaseClient = opts.supabase || supabase;
  const rubric = opts.rubric || null;
  if (!roleInput || !roleInput.id) throw new Error('role_id_required');
  const forceRefresh = Boolean(opts.forceRefresh);

  // Always refetch the latest kb/tavus columns if caller didn't pass them.
  let role = roleInput;
  if (!('kb_document_id' in roleInput) || !('tavus_document_id' in roleInput) || opts.refetch === true) {
    const { data, error } = await supabaseClient
      .from('roles')
      .select('id, title, kb_document_id, tavus_document_id')
      .eq('id', roleInput.id)
      .single();
    if (error || !data) throw new Error(error?.message || 'role_not_found');
    role = { ...roleInput, ...data };
  }

  if (!forceRefresh && role.tavus_document_id) {
    return role.tavus_document_id;
  }

  if (!role.kb_document_id) {
    console.warn(`[tavus-doc] Role ${role.id} missing kb_document_id; cannot create Tavus document`);
    return null;
  }

  const kbUrl = await buildKbUrl({
    kbId: role.kb_document_id,
    supabaseClient,
    roleId: role.id
  });
  if (kbUrl?.error) {
    const statusCode = kbUrl.error?.statusCode || kbUrl.error?.status || '';
    if (!forceRefresh && String(statusCode) === '404') {
      console.warn(`[tavus-doc] KB file ${role.kb_document_id} missing; treating stored id as Tavus document id`);
      await supabaseClient
        .from('roles')
        .update({ tavus_document_id: role.kb_document_id })
        .eq('id', role.id);
      return role.kb_document_id;
    }
    console.error(
      `[tavus-doc] failed to resolve KB URL for role=${role.id}:`,
      kbUrl.error?.message || kbUrl.error
    );
    throw missingTavusKbError(role.id, 'KB file could not be read for Tavus sync');
  }

  const effectiveRubric = await resolveRubricWithRetry({
    rubric,
    supabaseClient,
    role
  });

  try {
    return await createTavusDocument({
      role,
      kbUrl: kbUrl.url,
      supabaseClient,
      rubric: effectiveRubric,
      persist: opts.persist !== false,
      tavusHttpClient: opts.tavusHttpClient || defaultTavusHttpClient,
    });
  } catch (err) {
    const status = err?.status || 'unknown';
    console.error('[tavus-doc] tavus_request_failed', {
      role_id: role.id,
      status,
      providerCode: err?.providerCode || null,
      category: err?.category || 'provider_error',
      attemptCount: Number.isInteger(err?.attemptCount) ? err.attemptCount : 1,
      timeout: err?.timeout === true,
    });
    throw missingTavusKbError(role.id, 'Tavus rejected KB document');
  }
}

module.exports = {
  ensureTavusDocumentForRole,
  missingTavusKbError,
  kbNotReadyError
};

async function resolveRubricWithRetry({ rubric, supabaseClient, role }) {
  const needsFetch = !hasMeaningfulRubricContent(rubric);

  async function fetchRubricOnce(label) {
    const download = await fetchKbJson({
      supabaseClient,
      kbId: role.kb_document_id,
      roleId: role.id
    });
    if (download?.error) {
      console.error(
        `[tavus-doc] failed to download KB (${label}) for role=${role.id}:`,
        download.error?.message || download.error
      );
      return null;
    }
    return download.json;
  }

  if (!needsFetch) {
    return rubric;
  }

  let resolved = await fetchRubricOnce('first');
  if (hasMeaningfulRubricContent(resolved)) {
    return resolved;
  }

  console.warn(
    `[tavus-doc] kb_not_ready first_check for role=${role.id} kb_id=${role.kb_document_id}`
  );
  await new Promise(resolve => setTimeout(resolve, 30000));
  resolved = await fetchRubricOnce('retry');
  if (!hasMeaningfulRubricContent(resolved)) {
    console.warn(
      `[tavus-doc] kb_not_ready after_retry for role=${role.id} kb_id=${role.kb_document_id}`
    );
    throw kbNotReadyError(role.id);
  }
  return resolved;
}
