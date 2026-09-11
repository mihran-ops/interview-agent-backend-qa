'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createTavusReadOnlyProvider,
  reconcileAmbiguousTavusStart,
} = require('../src/services/tavusVendorReconciliation');

const INTERVIEW_ID = '78000000-0000-4000-8000-000000000001';
const AUTHORIZATION_ID = '78000000-0000-4000-8000-000000000002';
const CLAIM_TOKEN = '78000000-0000-4000-8000-000000000003';
const EXACT = `alphascreen-interview-${INTERVIEW_ID}`;

function exactRow() {
  return {
    conversation_id: 'r31-conversation',
    conversation_name: EXACT,
    conversation_url: 'https://tavus.daily.co/r31-conversation',
  };
}

function providerFor(metadata = {}) {
  return createTavusReadOnlyProvider({
    apiKey: 'mock-only',
    httpClient: {
      get: async () => ({
        data: {
          total_count: 1,
          data: [exactRow()],
          ...metadata,
        },
      }),
    },
  });
}

async function scan(metadata = {}) {
  return providerFor(metadata).findExactConversations(EXACT);
}

function assertComplete(result) {
  assert.equal(result.complete, true);
  assert.equal(result.scan_status, 'complete');
  assert.equal(result.matches.length, 1);
}

function assertManual(result, status) {
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, status);
  assert.equal(result.matches.length, 0);
  assert.equal(result.total_exact_match_count, null);
}

test('R3.1 pagination 1. has_more false is a valid single-page signal', async () => {
  assertComplete(await scan({ has_more: false }));
});

test('R3.1 pagination 2. has_more true requires multi-page manual review', async () => {
  assertManual(await scan({ has_more: true }), 'incomplete_multi_page_unsupported');
});

for (const [number, value, label] of [
  [3, 1, 'numeric one'],
  [4, 0, 'numeric zero'],
  [5, 'true', 'string true'],
  [6, 'false', 'string false'],
  [7, null, 'null'],
  [8, [], 'array'],
  [9, {}, 'object'],
]) {
  test(`R3.1 pagination ${number}. has_more ${label} is malformed`, async () => {
    assertManual(await scan({ has_more: value }), 'incomplete_malformed_page');
  });
}

test('R3.1 pagination 10. has_next_page numeric one is malformed', async () => {
  assertManual(await scan({ has_next_page: 1 }), 'incomplete_malformed_page');
});

test('R3.1 pagination 11. has_next_page string true is malformed', async () => {
  assertManual(await scan({ has_next_page: 'true' }), 'incomplete_malformed_page');
});

test('R3.1 pagination 12. total_pages one is valid', async () => {
  assertComplete(await scan({ total_pages: 1 }));
});

test('R3.1 pagination 13. total_pages two requires multi-page manual review', async () => {
  assertManual(await scan({ total_pages: 2 }), 'incomplete_multi_page_unsupported');
});

for (const [number, field, value, label] of [
  [14, 'total_pages', 0, 'total_pages zero'],
  [15, 'total_pages', -1, 'total_pages negative'],
  [16, 'total_pages', 1.5, 'total_pages fractional'],
  [17, 'total_pages', '1', 'total_pages string'],
  [18, 'page_count', 0, 'page_count zero'],
  [19, 'last_page', -1, 'last_page negative'],
]) {
  test(`R3.1 pagination ${number}. ${label} is malformed`, async () => {
    assertManual(await scan({ [field]: value }), 'incomplete_malformed_page');
  });
}

test('R3.1 pagination 20. current_page one is valid', async () => {
  assertComplete(await scan({ current_page: 1 }));
});

test('R3.1 pagination 21. current_page two requires manual review', async () => {
  assertManual(await scan({ current_page: 2 }), 'incomplete_multi_page_unsupported');
});

test('R3.1 pagination 22. current_page string one is malformed', async () => {
  assertManual(await scan({ current_page: '1' }), 'incomplete_malformed_page');
});

test('R3.1 pagination 23. next_page two requires manual review', async () => {
  assertManual(await scan({ next_page: 2 }), 'incomplete_multi_page_unsupported');
});

test('R3.1 pagination 24. next_page string two is malformed', async () => {
  assertManual(await scan({ next_page: '2' }), 'incomplete_malformed_page');
});

test('R3.1 pagination 25. next_page object is malformed', async () => {
  assertManual(await scan({ next_page: {} }), 'incomplete_malformed_page');
});

test('R3.1 pagination 26. nested current_page two requires manual review', async () => {
  assertManual(await scan({ pagination: { current_page: 2 } }), 'incomplete_multi_page_unsupported');
});

test('R3.1 pagination 27. nested has_more numeric one is malformed', async () => {
  assertManual(await scan({ pagination: { has_more: 1 } }), 'incomplete_malformed_page');
});

test('R3.1 pagination 28. nested meta total_pages zero is malformed', async () => {
  assertManual(await scan({ meta: { total_pages: 0 } }), 'incomplete_malformed_page');
});

test('R3.1 pagination 29. pagination array container is malformed', async () => {
  assertManual(await scan({ pagination: [] }), 'incomplete_malformed_page');
});

test('R3.1 pagination 30. pagination string container is malformed', async () => {
  assertManual(await scan({ pagination: 'page-one' }), 'incomplete_malformed_page');
});

