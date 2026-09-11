const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

function readProjectFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');
}

test('claim first-role credit RPC execute is limited to service_role', () => {
  const sql = readProjectFile(
    'supabase',
    'migrations',
    '20260627151221_lock_claim_first_role_prepay_credit_rpc.sql'
  );

  assert.match(sql, /revoke execute on function public\.claim_first_role_prepay_credit\(uuid, uuid, text\) from public;/i);
  assert.match(sql, /revoke execute on function public\.claim_first_role_prepay_credit\(uuid, uuid, text\) from anon;/i);
  assert.match(sql, /revoke execute on function public\.claim_first_role_prepay_credit\(uuid, uuid, text\) from authenticated;/i);
  assert.match(sql, /grant execute on function public\.claim_first_role_prepay_credit\(uuid, uuid, text\) to service_role;/i);
  assert.doesNotMatch(sql, /grant execute on function public\.claim_first_role_prepay_credit\(uuid, uuid, text\) to (public|anon|authenticated);/i);
});

test('admin reset diagnostics do not log raw password setup action links', () => {
  const source = readProjectFile('src', 'routes', 'admin', 'members.js');
  const routeStart = source.indexOf("router.post('/send-password-reset'");
  const routeEnd = source.indexOf("return res.json({ ok: true, request_id })", routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);

  const routeSource = source.slice(routeStart, routeEnd);
  assert.match(routeSource, /action_link_present/);
  assert.match(routeSource, /action_link_host/);
  assert.match(routeSource, /action_link_path/);
  assert.doesNotMatch(routeSource, /actionLink\s*:\s*actionLink/);
  assert.doesNotMatch(routeSource, /setupUrl\s*:\s*setupUrl/);
  assert.doesNotMatch(routeSource, /action_link_url/);
});

test('public agreement token endpoints are rate limited', () => {
  const source = readProjectFile('routes', 'membershipAgreementsPublic.js');

  assert.match(source, /function publicAgreementTokenRateLimit/);
  assert.match(source, /router\.post\('\/session', publicAgreementTokenRateLimit,/);
  assert.match(source, /router\.post\('\/sign', publicAgreementTokenRateLimit,/);
  assert.match(source, /router\.post\('\/checkout-session', publicAgreementTokenRateLimit,/);
  assert.match(source, /Too many requests/);
});

test('signed agreement routes require legal-billing access on the billing owner scope', () => {
  const source = readProjectFile('routes', 'membershipAgreementsPublic.js');

  assert.match(source, /resolveBillingOwnerForScope/);
  assert.match(source, /canViewLegalBillingForClient/);
  assert.match(source, /resolveLegalBillingAgreementClient/);
  assert.match(source, /router\.get\('\/latest-signed'/);
  assert.match(source, /router\.get\('\/latest-signed-url'/);
  assert.match(source, /\.eq\('client_id', agreementClientId\)/);
});

test('client billing summary requires legal-billing access and resolves billing owner', () => {
  const source = readProjectFile('app.js');
  const routeStart = source.indexOf("app.get('/clients/billing/summary'");
  const routeEnd = source.indexOf('const CLIENT_DASHBOARD_TABS', routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);

  const routeSource = source.slice(routeStart, routeEnd);
  assert.match(routeSource, /canViewLegalBillingForClient/);
  assert.match(routeSource, /resolveBillingOwnerForScope/);
  assert.match(routeSource, /return res\.status\(403\)\.json\(\{ error: 'forbidden' \}\)/);
  assert.match(routeSource, /\.in\('id', Array\.from\(new Set\(queryIds\)\)\)/);
});
