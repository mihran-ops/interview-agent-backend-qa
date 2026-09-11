'use strict';

// The two query patterns step 12 changes: the delete-blocker counts, which ran eight
// round-trips in sequence, and the admin list endpoints, which had no way to bound a
// response at all.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');

const ROOT = path.join(__dirname, '..');
const helpersPath = path.join(ROOT, 'src', 'services', 'admin', 'adminHelpers.js');
const supabaseClientPath = path.join(ROOT, 'src', 'clients', 'supabase.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Records when each count starts and finishes, so a sequential implementation is
// distinguishable from a parallel one without timing anything.
function makeCountingDb(behaviour = () => ({ count: 0, error: null })) {
  const events = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const db = {
    from(table) {
      return {
        select() { return this; },
        eq(column, value) {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          events.push({ table, column, value });
          const result = behaviour(table);
          // Resolve on a later turn so overlapping calls can actually overlap.
          return new Promise((resolve) => setImmediate(() => {
            inFlight -= 1;
            resolve(result);
          }));
        },
      };
    },
  };
  return { db, events, peak: () => peakInFlight };
}

let helpers;
let counting;

before(() => {
  delete require.cache[helpersPath];
  counting = makeCountingDb();
  injectModule(supabaseClientPath, { supabaseAdmin: counting.db, supabase: counting.db, supabaseAnon: counting.db });
  helpers = require(helpersPath);
});

after(() => {
  delete require.cache[helpersPath];
  delete require.cache[supabaseClientPath];
});

test('the eight delete-blocker counts run together, not one after another', async () => {
  await helpers.countClientDeleteBlockers('client-1');

  assert.equal(counting.events.length, 8, 'every table is still checked');
  assert.equal(counting.peak(), 8, 'all eight counts should be in flight at once');
});

test('delete blockers report counts per table and keep the check order', async () => {
  delete require.cache[helpersPath];
  const byTable = { roles: 3, candidates: 7 };
  const local = makeCountingDb((table) => ({ count: byTable[table] ?? 0, error: null }));
  injectModule(supabaseClientPath, { supabaseAdmin: local.db, supabase: local.db, supabaseAnon: local.db });
  const scoped = require(helpersPath);

  const result = await scoped.countClientDeleteBlockers('client-1');

  assert.deepEqual(result.blockers, { roles: 3, candidates: 7 });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.checkErrors, []);
  assert.deepEqual(local.events.map((e) => e.table), [
    'clients', 'roles', 'candidates', 'interviews',
    'reports', 'client_members', 'membership_agreements', 'client_plan_settings',
  ]);
});

test('a missing relation is a warning and a real error is an error', async () => {
  delete require.cache[helpersPath];
  const local = makeCountingDb((table) => {
    if (table === 'client_plan_settings') {
      return { count: null, error: { code: '42P01', message: 'relation does not exist' } };
    }
    if (table === 'reports') {
      return { count: null, error: { code: '08006', message: 'connection failure' } };
    }
    return { count: 0, error: null };
  });
  injectModule(supabaseClientPath, { supabaseAdmin: local.db, supabase: local.db, supabaseAnon: local.db });
  const scoped = require(helpersPath);

  const result = await scoped.countClientDeleteBlockers('client-1');

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].table, 'client_plan_settings');
  assert.equal(result.checkErrors.length, 1);
  assert.equal(result.checkErrors[0].table, 'reports');
});

test('no limit leaves an admin list unpaginated, which is the existing behaviour', () => {
  const range = helpers.parseAdminListRange({});

  assert.equal(range.applied, false);
  const builder = { range: () => { throw new Error('range must not be applied'); } };
  assert.equal(helpers.applyAdminListRange(builder, range), builder);
});

test('a limit is applied as an inclusive range and capped', () => {
  const calls = [];
  const builder = { range: (from, to) => { calls.push([from, to]); return 'ranged'; } };

  assert.equal(helpers.applyAdminListRange(builder, helpers.parseAdminListRange({ limit: '25' })), 'ranged');
  assert.deepEqual(calls[0], [0, 24]);

  helpers.applyAdminListRange(builder, helpers.parseAdminListRange({ limit: '10', offset: '40' }));
  assert.deepEqual(calls[1], [40, 49]);

  const capped = helpers.parseAdminListRange({ limit: String(helpers.MAX_ADMIN_PAGE_SIZE + 1000) });
  assert.equal(capped.limit, helpers.MAX_ADMIN_PAGE_SIZE);
});

test('a nonsensical limit or offset is reported rather than silently ignored', () => {
  assert.equal(helpers.parseAdminListRange({ limit: '0' }).invalid, 'limit');
  assert.equal(helpers.parseAdminListRange({ limit: '-3' }).invalid, 'limit');
  assert.equal(helpers.parseAdminListRange({ limit: 'many' }).invalid, 'limit');
  assert.equal(helpers.parseAdminListRange({ limit: '10', offset: '-1' }).invalid, 'offset');
  assert.equal(helpers.parseAdminListRange({ limit: '10', offset: 'x' }).invalid, 'offset');
});
