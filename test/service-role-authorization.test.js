'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  ServiceRoleAuthorizationError,
  assertReportBindings,
  getClientRole,
  getScopedClientIds,
  hasClientAccess,
  hasClientManagerAccess,
  requireCandidateAccess,
  requireClientAccess,
  requireInterviewAccess,
  requireOwnedStoragePath,
  requireProviderConversationBinding,
  requireReportAccess,
  requireRoleAccess,
  safeStorageObjectPath,
} = require('../src/services/serviceRoleAuthorization');

const ID = Object.freeze({
  parent: '77000000-0000-4000-8000-000000000001',
  childA: '77000000-0000-4000-8000-000000000002',
  childB: '77000000-0000-4000-8000-000000000003',
  clientB: '77000000-0000-4000-8000-000000000004',
  roleA: '77000000-0000-4000-8000-000000000011',
  roleB: '77000000-0000-4000-8000-000000000012',
  candidateA: '77000000-0000-4000-8000-000000000021',
  candidateB: '77000000-0000-4000-8000-000000000022',
  interviewA: '77000000-0000-4000-8000-000000000031',
  interviewB: '77000000-0000-4000-8000-000000000032',
  reportA: '77000000-0000-4000-8000-000000000041',
  reportB: '77000000-0000-4000-8000-000000000042',
});

const rows = Object.freeze({
  roles: [
    { id: ID.roleA, client_id: ID.childA, title: 'Role A' },
    { id: ID.roleB, client_id: ID.clientB, title: 'Role B' },
  ],
  candidates: [
    { id: ID.candidateA, client_id: ID.childA, role_id: ID.roleA },
    { id: ID.candidateB, client_id: ID.clientB, role_id: ID.roleB },
  ],
  interviews: [
    { id: ID.interviewA, client_id: ID.childA, role_id: ID.roleA, candidate_id: ID.candidateA, attempt_number: 1, tavus_application_id: 'conv-a' },
    { id: ID.interviewB, client_id: ID.clientB, role_id: ID.roleB, candidate_id: ID.candidateB, attempt_number: 1, tavus_application_id: 'conv-b' },
  ],
  reports: [
    { id: ID.reportA, client_id: ID.childA, role_id: ID.roleA, candidate_id: ID.candidateA, interview_id: ID.interviewA, attempt_number: 1 },
    { id: ID.reportB, client_id: ID.clientB, role_id: ID.roleB, candidate_id: ID.candidateB, interview_id: ID.interviewB, attempt_number: 1 },
  ],
});

class Query {
  constructor(table) { this.table = table; this.filters = new Map(); this.columns = '*'; }
  select(columns) { this.columns = columns; return this; }
  eq(column, value) { this.filters.set(column, String(value)); return this; }
  async maybeSingle() {
    const source = rows[this.table] || [];
    const matches = source.filter((row) => Array.from(this.filters.entries()).every(([key, value]) => String(row[key]) === value));
    if (matches.length > 1) return { data: null, error: { message: 'multiple rows' } };
    return { data: matches[0] ? { ...matches[0] } : null, error: null };
  }
}

const db = { from: (table) => new Query(table) };

function principal(role, clientId = ID.childA, extra = {}) {
  const membership = { client_id: clientId, role };
  return {
    user: { id: `user-${role}` },
    clientIds: [clientId],
    memberships: [membership],
    clientScope: {
      memberships: [membership],
      accessibleClientIds: [clientId],
      effectiveClientIds: [clientId],
      effectiveRolesByClientId: { [clientId]: [role] },
    },
    ...extra,
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof ServiceRoleAuthorizationError && error.code === code);
}

