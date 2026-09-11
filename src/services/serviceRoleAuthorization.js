'use strict';

const { normalizeClientRole } = require('./clientScope');

const MANAGER_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);

class ServiceRoleAuthorizationError extends Error {
  constructor(code, { status = 403, category = 'access_denied' } = {}) {
    super(code);
    this.name = 'ServiceRoleAuthorizationError';
    this.code = code;
    this.status = status;
    this.category = category;
  }
}

function id(value) {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

function uniqueIds(values) {
  return Array.from(new Set((values || []).map(id).filter(Boolean)));
}

function isGlobalAdmin(req) {
  return req?.isGlobalAdmin === true || req?.isAdmin === true;
}

function getScopedClientIds(req) {
  return uniqueIds([
    ...(Array.isArray(req?.clientScope?.accessibleClientIds) ? req.clientScope.accessibleClientIds : []),
    ...(Array.isArray(req?.clientScope?.effectiveClientIds) ? req.clientScope.effectiveClientIds : []),
    ...(Array.isArray(req?.clientScope?.memberships) ? req.clientScope.memberships.map((row) => row?.client_id) : []),
    ...(Array.isArray(req?.clientIds) ? req.clientIds : []),
    ...(Array.isArray(req?.effectiveClientIds) ? req.effectiveClientIds : []),
    ...(Array.isArray(req?.client_memberships) ? req.client_memberships : []),
    ...(Array.isArray(req?.memberships) ? req.memberships.map((row) => row?.client_id) : []),
    req?.client?.id,
  ]);
}

function getClientRole(req, clientId) {
  const target = id(clientId);
  if (!target) return 'member';
  const explicitRoles = req?.clientScope?.effectiveRolesByClientId?.[target];
  if (Array.isArray(explicitRoles) && explicitRoles.length) {
    const rank = { tester: 0, member: 1, manager: 2, admin: 3, owner: 4, super_admin: 5 };
    return explicitRoles
      .map(normalizeClientRole)
      .sort((left, right) => (rank[right] || 0) - (rank[left] || 0))[0];
  }
  const memberships = [
    ...(Array.isArray(req?.clientScope?.memberships) ? req.clientScope.memberships : []),
    ...(Array.isArray(req?.effectiveMemberships) ? req.effectiveMemberships : []),
    ...(Array.isArray(req?.memberships) ? req.memberships : []),
  ];
  const membership = memberships.find((row) => id(row?.client_id) === target);
  return normalizeClientRole(membership?.role);
}

function hasClientAccess(req, clientId) {
  const target = id(clientId);
  return !!target && (isGlobalAdmin(req) || getScopedClientIds(req).includes(target));
}

function hasClientManagerAccess(req, clientId) {
  const target = id(clientId);
  return !!target && (isGlobalAdmin(req)
    || (hasClientAccess(req, target) && MANAGER_ROLES.has(getClientRole(req, target))));
}

function requireClientAccess(req, clientId, options = {}) {
  const target = id(clientId);
  const allowed = options.manage === true
    ? hasClientManagerAccess(req, target)
    : hasClientAccess(req, target);
  if (!allowed) {
    throw new ServiceRoleAuthorizationError(options.code || 'resource_access_denied', {
      status: options.status || 403,
      category: options.manage ? 'manager_access_required' : 'client_scope_mismatch',
    });
  }
  return { clientId: target, role: isGlobalAdmin(req) ? 'super_admin' : getClientRole(req, target) };
}

function assertSame(actual, expected, code) {
  const left = id(actual);
  const right = id(expected);
  if (right && left !== right) {
    throw new ServiceRoleAuthorizationError(code, { status: 409, category: 'resource_binding_mismatch' });
  }
}

async function loadOne(db, table, resourceId, columns) {
  const resource = id(resourceId);
  if (!resource) {
    throw new ServiceRoleAuthorizationError(`${table}_id_required`, { status: 400, category: 'invalid_identifier' });
  }
  const { data, error } = await db.from(table).select(columns).eq('id', resource).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ServiceRoleAuthorizationError('resource_not_found', { status: 404, category: 'resource_not_found' });
  }
  return data;
}

async function requireRoleAccess({ db, req, roleId, clientId = null, manage = false, columns = '*' }) {
  const role = await loadOne(db, 'roles', roleId, columns);
  const canonicalClientId = id(role.client_id);
  assertSame(canonicalClientId, clientId, 'role_client_binding_mismatch');
  requireClientAccess(req, canonicalClientId, { manage, code: manage ? 'role_manage_denied' : 'role_access_denied' });
  return { role, clientId: canonicalClientId };
}

async function requireCandidateAccess({ db, req, candidateId, clientId = null, roleId = null, columns = '*' }) {
  const candidate = await loadOne(db, 'candidates', candidateId, columns);
  const canonicalClientId = id(candidate.client_id);
  assertSame(canonicalClientId, clientId, 'candidate_client_binding_mismatch');
  assertSame(candidate.role_id, roleId, 'candidate_role_binding_mismatch');
  requireClientAccess(req, canonicalClientId, { code: 'candidate_access_denied' });
  return { candidate, clientId: canonicalClientId, roleId: id(candidate.role_id) };
}

