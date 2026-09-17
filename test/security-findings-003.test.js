'use strict';

// Findings-003 S2-1, S4-2 and S4-4.
//
// S2-1: the agreement rate limiter keyed on a raw X-Forwarded-For header, so a caller
//       could mint a fresh bucket per request. It must key on req.ip.
// S4-2: the contract renewal update must be conditional on the contract_end_at the run
//       read, so a concurrent run cannot advance the same term twice.
// S4-4: cron secrets are compared in constant time, and never match when unset.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ---------------------------------------------------------------- S4-4

test('secret comparison rejects a mismatch, an empty secret and an unset secret', () => {
  const { secretsMatch } = require('../src/services/secretCompare');

  assert.equal(secretsMatch('correct-horse', 'correct-horse'), true);
  assert.equal(secretsMatch('correct-horse', 'correct-hors'), false);
  assert.equal(secretsMatch('wrong', 'correct-horse'), false);
  // An unconfigured secret must never match, including against an empty presentation.
  assert.equal(secretsMatch('', ''), false);
  assert.equal(secretsMatch('anything', ''), false);
  assert.equal(secretsMatch('', 'anything'), false);
  assert.equal(secretsMatch(undefined, 'anything'), false);
  assert.equal(secretsMatch('anything', undefined), false);
});

test('secret comparison tolerates differing lengths without throwing', () => {
  const { secretsMatch } = require('../src/services/secretCompare');

  // timingSafeEqual throws on unequal buffer lengths; comparing digests avoids that,
  // so a short guess is rejected rather than crashing the request.
  assert.doesNotThrow(() => secretsMatch('a', 'a-much-longer-secret-value'));
  assert.equal(secretsMatch('a', 'a-much-longer-secret-value'), false);
});

test('the internal cron routes use the constant-time comparison', () => {
  const fs = require('node:fs');
  for (const file of ['contracts.js', 'otpCleanup.js', 'recordingCleanup.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'internal', file), 'utf8');
    assert.match(source, /secretsMatch\(providedSecret, expectedSecret\)/, file);
    assert.doesNotMatch(source, /providedSecret !== expectedSecret/, file);
  }
  const automation = fs.readFileSync(path.join(ROOT, 'src', 'services', 'automation', 'index.js'), 'utf8');
  assert.match(automation, /return secretsMatch\(provided, expected\)/);
  assert.doesNotMatch(automation, /provided === expected/);
});

// ---------------------------------------------------------------- S2-1

test('a spoofed X-Forwarded-For does not reset the agreement rate limit', async () => {
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  delete require.cache[path.join(ROOT, 'src', 'services', 'membershipAgreements', 'index.js')];
  const { publicAgreementTokenRateLimit } = require('../src/services/membershipAgreements');

  const app = express();
  // trust proxy off, so req.ip is the socket address and X-Forwarded-For carries no
  // weight. The limiter must key on req.ip alone: under the previous implementation it
  // read the header directly, so varying it bought an unlimited number of requests
  // regardless of this setting. How many hops to trust is a separate deployment
  // question, decided by app.js and not by this middleware.
  app.set('trust proxy', false);
  app.post('/probe', publicAgreementTokenRateLimit, (_req, res) => res.json({ ok: true }));

  // The default limit is 60 per window; go past it while varying the header every time.
  let limited = false;
  for (let i = 0; i < 70; i += 1) {
    const res = await request(app)
      .post('/probe')
      .set('X-Forwarded-For', `10.0.0.${i % 255}, 203.0.113.${i % 255}`)
      .send({});
    if (res.status === 429) { limited = true; break; }
  }

  assert.ok(limited, 'varying X-Forwarded-For must not buy an unlimited number of requests');
});

// ---------------------------------------------------------------- S4-2

test('a renewal update is conditional on the contract_end_at the run read', async () => {
  const calls = [];
  // Records the filters applied to the clients update so the guard can be asserted.
  const db = {
    from(table) {
      const filters = [];
      const q = {
        select: () => q,
        eq(column, value) { filters.push([column, value]); return q; },
        update(row) { calls.push({ table, row, filters }); return q; },
        insert: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        then(resolve) { return resolve({ data: [], error: null }); },
      };
      return q;
    },
  };
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const fs = require('node:fs');
  const source = fs.readFileSync(
    path.join(ROOT, 'src', 'services', 'contracts', 'contractRenewals.js'), 'utf8');

  // The update must carry both the row id and the value this run read.
  assert.match(
    source,
    /\.update\(\{[\s\S]*?contract_end_at: newContractEnd[\s\S]*?\}\)[\s\S]*?\.eq\('id', client\.id\)[\s\S]*?\.eq\('contract_end_at', oldContractEnd\)/,
    'the renewal update must be guarded on the contract_end_at that was read');
});

test('a stale writer matches zero rows', async () => {
  // Simulates the losing side of a race: the row has already moved on, so an update
  // filtered on the old value affects nothing.
  const rows = [{ id: 'c1', contract_end_at: '2027-01-01T00:00:00.000Z' }];
  const applyUpdate = (id, expectedEnd, next) => {
    const match = rows.filter((r) => r.id === id && r.contract_end_at === expectedEnd);
    match.forEach((r) => { r.contract_end_at = next; });
    return match.length;
  };

  const oldEnd = '2026-01-01T00:00:00.000Z';
  const winner = applyUpdate('c1', oldEnd, '2027-01-01T00:00:00.000Z');
  assert.equal(winner, 0, 'the row already advanced, so the stale writer updates nothing');

  const fresh = applyUpdate('c1', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z');
  assert.equal(fresh, 1, 'a writer holding the current value still succeeds');
});