test('principal matrix enforces unaffiliated, member, manager, admin, child, sibling, and Super Admin scope', () => {
  const unaffiliated = principal('member', ID.childA, { clientIds: [], memberships: [], clientScope: { memberships: [], accessibleClientIds: [], effectiveRolesByClientId: {} } });
  const member = principal('member');
  const manager = principal('manager');
  const admin = principal('admin');
  const parentManager = principal('manager', ID.parent, {
    clientIds: [ID.parent, ID.childA, ID.childB],
    clientScope: {
      memberships: [
        { client_id: ID.parent, role: 'manager' },
        { client_id: ID.childA, role: 'manager', inherited: true },
        { client_id: ID.childB, role: 'manager', inherited: true },
      ],
      accessibleClientIds: [ID.parent, ID.childA, ID.childB],
      effectiveRolesByClientId: { [ID.parent]: ['manager'], [ID.childA]: ['manager'], [ID.childB]: ['manager'] },
    },
  });
  const superAdmin = { isGlobalAdmin: true, user: { id: 'super-admin' }, clientIds: [] };

  assert.deepEqual(getScopedClientIds(member), [ID.childA]);
  assert.equal(getClientRole(member, ID.childA), 'member');
  assert.equal(hasClientAccess(unaffiliated, ID.childA), false);
  assert.equal(hasClientAccess(member, ID.childA), true);
  assert.equal(hasClientManagerAccess(member, ID.childA), false);
  assert.equal(hasClientManagerAccess(manager, ID.childA), true);
  assert.equal(hasClientManagerAccess(admin, ID.childA), true);
  assert.equal(hasClientAccess(manager, ID.clientB), false);
  assert.equal(hasClientAccess(parentManager, ID.childA), true);
  assert.equal(hasClientAccess(parentManager, ID.childB), true);
  assert.equal(hasClientAccess(principal('manager', ID.childA), ID.parent), false);
  assert.equal(hasClientAccess(principal('manager', ID.childA), ID.childB), false);
  assert.equal(hasClientAccess(superAdmin, ID.clientB), true);
  assert.equal(requireClientAccess(superAdmin, ID.clientB, { manage: true }).role, 'super_admin');
  assert.throws(() => requireClientAccess(member, ID.childA, { manage: true }), ServiceRoleAuthorizationError);
  assert.throws(() => requireClientAccess(manager, ID.clientB), ServiceRoleAuthorizationError);
});

test('role, candidate, and interview helpers use database ownership and reject request-supplied mismatches', async () => {
  const member = principal('member');
  const manager = principal('manager');
  assert.equal((await requireRoleAccess({ db, req: member, roleId: ID.roleA })).role.id, ID.roleA);
  assert.equal((await requireRoleAccess({ db, req: manager, roleId: ID.roleA, manage: true })).clientId, ID.childA);
  await rejectsCode(requireRoleAccess({ db, req: member, roleId: ID.roleA, manage: true }), 'role_manage_denied');
  await rejectsCode(requireRoleAccess({ db, req: manager, roleId: ID.roleB }), 'role_access_denied');
  await rejectsCode(requireRoleAccess({ db, req: manager, roleId: ID.roleA, clientId: ID.clientB }), 'role_client_binding_mismatch');

  assert.equal((await requireCandidateAccess({ db, req: member, candidateId: ID.candidateA })).candidate.id, ID.candidateA);
  await rejectsCode(requireCandidateAccess({ db, req: member, candidateId: ID.candidateB }), 'candidate_access_denied');
  await rejectsCode(requireCandidateAccess({ db, req: member, candidateId: ID.candidateA, roleId: ID.roleB }), 'candidate_role_binding_mismatch');
  await rejectsCode(requireCandidateAccess({ db, req: member, candidateId: ID.candidateA, clientId: ID.clientB }), 'candidate_client_binding_mismatch');

  assert.equal((await requireInterviewAccess({ db, req: member, interviewId: ID.interviewA })).interview.id, ID.interviewA);
  await rejectsCode(requireInterviewAccess({ db, req: member, interviewId: ID.interviewB }), 'interview_access_denied');
  await rejectsCode(requireInterviewAccess({ db, req: member, interviewId: ID.interviewA, candidateId: ID.candidateB }), 'interview_candidate_binding_mismatch');
  await rejectsCode(requireInterviewAccess({ db, req: member, interviewId: ID.interviewA, roleId: ID.roleB }), 'interview_role_binding_mismatch');
});

