'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const {
  ServiceRoleAuthorizationError,
  requireCandidateAccess,
  requireInterviewAccess,
  requireProviderConversationBinding,
  requireReportAccess,
  requireRoleAccess,
} = require('../src/services/serviceRoleAuthorization');

const ENABLED = process.env.SERVICE_ROLE_AUTHORIZATION_DISPOSABLE === 'true';
const SOCKET = process.env.SERVICE_ROLE_AUTHORIZATION_PG_SOCKET || '/tmp';
const PORT = process.env.SERVICE_ROLE_AUTHORIZATION_PG_PORT || '5432';
const USER = process.env.SERVICE_ROLE_AUTHORIZATION_PG_USER || 'postgres';
const DATABASE = `alphascreen_service_auth_${process.pid}`;

const ID = Object.freeze({
  parent: '78000000-0000-4000-8000-000000000001',
  childA: '78000000-0000-4000-8000-000000000002',
  childB: '78000000-0000-4000-8000-000000000003',
  clientB: '78000000-0000-4000-8000-000000000004',
  roleA: '78000000-0000-4000-8000-000000000011',
  roleB: '78000000-0000-4000-8000-000000000012',
  candidateA: '78000000-0000-4000-8000-000000000021',
  candidateB: '78000000-0000-4000-8000-000000000022',
  interviewA: '78000000-0000-4000-8000-000000000031',
  interviewB: '78000000-0000-4000-8000-000000000032',
  reportA: '78000000-0000-4000-8000-000000000041',
  reportMismatch: '78000000-0000-4000-8000-000000000042',
});

function command(name, args, options = {}) {
  return spawnSync(name, args, { encoding: 'utf8', ...options });
}

function psql(statement, database = DATABASE) {
  const result = command('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-p', PORT, '-U', USER, '-d', database, '-At', '-c', statement]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function principal(role, clientIds, rolesByClient) {
  return {
    user: { id: `fixture-${role}` },
    clientIds,
    clientScope: {
      accessibleClientIds: clientIds,
      effectiveClientIds: clientIds,
      memberships: clientIds.map((clientId) => ({ client_id: clientId, role: rolesByClient[clientId] || role })),
      effectiveRolesByClientId: Object.fromEntries(clientIds.map((clientId) => [clientId, [rolesByClient[clientId] || role]])),
    },
  };
}

class PgQuery {
  constructor(table) { this.table = table; this.columns = '*'; this.filters = []; }
  select(columns) { this.columns = columns; return this; }
  eq(column, value) { this.filters.push([column, String(value)]); return this; }
  async maybeSingle() {
    const allowedTables = new Set(['roles', 'candidates', 'interviews', 'reports']);
    assert.ok(allowedTables.has(this.table));
    const allowedColumns = /^[a-z0-9_,*]+$/i;
    assert.match(this.columns.replaceAll(' ', ''), allowedColumns);
    const where = this.filters.map(([column, value]) => {
      assert.match(column, /^[a-z_]+$/i);
      return `${column}='${value.replaceAll("'", "''")}'`;
    }).join(' and ') || 'true';
    const output = psql(`select row_to_json(row_value)::text from (select ${this.columns} from ${this.table} where ${where} limit 2) row_value;`);
    if (!output) return { data: null, error: null };
    const lines = output.split('\n').filter(Boolean);
    if (lines.length !== 1) return { data: null, error: { message: 'multiple rows' } };
    return { data: JSON.parse(lines[0]), error: null };
  }
}

const db = { from: (table) => new PgQuery(table) };

before(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
  const created = command('createdb', ['-h', SOCKET, '-p', PORT, '-U', USER, DATABASE]);
  assert.equal(created.status, 0, created.stderr);
  psql(`
    create table clients(id uuid primary key, parent_client_id uuid null, archived_at timestamptz null);
    create table roles(id uuid primary key, client_id uuid not null, title text);
    create table candidates(id uuid primary key, client_id uuid not null, role_id uuid not null);
    create table interviews(id uuid primary key, client_id uuid not null, role_id uuid not null, candidate_id uuid not null, attempt_number integer, tavus_application_id text unique);
    create table reports(id uuid primary key, client_id uuid, role_id uuid, candidate_id uuid not null, interview_id uuid, attempt_number integer);
    insert into clients values
      ('${ID.parent}',null,null),
      ('${ID.childA}','${ID.parent}',null),
      ('${ID.childB}','${ID.parent}',null),
      ('${ID.clientB}',null,null);
    insert into roles values ('${ID.roleA}','${ID.childA}','Role A'),('${ID.roleB}','${ID.clientB}','Role B');
    insert into candidates values ('${ID.candidateA}','${ID.childA}','${ID.roleA}'),('${ID.candidateB}','${ID.clientB}','${ID.roleB}');
    insert into interviews values
      ('${ID.interviewA}','${ID.childA}','${ID.roleA}','${ID.candidateA}',1,'conv-a'),
      ('${ID.interviewB}','${ID.clientB}','${ID.roleB}','${ID.candidateB}',1,'conv-b');
    insert into reports values
      ('${ID.reportA}','${ID.childA}','${ID.roleA}','${ID.candidateA}','${ID.interviewA}',1),
      ('${ID.reportMismatch}','${ID.childA}','${ID.roleA}','${ID.candidateB}','${ID.interviewA}',1);
  `);
});

after(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
});

test('real relational fixture authorizes canonical child resources and rejects unrelated client resources', { skip: !ENABLED }, async () => {
  const manager = principal('manager', [ID.childA], { [ID.childA]: 'manager' });
  assert.equal((await requireRoleAccess({ db, req: manager, roleId: ID.roleA, manage: true })).role.id, ID.roleA);
  assert.equal((await requireCandidateAccess({ db, req: manager, candidateId: ID.candidateA })).candidate.id, ID.candidateA);
  assert.equal((await requireInterviewAccess({ db, req: manager, interviewId: ID.interviewA })).interview.id, ID.interviewA);
  assert.equal((await requireReportAccess({ db, req: manager, reportId: ID.reportA })).report.id, ID.reportA);
  await assert.rejects(requireRoleAccess({ db, req: manager, roleId: ID.roleB }), ServiceRoleAuthorizationError);
  await assert.rejects(requireCandidateAccess({ db, req: manager, candidateId: ID.candidateB }), ServiceRoleAuthorizationError);
  await assert.rejects(requireInterviewAccess({ db, req: manager, interviewId: ID.interviewB }), ServiceRoleAuthorizationError);
});

test('real relational fixture rejects sibling scope and corrupted report relationships', { skip: !ENABLED }, async () => {
  const childManager = principal('manager', [ID.childA], { [ID.childA]: 'manager' });
  await assert.rejects(requireRoleAccess({ db, req: childManager, roleId: ID.roleB }), ServiceRoleAuthorizationError);
  await assert.rejects(
    requireReportAccess({ db, req: childManager, reportId: ID.reportMismatch }),
    (error) => error instanceof ServiceRoleAuthorizationError && error.category === 'resource_binding_mismatch',
  );
});

test('real relational fixture enforces canonical provider conversation binding', { skip: !ENABLED }, async () => {
  assert.equal((await requireProviderConversationBinding({ db, conversationId: 'conv-a', interviewId: ID.interviewA })).interview.id, ID.interviewA);
  await assert.rejects(
    requireProviderConversationBinding({ db, conversationId: 'conv-a', interviewId: ID.interviewB }),
    (error) => error instanceof ServiceRoleAuthorizationError && error.code === 'provider_interview_binding_mismatch',
  );
});
