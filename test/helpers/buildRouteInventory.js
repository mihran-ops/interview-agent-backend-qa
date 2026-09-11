'use strict';

// Loads app.js with only the network-reaching modules stubbed and returns its full
// route inventory. Shared by test/route-inventory.test.js and the regeneration
// script, so the pinned fixture and the assertion are always produced the same way.

const express = require('express');
const path = require('node:path');
const { startRecording } = require('./routeInventory');

const ROOT = path.join(__dirname, '..', '..');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function makeSupabaseStub() {
  const builder = {};
  for (const method of ['from', 'select', 'eq', 'in', 'order', 'limit', 'is', 'neq', 'not', 'or']) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.single = async () => ({ data: null, error: null });
  builder.then = (resolve) => resolve({ data: [], error: null });
  return { from: () => builder, rpc: async () => ({ data: null, error: null }), auth: { admin: {} } };
}

function buildRouteInventory() {
  const savedEnv = { ...process.env };
  const savedCache = { ...require.cache };

  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://stub.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'stub-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';
  process.env.OPENAI_API_KEY = 'stub-openai-key';
  process.env.TAVUS_API_KEY = 'stub-tavus-key';

  const appPath = path.join(ROOT, 'app.js');
  const supabaseClientPath = path.join(ROOT, 'src', 'lib', 'supabaseClient.js');
  const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
  const generateRubricPath = path.join(ROOT, 'generateRubric.js');
  const dotenvPath = require.resolve('dotenv');

  // Everything first-party must load fresh, so the recorder observes every
  // registration even when another suite has already cached these modules.
  for (const filename of Object.keys(require.cache)) {
    if (filename.startsWith(ROOT) && !filename.includes('node_modules')) delete require.cache[filename];
  }
  delete require.cache[dotenvPath];

  injectModule(dotenvPath, { config: () => ({ parsed: {} }) });
  const db = makeSupabaseStub();
  injectModule(supabaseClientPath, { supabase: db, supabaseAdmin: db, supabaseAnon: db });
  injectModule(authPath, {
    requireAuth: (_req, _res, next) => next(),
    withClientScope: (_req, _res, next) => next(),
  });
  injectModule(generateRubricPath, {
    generateRubricAndKBForRole: async () => {},
    makeKBFromRubric: async () => ({}),
    generateJdDerivedArtifactsForRole: async () => ({}),
  });

  const recorder = startRecording(express);
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  let app;
  try {
    app = require(appPath);
  } finally {
    recorder.restore();
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  const inventory = recorder.collect(app);

  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const filename of Object.keys(require.cache)) {
    if (!(filename in savedCache)) delete require.cache[filename];
  }
  Object.assign(require.cache, savedCache);

  return inventory;
}

module.exports = { buildRouteInventory };
