const assert = require('node:assert/strict');
const test = require('node:test');
const { hasAnyActiveClientMembership } = require('../src/services/supportVoiceMembership');

function serviceDbFixture(results) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'client_members');
      const call = { table };
      calls.push(call);
      return {
        select(columns, options) {
          call.columns = columns;
          call.options = options;
          return {
            eq(column, value) {
              call.column = column;
              call.userId = value;
              return {
                is(filter, filterValue) {
                  call.filter = filter;
                  call.filterValue = filterValue;
                  return Promise.resolve(results[column]);
                },
              };
            },
          };
        },
      };
    },
  };
}

for (const [name, modern, legacy, expected] of [
  ['modern member', { data: null, count: 1, error: null }, { data: null, count: 0, error: null }, true],
  ['legacy member', { data: null, count: 0, error: null }, { data: null, count: 2, error: null }, true],
  ['both member', { data: null, count: 1, error: null }, { data: null, count: 1, error: null }, true],
  ['no membership', { data: null, count: 0, error: null }, { data: null, count: 0, error: null }, false],
  ['modern column absent', { data: null, count: null, error: { code: '42703' } }, { data: null, count: 1, error: null }, true],
  ['legacy column absent', { data: null, count: 1, error: null }, { data: null, count: null, error: { code: '42703' } }, true],
  ['both columns absent', { data: null, count: null, error: { code: '42703' } }, { data: null, count: null, error: { code: '42703' } }, false],
  ['database error', { data: null, count: null, error: { code: 'XX000' } }, { data: null, count: 1, error: null }, false],
  ['malformed count', { data: null, count: -1, error: null }, { data: null, count: 1, error: null }, false],
  ['row body returned', { data: [{ id: 'forbidden' }], count: 1, error: null }, { data: null, count: 0, error: null }, false],
]) {
  test(`membership boolean: ${name}`, async () => {
    const db = serviceDbFixture({ user_id_uuid: modern, user_id: legacy });
    assert.equal(await hasAnyActiveClientMembership({ serviceDb: db, userId: 'test-user' }), expected);
    assert.equal(db.calls.length, 2);
    for (const call of db.calls) {
      assert.equal(call.columns, 'clients!inner(id)');
      assert.deepEqual(call.options, { count: 'exact', head: true });
      assert.equal(call.filter, 'clients.archived_at');
      assert.equal(call.filterValue, null);
    }
  });
}
