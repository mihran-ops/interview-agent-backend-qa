'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  LIST_PAGE_SIZE,
  createTavusReadOnlyProvider,
  reconcileAmbiguousTavusStart,
} = require('../src/services/tavusVendorReconciliation');

const INTERVIEW_ID = '77000000-0000-4000-8000-000000000001';
const AUTHORIZATION_ID = '77000000-0000-4000-8000-000000000002';
const CLAIM_TOKEN = '77000000-0000-4000-8000-000000000003';
const EXACT = `alphascreen-interview-${INTERVIEW_ID}`;

function row(index, name = `other-${index}`, overrides = {}) {
  return {
    conversation_id: `conversation-${index}`,
    conversation_name: name,
    conversation_url: `https://tavus.daily.co/conversation-${index}`,
    ...overrides,
  };
}

async function scan(responseFactory) {
  const requests = [];
  const provider = createTavusReadOnlyProvider({
    apiKey: 'test-key',
    httpClient: {
      get: async (_url, options) => {
        requests.push({ ...options.params });
        const response = await responseFactory(options.params.page, requests.length);
        if (response instanceof Error) throw response;
        return { data: response };
      },
    },
  });
  return { result: await provider.findExactConversations(EXACT), requests };
}

test('R3 single page 1. empty complete list is a known zero match', async () => {
  const { result, requests } = await scan(async () => ({ total_count: 0, data: [], page: 1 }));
  assert.equal(result.complete, true);
  assert.equal(result.total_exact_match_count, 0);
  assert.deepEqual(requests, [{ limit: LIST_PAGE_SIZE, page: 1 }]);
});

test('R3 single page 2. one valid exact row is bindable evidence', async () => {
  const { result } = await scan(async () => ({ total_count: 1, data: [row(1, EXACT)] }));
  assert.equal(result.complete, true);
  assert.equal(result.scan_status, 'complete');
  assert.deepEqual(result.matches.map((item) => item.conversation_id), ['conversation-1']);
});

test('R3 single page 3. one non-match is a known zero match', async () => {
  const { result } = await scan(async () => ({ total_count: 1, data: [row(1)] }));
  assert.equal(result.complete, true);
  assert.equal(result.total_exact_match_count, 0);
});

test('R3 single page 4. one exact among two returned unique rows is complete', async () => {
  const { result } = await scan(async () => ({ total_count: 2, data: [row(1, EXACT), row(2)] }));
  assert.equal(result.complete, true);
  assert.equal(result.total_exact_match_count, 1);
});

test('R3 single page 5. fewer returned rows than total is incomplete', async () => {
  const { result } = await scan(async () => ({ total_count: 2, data: [row(1, EXACT)] }));
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_short_page');
  assert.equal(result.matches.length, 0);
});

test('R3 single page 6. exactly one full page with one exact row is complete', async () => {
  const data = Array.from({ length: LIST_PAGE_SIZE }, (_, index) => row(index, index === 71 ? EXACT : undefined));
  const { result, requests } = await scan(async () => ({ total_count: LIST_PAGE_SIZE, data }));
  assert.equal(result.complete, true);
  assert.equal(result.total_exact_match_count, 1);
  assert.equal(requests.length, 1);
});

test('R3 single page 7. page-limit plus one is manual-only without page two', async () => {
  const data = Array.from({ length: LIST_PAGE_SIZE }, (_, index) => row(index));
  const { result, requests } = await scan(async () => ({ total_count: LIST_PAGE_SIZE + 1, data }));
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(result.total_exact_match_count, null);
  assert.equal(result.total_count_reported, LIST_PAGE_SIZE + 1);
  assert.equal(result.pages_requested, 1);
  assert.equal(result.pages_completed, 1);
  assert.equal(requests.length, 1);
});

test('R3 single page 8. page-one exact in a large account is not accumulated or bound', async () => {
  const data = [row(0, EXACT), ...Array.from({ length: LIST_PAGE_SIZE - 1 }, (_, index) => row(index + 1))];
  const { result } = await scan(async () => ({ total_count: 500, data }));
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.deepEqual(result.matches, []);
});

test('R3 single page 9. conceptual page-two exact is never requested', async () => {
  const pageOne = Array.from({ length: LIST_PAGE_SIZE }, (_, index) => row(index));
  const { result, requests } = await scan(async (page) => page === 1
    ? { total_count: LIST_PAGE_SIZE + 1, data: pageOne }
    : { total_count: LIST_PAGE_SIZE + 1, data: [row(LIST_PAGE_SIZE, EXACT)] });
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(requests.length, 1);
});

test('R3 single page 10. conceptual exact matches on separate pages stay unknown', async () => {
  const pageOne = [row(0, EXACT), ...Array.from({ length: LIST_PAGE_SIZE - 1 }, (_, index) => row(index + 1))];
  const { result, requests } = await scan(async (page) => page === 1
    ? { total_count: LIST_PAGE_SIZE + 1, data: pageOne }
    : { total_count: LIST_PAGE_SIZE + 1, data: [row(LIST_PAGE_SIZE, EXACT)] });
  assert.equal(result.complete, false);
  assert.equal(result.total_exact_match_count, null);
  assert.deepEqual(result.matches, []);
  assert.equal(requests.length, 1);
});

