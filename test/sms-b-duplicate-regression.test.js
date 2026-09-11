'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { checkDuplicateCandidate } = require('../src/services/duplicateCandidate');

function fakeSupabase(rows = []) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const query = {
        select(columns) { calls.push({ table, columns, filters }); return query; },
        eq(column, value) { filters.push({ operation: 'eq', column, value }); return query; },
        ilike(column, value) { filters.push({ operation: 'ilike', column, value }); return query; },
        limit() { return query; },
        maybeSingle() {
          const match = rows.find((row) => filters.every((filter) => {
            if (filter.operation === 'ilike') return row[filter.column] === filter.value;
            return row[filter.column] === filter.value;
          })) || null;
          return Promise.resolve({ data: match, error: null });
        },
        update() { return query; },
      };
      return query;
    },
  };
}

test('legacy role-scoped email duplicate behavior remains intact', async () => {
  const db = fakeSupabase([{ id: 'candidate-a', role_id: 'role-a', email: 'same@example.test' }]);
  const result = await checkDuplicateCandidate({
    supabase: db,
    roleId: 'role-a',
    email: 'Same@Example.Test',
    fullName: 'Candidate A',
    phone: '(303) 900-8821',
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.reason, 'email');
  assert.ok(db.calls.every(({ columns }) => !columns.includes('phone_e164')));
});

test('legacy name and phone duplicate behavior remains role-scoped', async () => {
  const db = fakeSupabase([{
    id: 'candidate-a', role_id: 'role-a', email: 'other@example.test', name: 'Candidate A', phone: '3039008821',
  }]);
  const result = await checkDuplicateCandidate({
    supabase: db,
    roleId: 'role-a',
    email: 'new@example.test',
    fullName: 'Candidate A',
    phone: '+1 303 900 8821',
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.reason, 'name_phone');
  assert.equal(result.phone, '3039008821');
});

test('the same legacy phone does not create a new phone-only blocking identity', async () => {
  const db = fakeSupabase([{
    id: 'candidate-a', role_id: 'role-a', email: 'other@example.test', name: 'Different Candidate', phone: '3039008821',
  }]);
  const result = await checkDuplicateCandidate({
    supabase: db,
    roleId: 'role-a',
    email: 'new@example.test',
    fullName: 'Candidate A',
    phone: '3039008821',
  });
  assert.equal(result.duplicate, false);
});

test('candidate rows in another role do not change duplicate behavior', async () => {
  const db = fakeSupabase([{
    id: 'candidate-a', role_id: 'role-b', email: 'same@example.test', name: 'Candidate A', phone: '3039008821',
  }]);
  const result = await checkDuplicateCandidate({
    supabase: db,
    roleId: 'role-a',
    email: 'same@example.test',
    fullName: 'Candidate A',
    phone: '3039008821',
  });
  assert.equal(result.duplicate, false);
  assert.ok(db.calls.flatMap(({ filters }) => filters).some(({ column, value }) => column === 'role_id' && value === 'role-a'));
});
