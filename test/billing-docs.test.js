'use strict';

// The hand-off document has to stay true to the code.
//
// Three things in it are operational instructions someone will follow to turn
// this on — the webhook event, the env var and the cron path — and a wrong one
// means usage silently never gets billed. Those are pinned against the source.
// The migration list is pinned against the files on disk, so a later migration
// cannot be forgotten in the docs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'billing-models.md');
const doc = fs.readFileSync(DOC, 'utf8');

test('the document names the three models and who is on each', () => {
  for (const model of ['fixed', 'rollover', 'usage']) {
    assert.match(doc, new RegExp(`\`${model}\``), `${model} must be documented`);
  }
  for (const tier of ['Essentials', 'Pro', 'Enterprise']) {
    assert.match(doc, new RegExp(tier));
  }
});

test('the Stripe event the operator must subscribe to is the one the code handles', () => {
  const webhook = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js'), 'utf8');
  assert.match(webhook, /event\.type === 'invoice\.created'/);
  assert.match(doc, /must be subscribed to `invoice\.created`/,
    'the operator will not think to add it unless the document says so');
});

test('the env var and cron path in the document are the ones the route uses', () => {
  const route = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'internal', 'usageBilling.js'), 'utf8');
  assert.match(route, /process\.env\.USAGE_BILLING_CRON_SECRET/);
  assert.match(route, /router\.post\('\/billing\/usage-invoices'/);

  assert.match(doc, /USAGE_BILLING_CRON_SECRET/);
  assert.match(doc, /POST \/internal\/billing\/usage-invoices/);
  assert.match(doc, /x-cron-secret/);
  assert.match(doc, /once a day/i, 'the schedule must be stated, not left to the reader');
});

test('every billing migration on disk is listed, and every listed one exists', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
    .filter((name) => /^2026092[0-9]\d{6}_(billing_models|interview_credits|usage_billing_ledger|billing_idempotency_keys)\.sql$/.test(name));

  assert.equal(migrations.length, 4, 'expected the four billing migrations');
  for (const name of migrations) {
    assert.match(doc, new RegExp(name.replace(/\./g, '\\.')), `${name} must be listed in the document`);
  }

  for (const listed of doc.match(/`\d{14}_[a-z_]+\.sql`/g) || []) {
    const name = listed.replace(/`/g, '');
    assert.ok(
      fs.existsSync(path.join(ROOT, 'supabase', 'migrations', name)),
      `the document lists ${name}, which does not exist`
    );
  }
});

test('the admin endpoints in the document are the ones registered', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'route-inventory.json'), 'utf8'));
  const documented = [
    ['PATCH', '/admin/clients/:id/plan-settings'],
    ['POST', '/admin/clients/:id/usage-invoice'],
    ['GET', '/admin/clients/:id/billing-summary'],
    ['GET', '/clients/billing/credits'],
    ['GET', '/clients/billing/usage'],
    ['POST', '/internal/billing/usage-invoices']
  ];

  for (const [method, route] of documented) {
    assert.match(doc, new RegExp(`${method} ${route.replace(/[:/]/g, (c) => `\\${c}`)}`),
      `${method} ${route} must appear in the document`);
    assert.ok(inventory.includes(`${method} ${route}`),
      `${method} ${route} is documented but not registered`);
  }
});

test('the document states the rollback path and that the tables are kept', () => {
  assert.match(doc, /Rolling back/i);
  assert.match(doc, /Leave them in place/i,
    'dropping the tables would discard the record of what was billed');
});

test('the mixed money units are called out', () => {
  assert.match(doc, /`usage_interview_fee_cents` is in cents/,
    'the one field in cents among fields in dollars is the easiest thing to get wrong');
});

test('the new cron surface is inventoried in the public-surfaces findings', (t) => {
  // review/ holds client deliverables and is not tracked, so this only runs
  // where the findings document is actually present.
  const findingsPath = path.join(ROOT, 'review', 'findings-003-public-surfaces.md');
  if (!fs.existsSync(findingsPath)) return t.skip('review/findings-003-public-surfaces.md is not present');

  const findings = fs.readFileSync(findingsPath, 'utf8');
  assert.match(findings, /POST \/internal\/billing\/usage-invoices/);
  assert.match(findings, /USAGE_BILLING_CRON_SECRET/);
});