test('R3 single page 11. stable-total insert-delete mutation cannot affect a one-request decision', async () => {
  const first = Array.from({ length: LIST_PAGE_SIZE }, (_, index) => row(index, index === 5 ? EXACT : undefined));
  const { result, requests } = await scan(async (page, call) => call === 1
    ? { total_count: 200, data: first }
    : { total_count: 200, data: [row('new', EXACT), ...first.slice(0, -1)] });
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(requests.length, 1);
});

test('R3 single page 12. shifted offset fixture cannot trigger a second request', async () => {
  const first = Array.from({ length: LIST_PAGE_SIZE }, (_, index) => row(index));
  const shifted = Array.from({ length: LIST_PAGE_SIZE }, (_, index) => row(index + 99));
  const { result, requests } = await scan(async (page) => ({ total_count: 200, data: page === 1 ? first : shifted }));
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(requests.length, 1);
});

test('R3 single page 13. repeated conceptual page is never fetched', async () => {
  const repeated = Array.from({ length: LIST_PAGE_SIZE }, (_, index) => row(index));
  const { result, requests } = await scan(async () => ({ total_count: 200, data: repeated }));
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(requests.length, 1);
});

test('R3 single page 14. duplicate conversation IDs are incomplete', async () => {
  const duplicate = row(1);
  const { result } = await scan(async () => ({ total_count: 2, data: [duplicate, { ...duplicate, conversation_name: EXACT }] }));
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_malformed_page');
});

test('R3 single page 15. two exact names with unique IDs remain multiple-match evidence', async () => {
  const { result } = await scan(async () => ({ total_count: 2, data: [row(1, EXACT), row(2, EXACT)] }));
  assert.equal(result.complete, true);
  assert.equal(result.total_exact_match_count, 2);
});

test('R3 single page 16. missing, non-integer, and negative totals fail closed', async () => {
  for (const total_count of [undefined, 1.5, -1]) {
    const { result } = await scan(async () => ({ total_count, data: [] }));
    assert.equal(result.complete, false);
    assert.equal(result.scan_status, 'incomplete_missing_total');
  }
});

test('R3 single page 17. returned item count greater than total fails closed', async () => {
  const { result } = await scan(async () => ({ total_count: 1, data: [row(1), row(2)] }));
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_malformed_page');
});

test('R3 single page 18. malformed rows and an exact row without URL fail closed', async () => {
  for (const data of [
    [{ conversation_name: EXACT, conversation_url: 'https://tavus.daily.co/missing-id' }],
    [row(1, EXACT, { conversation_url: '' })],
  ]) {
    const { result } = await scan(async () => ({ total_count: 1, data }));
    assert.equal(result.complete, false);
    assert.equal(result.scan_status, 'incomplete_malformed_page');
  }
});

test('R3 single page 19. provider failure and additional-page signals are manual-only', async () => {
  const unavailable = await scan(async () => new Error('offline'));
  assert.equal(unavailable.result.scan_status, 'unavailable');
  for (const signal of [
    { has_more: true },
    { next_page: 2 },
    { total_pages: 2 },
    { pagination: { next_cursor: 'cursor' } },
    { links: { next: 'https://tavus.invalid/conversations?page=2' } },
  ]) {
    const { result } = await scan(async () => ({ total_count: 1, data: [row(1, EXACT)], ...signal }));
    assert.equal(result.complete, false);
    assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  }
});

class ReconciliationDb {
  constructor() { this.calls = []; }
  async rpc(name, args) {
    this.calls.push({ name, args });
    if (name === 'claim_interview_recovery_reconciliation_core') {
      return { data: [{ claimed: true, claim_token: CLAIM_TOKEN, vendor_external_reference: EXACT }], error: null };
    }
    if (name === 'complete_interview_recovery_reconciliation_core') {
      return { data: 'vendor_reconciliation_manual_review', error: null };
    }
    return { data: null, error: { message: `unexpected:${name}` } };
  }
}

test('R3 single page 20. incomplete multi-page evidence persists unknown count and never authorizes create', async () => {
  const db = new ReconciliationDb();
  const result = await reconcileAmbiguousTavusStart({
    db,
    provider: { findExactConversations: async () => ({
      complete: false,
      scan_status: 'incomplete_multi_page_unsupported',
      matches: [],
      total_exact_match_count: null,
      pages_requested: 1,
      pages_completed: 1,
      total_count_reported: 101,
    }) },
    interviewId: INTERVIEW_ID,
    authorizationId: AUTHORIZATION_ID,
    requestId: 'r3-multi-page',
  });
  assert.equal(result.status, 'vendor_reconciliation_manual_review');
  const completion = db.calls.at(-1);
  assert.equal(completion.args.p_outcome, 'unavailable');
  assert.equal(completion.args.p_scan_complete, false);
  assert.equal(completion.args.p_total_exact_match_count, null);
  assert.equal(completion.args.p_stored_match_reference_count, 0);
  assert.equal(db.calls.some((call) => /create/i.test(call.name)), false);
});
