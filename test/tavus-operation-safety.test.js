'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  OPERATION_CONFIG,
  RETRY_SAFETY,
  TIMEOUTS,
  TavusProviderError,
  createTavusHttpClient,
} = require('../src/clients/tavus');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'synthetic-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'synthetic-anon-key';

const ROOT = path.resolve(__dirname, '..');
const ACTIVE_CALLERS = [
  'src/services/tavusInterview.js',
  'src/services/tavusDocuments.js',
  'src/services/tavusVendorReconciliation.js',
  'src/health/tavusHealth.js',
  'src/routes/public/tavus.js',
  'src/services/tavusEvents/index.js',
  'scripts/patchTavusQaP1Persona.js',
  'scripts/syncTavusPersona.js',
  'scripts/syncTavusPronunciationDictionary.js',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function fakeResponse(statusCode, value, headers = {}) {
  return {
    statusCode,
    headers,
    body: { text: async () => value === undefined ? '' : JSON.stringify(value) },
  };
}

test('all active Tavus API callers use the canonical shared client', () => {
  for (const relativePath of ACTIVE_CALLERS) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /https?:\/\/(?:api\.tavus\.io|tavusapi\.com)/i, relativePath);
    assert.doesNotMatch(source, /['"]x-api-key['"]\s*:/i, relativePath);
  }
  for (const relativePath of [
    'src/services/tavusInterview.js',
    'src/services/tavusDocuments.js',
    'src/health/tavusHealth.js',
    'src/routes/public/tavus.js',
    'src/services/tavusEvents/index.js',
    'scripts/patchTavusQaP1Persona.js',
    'scripts/syncTavusPersona.js',
    'scripts/syncTavusPronunciationDictionary.js',
  ]) {
    assert.match(read(relativePath), /tavusHttpClient|createTavusHttpClient/, relativePath);
  }
});

test('pronunciation sync requires an explicit QA PAL allowlist distinct from provider identity input', () => {
  const source = read('scripts/syncTavusPronunciationDictionary.js');
  assert.match(source, /required\('PRONUNCIATION_QA_PAL_ID', EXPECTED_QA_PAL_ID\)/);
  assert.doesNotMatch(source, /PRONUNCIATION_QA_PAL_ID \|\| PAL_ID/);
});

// The documented inactive exceptions were the unreferenced legacy modules, which
// step 10 deleted. No module may now hold an obsolete direct Tavus URL.
test('no module retains obsolete Tavus direct URLs', () => {
  for (const relativePath of ACTIVE_CALLERS) {
    assert.doesNotMatch(read(relativePath), /https:\/\/api\.tavus\.io\/conversations/, relativePath);
  }
});

test('webhook transcript and perception paths still store callback bodies without fetching provider URLs', () => {
  const source = read('src/services/tavusEvents/index.js');
  assert.match(source, /putJsonToStorage\(TRANSCRIPTS_BUCKET, pathName, body\)/);
  assert.match(source, /putJsonToStorage\(TRANSCRIPTS_BUCKET, perceptionPath, body\)/);
  assert.doesNotMatch(source, /putJsonToStorage\([^\n]+transcript_url/);
  assert.doesNotMatch(source, /putJsonToStorage\([^\n]+perception_url/);
});

test('operation map assigns every mutation one attempt and no retry safety', () => {
  for (const operation of [
    'create_conversation',
    'create_document',
    'create_persona',
    'patch_persona',
    'patch_pal',
    'publish_pal',
    'create_pronunciation_dictionary',
    'update_pronunciation_dictionary',
    'end_conversation',
  ]) {
    assert.equal(OPERATION_CONFIG[operation].retrySafety, RETRY_SAFETY.NOT_SAFE_TO_RETRY, operation);
    assert.equal(OPERATION_CONFIG[operation].maxAttempts, 1, operation);
  }
});

test('operation map assigns bounded retries only to GET/read operations', () => {
  for (const operation of [
    'get_conversation',
    'list_conversations',
    'get_persona',
    'get_pal',
    'list_pronunciation_dictionaries',
    'get_pronunciation_dictionary',
  ]) {
    assert.equal(OPERATION_CONFIG[operation].method, 'GET', operation);
    assert.equal(OPERATION_CONFIG[operation].retrySafety, RETRY_SAFETY.SAFE_TO_RETRY, operation);
    assert.equal(OPERATION_CONFIG[operation].maxAttempts, 3, operation);
  }
  assert.equal(OPERATION_CONFIG.list_conversations_health.maxAttempts, 2);
});

test('timeout mapping preserves document budget and bounds all provider operations', () => {
  assert.equal(OPERATION_CONFIG.create_document.timeout, 'long_provider_mutation');
  assert.ok(TIMEOUTS.long_provider_mutation.requestMs >= 15000);
  for (const config of Object.values(OPERATION_CONFIG)) {
    const timeout = TIMEOUTS[config.timeout];
    for (const field of ['requestMs', 'connectMs', 'headersMs', 'bodyMs']) {
      assert.ok(Number.isFinite(timeout[field]) && timeout[field] > 0, `${config.timeout}.${field}`);
    }
  }
});

test('ambiguous create timeout makes exactly one provider attempt', async () => {
  let attempts = 0;
  const client = createTavusHttpClient({
    apiKey: 'synthetic',
    telemetry: () => {},
    transport: async () => {
      attempts += 1;
      const error = new Error('timed out after dispatch');
      error.code = 'UND_ERR_HEADERS_TIMEOUT';
      throw error;
    },
  });
  await assert.rejects(
    () => client.createConversation({ conversation_name: 'synthetic' }),
    (error) => error instanceof TavusProviderError
      && error.timeout === true
      && error.attemptCount === 1,
  );
  assert.equal(attempts, 1);
});

test('transient create connection failure is not blindly retried', async () => {
  let attempts = 0;
  const client = createTavusHttpClient({
    apiKey: 'synthetic',
    telemetry: () => {},
    transport: async () => {
      attempts += 1;
      throw Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' });
    },
  });
  await assert.rejects(() => client.createConversation({}), TavusProviderError);
  assert.equal(attempts, 1);
});

test('safe GET timeout retries within its exact attempt bound', async () => {
  let attempts = 0;
  const sleeps = [];
  const client = createTavusHttpClient({
    apiKey: 'synthetic',
    random: () => 0.5,
    sleep: async (value) => sleeps.push(value),
    telemetry: () => {},
    transport: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('header timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
      return fakeResponse(200, { conversation_id: 'synthetic' });
    },
  });
  assert.deepEqual(await client.getConversation('synthetic'), { conversation_id: 'synthetic' });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test('GET 404 keeps current no-retry semantic and normalizes the final error', async () => {
  let attempts = 0;
  const client = createTavusHttpClient({
    apiKey: 'synthetic',
    telemetry: () => {},
    transport: async () => {
      attempts += 1;
      return fakeResponse(404, { code: 'not_found' });
    },
  });
  await assert.rejects(
    () => client.getConversation('synthetic'),
    (error) => error instanceof TavusProviderError
      && error.status === 404
      && error.category === 'not_found'
      && error.attemptCount === 1,
  );
  assert.equal(attempts, 1);
});

test('end timeout cannot create concurrent or sequential duplicate termination attempts', async () => {
  let active = 0;
  let peak = 0;
  let attempts = 0;
  const client = createTavusHttpClient({
    apiKey: 'synthetic',
    telemetry: () => {},
    transport: async () => {
      attempts += 1;
      active += 1;
      peak = Math.max(peak, active);
      active -= 1;
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    },
  });
  await assert.rejects(() => client.endConversation('synthetic'), TavusProviderError);
  assert.equal(attempts, 1);
  assert.equal(peak, 1);
});

test('normal create response remains unchanged and includes no transport wrapper', async () => {
  const expected = {
    conversation_id: 'synthetic',
    conversation_url: 'https://example.invalid/synthetic',
  };
  const client = createTavusHttpClient({
    apiKey: 'synthetic',
    telemetry: () => {},
    transport: async () => fakeResponse(201, expected),
  });
  assert.deepEqual(await client.createConversation({ conversation_name: 'synthetic' }), expected);
});

test('client source telemetry never records request URLs, auth headers, or request bodies', () => {
  const source = read('src/clients/tavus.js');
  assert.doesNotMatch(source, /emit\([^\n]+\b(?:url|headers|body|apiKey)\b/);
  assert.doesNotMatch(source, /telemetry\([^\n]+\b(?:url|headers|body|apiKey)\b/);
});
