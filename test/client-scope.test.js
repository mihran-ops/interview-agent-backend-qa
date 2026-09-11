'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildClientScopeContext,
  canCreateRolesForClient,
  canManageMembersForClient,
  canViewLegalBillingForClient,
} = require('../src/services/clientScope');

test('manager parent membership gets retail buyer dashboard permissions and child scope', () => {
  const context = buildClientScopeContext({
    memberships: [{
      client_id: 'parent-client',
      role: 'manager',
      client: { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
    }],
    clients: [
      { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
      { id: 'child-client', name: 'Retail Location', parent_client_id: 'parent-client', entity_label: 'location' },
    ],
  });

  assert.deepEqual(context.accessibleClientIds.sort(), ['child-client', 'parent-client']);
  assert.equal(canCreateRolesForClient(context, 'parent-client'), true);
  assert.equal(canManageMembersForClient(context, 'parent-client'), true);
  assert.equal(canManageMembersForClient(context, 'child-client'), true);
  assert.equal(canViewLegalBillingForClient(context, 'parent-client'), true);
  assert.equal(canViewLegalBillingForClient(context, 'child-client'), true);
  assert.equal(context.permissionsByClientId['parent-client'].can_manage_members, true);
  assert.equal(context.permissionsByClientId['parent-client'].can_view_legal_billing, true);
  assert.equal(context.permissionsByClientId['child-client'].can_create_roles, true);
  assert.equal(context.permissionsByClientId['child-client'].can_manage_members, true);
  assert.equal(context.permissionsByClientId['child-client'].can_view_legal_billing, true);
});

test('regular member remains limited in dashboard permissions', () => {
  const context = buildClientScopeContext({
    memberships: [{
      client_id: 'parent-client',
      role: 'member',
      client: { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
    }],
    clients: [
      { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
      { id: 'child-client', name: 'Retail Location', parent_client_id: 'parent-client', entity_label: 'location' },
    ],
  });

  assert.deepEqual(context.accessibleClientIds, ['parent-client']);
  assert.equal(canCreateRolesForClient(context, 'parent-client'), false);
  assert.equal(canManageMembersForClient(context, 'parent-client'), false);
  assert.equal(canViewLegalBillingForClient(context, 'parent-client'), false);
  assert.equal(context.permissionsByClientId['parent-client'].can_manage_members, false);
  assert.equal(context.permissionsByClientId['parent-client'].can_view_legal_billing, false);
});

test('child-only manager cannot manage parent or sibling scopes', () => {
  const context = buildClientScopeContext({
    memberships: [{
      client_id: 'child-client',
      role: 'manager',
      client: { id: 'child-client', name: 'Retail Location', parent_client_id: 'parent-client' },
    }],
    clients: [
      { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
      { id: 'child-client', name: 'Retail Location', parent_client_id: 'parent-client', entity_label: 'location' },
      { id: 'sibling-client', name: 'Second Location', parent_client_id: 'parent-client', entity_label: 'location' },
    ],
  });

  assert.deepEqual(context.accessibleClientIds, ['child-client']);
  assert.equal(canManageMembersForClient(context, 'child-client'), true);
  assert.equal(canManageMembersForClient(context, 'parent-client'), false);
  assert.equal(canManageMembersForClient(context, 'sibling-client'), false);
  assert.equal(canViewLegalBillingForClient(context, 'child-client'), false);
  assert.equal(canViewLegalBillingForClient(context, 'parent-client'), false);
  assert.equal(context.permissionsByClientId['child-client'].can_view_legal_billing, false);
});

test('admin and super_admin parent memberships can view legal billing', () => {
  for (const role of ['admin', 'super_admin']) {
    const context = buildClientScopeContext({
      memberships: [{
        client_id: 'parent-client',
        role,
        client: { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
      }],
      clients: [
        { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
        { id: 'child-client', name: 'Retail Location', parent_client_id: 'parent-client', entity_label: 'location' },
      ],
    });

    assert.equal(canViewLegalBillingForClient(context, 'parent-client'), true);
    assert.equal(canViewLegalBillingForClient(context, 'child-client'), true);
  }
});
