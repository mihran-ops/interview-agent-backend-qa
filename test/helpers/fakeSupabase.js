'use strict';

// A small in-memory stand-in for the Supabase client, for tests that need the
// filter chain to actually select rows rather than just record that it was called.
//
// Supports the operators the billing services use — eq, neq, is, gt, gte, lt,
// lte, in — plus order, limit, select, insert, update, delete and maybeSingle.
// Tables are plain arrays, so a test can read and mutate them directly.
//
// It is deliberately not a database: there are no constraints beyond the unique
// indexes a test declares, and writes are not transactional.

function compare(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function matches(row, filters) {
  return filters.every(({ op, column, value }) => {
    const current = row?.[column];
    switch (op) {
      case 'eq': return String(current ?? '') === String(value ?? '');
      case 'neq': return String(current ?? '') !== String(value ?? '');
      case 'is': return value === null ? current == null : current === value;
      case 'gt': return current != null && compare(current, value) > 0;
      case 'gte': return current != null && compare(current, value) >= 0;
      case 'lt': return current != null && compare(current, value) < 0;
      case 'lte': return current != null && compare(current, value) <= 0;
      case 'in': return (value || []).some((entry) => String(entry ?? '') === String(current ?? ''));
      case 'not': return !matches(row, [{ op: value.op, column, value: value.value }]);
      default: return true;
    }
  });
}

let nextId = 0;
function generateId(table) {
  nextId += 1;
  return `${table}_${nextId}`;
}

/**
 * @param tables  { [name]: row[] } — mutated in place, so assertions can read them.
 * @param options.unique  { [table]: (row) => string|null } — a conflict key per
 *   table; an insert whose key collides with a live row fails the way Postgres
 *   would, with code 23505.
 * @param options.failOn  { [table]: { op, error } } — forces one operation on a
 *   table to fail, for the error paths.
 * @param options.beforeUpdate  (table, patch, rows) => void — runs between an
 *   update's read and its write, to stage a concurrent change.
 */
function createFakeSupabase(tables = {}, options = {}) {
  const calls = [];
  const unique = options.unique || {};
  const failOn = options.failOn || {};

  const rowsOf = (table) => {
    if (!Array.isArray(tables[table])) tables[table] = [];
    return tables[table];
  };

  const failureFor = (table, op) => {
    const configured = failOn[table];
    if (!configured || configured.op !== op) return null;
    if (configured.consumed) return null;
    configured.consumed = true;
    return configured.error || { message: `${table} ${op} failed` };
  };

  function from(table) {
    const filters = [];
    let pendingUpdate = null;
    let pendingInsert = null;
    let pendingDelete = false;
    let ordering = null;
    let limit = null;

    const resolveRows = () => {
      let selected = rowsOf(table).filter((row) => matches(row, filters));
      if (ordering) {
        selected = [...selected].sort((a, b) => {
          const direction = ordering.ascending === false ? -1 : 1;
          return compare(a?.[ordering.column], b?.[ordering.column]) * direction;
        });
      }
      if (limit != null) selected = selected.slice(0, limit);
      return selected;
    };

    const runWrite = () => {
      if (pendingInsert) {
        const failure = failureFor(table, 'insert');
        if (failure) return { data: null, error: failure };
        const keyOf = unique[table];
        const inserted = [];
        for (const row of pendingInsert) {
          if (keyOf) {
            const key = keyOf(row);
            if (key != null && rowsOf(table).some((existing) => keyOf(existing) === key)) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
          }
          const stored = { id: generateId(table), ...row };
          rowsOf(table).push(stored);
          inserted.push(stored);
        }
        return { data: inserted, error: null };
      }

      if (pendingUpdate) {
        const failure = failureFor(table, 'update');
        if (failure) return { data: null, error: failure };
        const targets = rowsOf(table).filter((row) => matches(row, filters));
        if (options.beforeUpdate) options.beforeUpdate(table, pendingUpdate, targets);
        const stillMatching = rowsOf(table).filter((row) => matches(row, filters));
        for (const row of stillMatching) Object.assign(row, pendingUpdate);
        return { data: stillMatching, error: null };
      }

      if (pendingDelete) {
        const doomed = new Set(rowsOf(table).filter((row) => matches(row, filters)));
        tables[table] = rowsOf(table).filter((row) => !doomed.has(row));
        return { data: [...doomed], error: null };
      }

      const failure = failureFor(table, 'select');
      if (failure) return { data: null, error: failure };
      return { data: resolveRows(), error: null };
    };

    const query = {
      select() { return query; },
      eq(column, value) { filters.push({ op: 'eq', column, value }); return query; },
      neq(column, value) { filters.push({ op: 'neq', column, value }); return query; },
      is(column, value) { filters.push({ op: 'is', column, value }); return query; },
      gt(column, value) { filters.push({ op: 'gt', column, value }); return query; },
      gte(column, value) { filters.push({ op: 'gte', column, value }); return query; },
      lt(column, value) { filters.push({ op: 'lt', column, value }); return query; },
      lte(column, value) { filters.push({ op: 'lte', column, value }); return query; },
      in(column, value) { filters.push({ op: 'in', column, value }); return query; },
      // PostgREST spells negation as .not(column, operator, value).
      not(column, operator, value) { filters.push({ op: 'not', column, value: { op: operator, value } }); return query; },
      order(column, opts = {}) { ordering = { column, ascending: opts.ascending !== false }; return query; },
      limit(value) { limit = value; return query; },
      insert(payload) {
        pendingInsert = Array.isArray(payload) ? payload : [payload];
        calls.push({ table, op: 'insert', payload });
        return query;
      },
      update(payload) {
        pendingUpdate = payload;
        calls.push({ table, op: 'update', payload });
        return query;
      },
      upsert(payload) {
        pendingInsert = Array.isArray(payload) ? payload : [payload];
        calls.push({ table, op: 'upsert', payload });
        return query;
      },
      delete() { pendingDelete = true; calls.push({ table, op: 'delete' }); return query; },
      maybeSingle() {
        const { data, error } = runWrite();
        if (error) return Promise.resolve({ data: null, error });
        const rows = Array.isArray(data) ? data : [data];
        return Promise.resolve({ data: rows.length ? { ...rows[0] } : null, error: null });
      },
      single() { return query.maybeSingle(); },
      then(resolve, reject) {
        try {
          const { data, error } = runWrite();
          return Promise.resolve(resolve({ data, error }));
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
        }
      }
    };
    return query;
  }

  return { tables, calls, from };
}

module.exports = { createFakeSupabase };
