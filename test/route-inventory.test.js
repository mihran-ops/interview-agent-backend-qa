'use strict';

// Pins the full HTTP surface of the assembled application: every method+path pair
// reachable through app.js, including both mounts of the routers exposed at a bare
// and an /api prefix.
//
// This is the regression net for the app.js extraction work. Moving a route between
// files must not change this list; a route that is intentionally added, removed or
// re-prefixed updates test/fixtures/route-inventory.json in the same commit, which
// `node scripts/dumpRouteInventory.js --write` does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildRouteInventory } = require('./helpers/buildRouteInventory');

const FIXTURE = path.join(__dirname, 'fixtures', 'route-inventory.json');

test('the application exposes exactly the pinned route inventory', () => {
  const actual = buildRouteInventory();
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  const added = actual.filter((route) => !expected.includes(route));
  const removed = expected.filter((route) => !actual.includes(route));

  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    'route surface changed; if this is intentional, regenerate test/fixtures/route-inventory.json'
  );
  assert.equal(actual.length, expected.length);
});
