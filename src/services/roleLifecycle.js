'use strict';

function isRoleInactive(role) {
  const status = String(role?.status || '').trim().toLowerCase();
  return status === 'inactive';
}

function buildRoleInactivePayload(request_id) {
  return {
    error: 'forbidden',
    code: 'ROLE_INACTIVE',
    detail: 'This role is no longer accepting new interviews.',
    hint: 'Please contact the employer.',
    request_id
  };
}

function logInactiveRoleBlocked(logger = console, details = {}) {
  const entry = {
    route_name: details.route_name || null,
    request_id: details.request_id || null,
    role_id: details.role_id || null
  };
  const target = logger && typeof logger.warn === 'function' ? logger : console;
  target.warn('[role-lifecycle] inactive_role_blocked', entry);
}

module.exports = {
  isRoleInactive,
  buildRoleInactivePayload,
  logInactiveRoleBlocked
};