test('R3.1 pagination 31. conflicting top-level and nested metadata is malformed', async () => {
  assertManual(await scan({ total_pages: 1, pagination: { total_pages: 2 } }), 'incomplete_malformed_page');
});

class ReconciliationDb {
  constructor(completionStatus = 'vendor_reconciliation_manual_review') {
    this.calls = [];
    this.completionStatus = completionStatus;
  }

  async rpc(name, args) {
    this.calls.push({ name, args });
    if (name === 'claim_interview_recovery_reconciliation_core') {
      return {
        data: [{
          claimed: true,
          claim_token: CLAIM_TOKEN,
          vendor_external_reference: EXACT,
        }],
        error: null,
      };
    }
    if (name === 'complete_interview_recovery_reconciliation_core') {
      return { data: this.completionStatus, error: null };
    }
    return { data: null, error: { message: `unexpected:${name}` } };
  }
}

async function reconcile(metadata, completionStatus) {
  const db = new ReconciliationDb(completionStatus);
  const result = await reconcileAmbiguousTavusStart({
    db,
    provider: providerFor(metadata),
    interviewId: INTERVIEW_ID,
    authorizationId: AUTHORIZATION_ID,
    requestId: 'r31-pagination-metadata',
  });
  return { db, result, completion: db.calls.at(-1) };
}

for (const [number, metadata, label] of [
  [32, { has_more: 1 }, 'has_more numeric one'],
  [33, { has_more: 'true' }, 'has_more string true'],
  [34, { total_pages: 0 }, 'total_pages zero'],
  [35, { pagination: { current_page: 2 } }, 'nested current_page two'],
]) {
  test(`R3.1 pagination ${number}. exact match plus ${label} cannot resolve`, async () => {
    const { db, result, completion } = await reconcile(metadata);
    assert.equal(result.status, 'vendor_reconciliation_manual_review');
    assert.equal(completion.name, 'complete_interview_recovery_reconciliation_core');
    assert.equal(completion.args.p_outcome, 'unavailable');
    assert.equal(completion.args.p_scan_complete, false);
    assert.equal(completion.args.p_vendor_conversation_id, null);
    assert.equal(completion.args.p_vendor_conversation_url, null);
    assert.equal(db.calls.some((call) => /create/i.test(call.name)), false);
  });
}

test('R3.1 pagination 36. malformed metadata persists manual review without create or binding', async () => {
  const { db, result, completion } = await reconcile({ has_more: [] });
  assert.equal(result.status, 'vendor_reconciliation_manual_review');
  assert.equal(completion.args.p_scan_status, 'incomplete_malformed_page');
  assert.equal(completion.args.p_total_exact_match_count, null);
  assert.equal(completion.args.p_stored_match_reference_count, 0);
  assert.equal(completion.args.p_match_references, null);
  assert.equal(db.calls.length, 2);
});

test('R3.1 pagination 37. valid complete exact response still resolves', async () => {
  const { db, result, completion } = await reconcile({
    current_page: 1,
    total_pages: 1,
    has_more: false,
  }, 'started');
  assert.equal(result.status, 'started');
  assert.equal(completion.args.p_outcome, 'resolved');
  assert.equal(completion.args.p_scan_complete, true);
  assert.equal(completion.args.p_scan_status, 'complete');
  assert.equal(completion.args.p_vendor_conversation_id, 'r31-conversation');
  assert.equal(completion.args.p_pages_requested, 1);
  assert.equal(completion.args.p_pages_completed, 1);
  assert.equal(db.calls.some((call) => /create/i.test(call.name)), false);
});

test('R3.1 supported pagination aliases and containers validate without coercion', async () => {
  for (const metadata of [
    { has_next: false },
    { more_results: false },
    { page_number: 1 },
    { next_page: null },
    { links: { next: null, next_url: null, next_page_url: null, next_cursor: null } },
    { metadata: { has_next_page: false } },
    { paging: { total_pages: 1 } },
    { page_info: { current_page: 1 } },
  ]) assertComplete(await scan(metadata));

  for (const metadata of [
    { has_next: 0 },
    { more_results: null },
    { page_number: '1' },
    { next: 2 },
    { next_url: false },
    { next_page_url: {} },
    { next_cursor: [] },
    { metadata: null },
    { paging: [] },
    { page_info: 'one' },
    { links: 1 },
  ]) assertManual(await scan(metadata), 'incomplete_malformed_page');
});

test('R3.1 coherent multi-page aliases remain manual and contradictions are malformed', async () => {
  for (const metadata of [
    { current_page: 1, total_pages: 2, has_more: true, next_page: 2 },
    { links: { next: 'https://tavus.invalid/page/2' } },
    { metadata: { next_cursor: 'cursor-two' } },
  ]) assertManual(await scan(metadata), 'incomplete_multi_page_unsupported');

  for (const metadata of [
    { current_page: 1, total_pages: 1, has_more: true },
    { has_more: false, next_page: 2 },
    { current_page: 2, total_pages: 1 },
    { page: 1, pagination: { current_page: 2 } },
    { meta: { pagination: { total_pages: 1 }, total_pages: 2 } },
  ]) assertManual(await scan(metadata), 'incomplete_malformed_page');
});
