// scripts/verify-routes.js
/* Verifies each route mounts the same way app.js does: supports router instance or factory. */

require('dotenv').config();

const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function isRouter(x) { return x && typeof x.use === 'function' && typeof x.handle === 'function'; }
function coerce(mod, deps) {
  if (!mod) return null;
  if (isRouter(mod)) return mod;                // already a router instance
  if (typeof mod === 'function') {
    try { return mod(deps); } catch { return null; } // factory -> call with deps
  }
  if (mod && isRouter(mod.router)) return mod.router;
  return null;
}

// Build the same deps our app.js provides
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your env before running this script.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// Pull auth from your real middleware
let requireAuth, withClientScope;
try {
  // use the real file path you’re using in app.js
  const authMod = require(path.resolve(__dirname, '..', 'src', 'middleware', 'auth'));
  requireAuth = authMod.requireAuth || authMod.auth || authMod.default?.requireAuth;
  withClientScope = authMod.withClientScope || authMod.default?.withClientScope;
} catch (e) {
  console.error('[auth] failed to load src/middleware/auth:', e.message);
}

const deps = { supabase, auth: requireAuth, withClientScope, buckets: {
  reports: process.env.SUPABASE_REPORTS_BUCKET || 'reports',
  kbs: process.env.SUPABASE_KB_BUCKET || 'kbs',
}};

// Paths are relative to src/routes/ now that the routers are grouped by audience.
const names = [
  'client/roles', 'client/candidates', 'public/candidateSubmit', 'client/reports',
  'client/dashboardRouter', 'client/files', 'client/rolesUpload', 'webhooks/tavus',
  'webhooks/stripe', 'public/createTavusInterview', 'public/verifyOtp', 'client/kb'
];

let ok = true;
for (const n of names) {
  try {
    const mod = require(path.resolve(__dirname, '..', 'src', 'routes', n));
    const router = coerce(mod, deps);
    if (!router) { console.error(`[X] ${n}: not exporting/mounting a router (instance or factory)`); ok = false; }
    else { console.log(`[✓] ${n}: OK`); }
  } catch (e) {
    console.error(`[ERR] ${n}: ${e.message}`);
    ok = false;
  }
}
if (!ok) process.exit(1);