async function requireInterviewAccess({ db, req, interviewId, clientId = null, roleId = null, candidateId = null, columns = '*' }) {
  const interview = await loadOne(db, 'interviews', interviewId, columns);
  const canonicalClientId = id(interview.client_id);
  assertSame(canonicalClientId, clientId, 'interview_client_binding_mismatch');
  assertSame(interview.role_id, roleId, 'interview_role_binding_mismatch');
  assertSame(interview.candidate_id, candidateId, 'interview_candidate_binding_mismatch');
  requireClientAccess(req, canonicalClientId, { code: 'interview_access_denied' });
  return { interview, clientId: canonicalClientId, roleId: id(interview.role_id), candidateId: id(interview.candidate_id) };
}

function assertReportBindings({ report, candidate, role = null, interview = null, allowUnboundInterview = false }) {
  if (!report || !candidate) {
    throw new ServiceRoleAuthorizationError('report_owner_binding_missing', { status: 409, category: 'resource_binding_mismatch' });
  }
  const effectiveClientId = id(report.client_id) || id(candidate.client_id);
  const effectiveRoleId = id(report.role_id) || id(candidate.role_id);
  assertSame(candidate.id, report.candidate_id, 'report_candidate_binding_mismatch');
  assertSame(candidate.client_id, effectiveClientId, 'report_candidate_client_binding_mismatch');
  assertSame(candidate.role_id, effectiveRoleId, 'report_candidate_role_binding_mismatch');
  if (role) {
    assertSame(role.id, effectiveRoleId, 'report_role_binding_mismatch');
    assertSame(role.client_id, effectiveClientId, 'report_role_client_binding_mismatch');
  }
  if (interview) {
    assertSame(interview.candidate_id, candidate.id, 'report_interview_candidate_binding_mismatch');
    assertSame(interview.client_id, effectiveClientId, 'report_interview_client_binding_mismatch');
    assertSame(interview.role_id, effectiveRoleId, 'report_interview_role_binding_mismatch');
    if (id(report.interview_id)) assertSame(interview.id, report.interview_id, 'report_interview_binding_mismatch');
    else if (!allowUnboundInterview) {
      throw new ServiceRoleAuthorizationError('report_interview_binding_missing', { status: 409, category: 'resource_binding_mismatch' });
    }
    if (report.attempt_number != null && interview.attempt_number != null
      && Number(report.attempt_number) !== Number(interview.attempt_number)) {
      throw new ServiceRoleAuthorizationError('report_attempt_binding_mismatch', { status: 409, category: 'resource_binding_mismatch' });
    }
  }
  return { clientId: effectiveClientId, roleId: effectiveRoleId };
}

async function requireReportAccess({ db, req, reportId, clientId = null, columns = '*' }) {
  const report = await loadOne(db, 'reports', reportId, columns);
  const candidate = await loadOne(db, 'candidates', report.candidate_id, 'id,client_id,role_id');
  let interview = null;
  if (id(report.interview_id)) {
    interview = await loadOne(db, 'interviews', report.interview_id, 'id,candidate_id,client_id,role_id,attempt_number');
  }
  const binding = assertReportBindings({ report, candidate, interview, allowUnboundInterview: true });
  assertSame(binding.clientId, clientId, 'report_client_binding_mismatch');
  requireClientAccess(req, binding.clientId, { code: 'report_access_denied' });
  return { report, candidate, interview, ...binding };
}

async function requireProviderConversationBinding({ db, conversationId, interviewId = null, columns = '*' }) {
  const conversation = id(conversationId);
  if (!conversation) {
    throw new ServiceRoleAuthorizationError('provider_conversation_id_required', { status: 400, category: 'invalid_identifier' });
  }
  const { data: interview, error } = await db.from('interviews').select(columns).eq('tavus_application_id', conversation).maybeSingle();
  if (error) throw error;
  if (!interview) {
    throw new ServiceRoleAuthorizationError('provider_binding_not_found', { status: 404, category: 'resource_not_found' });
  }
  assertSame(interview.id, interviewId, 'provider_interview_binding_mismatch');
  return { interview, conversationId: conversation };
}

function safeStorageObjectPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.trim().replace(/^\/+/, '');
  if (!path || path.length > 1000 || path.includes('\0') || path.split('/').includes('..')) return null;
  return path;
}

function requireOwnedStoragePath({ resource, path, expectedPath = null }) {
  const safePath = safeStorageObjectPath(path);
  if (!resource || !safePath) {
    throw new ServiceRoleAuthorizationError('storage_artifact_not_found', { status: 404, category: 'resource_binding_mismatch' });
  }
  if (expectedPath && safeStorageObjectPath(expectedPath) !== safePath) {
    throw new ServiceRoleAuthorizationError('storage_resource_binding_mismatch', { status: 403, category: 'resource_binding_mismatch' });
  }
  return safePath;
}

module.exports = {
  MANAGER_ROLES,
  ServiceRoleAuthorizationError,
  assertReportBindings,
  getClientRole,
  getScopedClientIds,
  hasClientAccess,
  hasClientManagerAccess,
  isGlobalAdmin,
  requireCandidateAccess,
  requireClientAccess,
  requireInterviewAccess,
  requireOwnedStoragePath,
  requireProviderConversationBinding,
  requireReportAccess,
  requireRoleAccess,
  safeStorageObjectPath,
};