test('report helper requires report, candidate, interview, client, role, and attempt agreement', async () => {
  const member = principal('member');
  const authorized = await requireReportAccess({ db, req: member, reportId: ID.reportA });
  assert.equal(authorized.report.id, ID.reportA);
  assert.equal(authorized.interview.id, ID.interviewA);
  await rejectsCode(requireReportAccess({ db, req: member, reportId: ID.reportB }), 'report_access_denied');

  assert.throws(() => assertReportBindings({
    report: rows.reports[0],
    candidate: rows.candidates[1],
    interview: rows.interviews[0],
  }), (error) => error.code === 'report_candidate_binding_mismatch');
  assert.throws(() => assertReportBindings({
    report: rows.reports[0],
    candidate: rows.candidates[0],
    interview: rows.interviews[1],
  }), (error) => error.code === 'report_interview_candidate_binding_mismatch');
  assert.throws(() => assertReportBindings({
    report: { ...rows.reports[0], attempt_number: 2 },
    candidate: rows.candidates[0],
    interview: rows.interviews[0],
  }), (error) => error.code === 'report_attempt_binding_mismatch');
});

test('provider conversation binding is canonical and rejects conversation/interview mismatch', async () => {
  const bound = await requireProviderConversationBinding({ db, conversationId: 'conv-a', interviewId: ID.interviewA });
  assert.equal(bound.interview.id, ID.interviewA);
  await rejectsCode(requireProviderConversationBinding({ db, conversationId: 'conv-a', interviewId: ID.interviewB }), 'provider_interview_binding_mismatch');
  await rejectsCode(requireProviderConversationBinding({ db, conversationId: 'conv-missing' }), 'provider_binding_not_found');
});

test('storage authorization rejects traversal and foreign request paths', () => {
  const resource = { id: ID.candidateA, resume_url: `${ID.childA}/${ID.candidateA}/resume.pdf` };
  assert.equal(safeStorageObjectPath(resource.resume_url), resource.resume_url);
  assert.equal(safeStorageObjectPath('../foreign.pdf'), null);
  assert.equal(safeStorageObjectPath('safe/../foreign.pdf'), null);
  assert.equal(requireOwnedStoragePath({ resource, path: resource.resume_url, expectedPath: resource.resume_url }), resource.resume_url);
  assert.throws(() => requireOwnedStoragePath({ resource, path: `${ID.clientB}/foreign.pdf`, expectedPath: resource.resume_url }), (error) => error.code === 'storage_resource_binding_mismatch');
});

test('static guard keeps runtime service-role construction centralized and classifies dormant candidates router', () => {
  const root = path.resolve(__dirname, '..');
  // handlers/, routes/ and utils/ are gone; the runtime now lives entirely under src/.
  // src/clients/supabase.js is the one place allowed to read the service-role key, and
  // the two health and metrics modules only report on whether it is configured.
  const ALLOWED = new Set([
    'src/clients/supabase.js',
    'src/health/supabaseHealth.js',
    'src/services/adminMetricsService.js',
  ]);
  const runtimeFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith('.js') && !ALLOWED.has(relative)) runtimeFiles.push(relative);
    }
  };
  for (const dir of ['src/routes', 'src/services', 'src/clients', 'src/render', 'src/health', 'src/middleware', 'src/config']) {
    walk(dir);
  }
  const violations = [];
  for (const relative of runtimeFiles) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    if (/SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY/.test(source)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.doesNotMatch(appSource, /require\(['"]\.\/src\/routes\/client\/candidates['"]\)/);
  const dormantSource = fs.readFileSync(path.join(root, 'src', 'routes', 'client', 'candidates.js'), 'utf8');
  assert.match(dormantSource, /router\.get\('\/by-role\/:roleId'/);
});
