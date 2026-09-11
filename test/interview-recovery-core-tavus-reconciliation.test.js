'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  annotateTavusCreateError,
  classifyTavusCreateError,
  createTavusReadOnlyProvider,
  deterministicConversationName,
  reconcileAmbiguousTavusStart,
} = require('../src/services/tavusVendorReconciliation');

const ID = {
  replacement: '74000000-0000-4000-8000-000000000005',
  authorization: '74000000-0000-4000-8000-000000000007',
  reconcileToken: '74000000-0000-4000-8000-000000000008',
};
const EXTERNAL_REFERENCE = `alphascreen-interview-${ID.replacement}`;

class FakeDb {
  constructor() {
    this.state = 'reconciliation_required';
    this.calls = [];
    this.count = 0;
  }
  async rpc(name, args) {
    this.calls.push({ name, args });
    if (name === 'claim_interview_recovery_reconciliation_core') {
      if (this.state !== 'reconciliation_required') {
        return { data: [{ claimed: false, state: this.state }], error: null };
      }
      this.state = 'vendor_reconciliation_in_progress';
      this.count += 1;
      return { data: [{
        claimed: true,
        claim_token: ID.reconcileToken,
        vendor_external_reference: EXTERNAL_REFERENCE,
        reconciliation_attempt_count: this.count,
      }], error: null };
    }
    if (name === 'complete_interview_recovery_reconciliation_core') {
      if (args.p_claim_token !== ID.reconcileToken || this.state !== 'vendor_reconciliation_in_progress') {
        return { data: null, error: { message: 'stale' } };
      }
      this.state = args.p_outcome === 'resolved' ? 'started' : 'vendor_reconciliation_manual_review';
      return { data: this.state, error: null };
    }
    return { data: null, error: { message: `unexpected:${name}` } };
  }
}

function completeLookup(matches) {
  return {
    complete: true,
    scan_status: 'complete',
    matches,
    total_exact_match_count: matches.length,
    pages_requested: 1,
    pages_completed: 1,
    total_count_reported: matches.length,
  };
}

function match(id = 'conversation-one') {
  return {
    conversation_id: id,
    conversation_name: EXTERNAL_REFERENCE,
    conversation_url: `https://tavus.daily.co/${id}`,
  };
}

async function reconcile(db, lookup) {
  return reconcileAmbiguousTavusStart({
    db,
    provider: { findExactConversations: async () => lookup },
    interviewId: ID.replacement,
    authorizationId: ID.authorization,
    requestId: 'mock-reconciliation',
  });
}

test('Tavus reconciliation 1. deterministic identity is exact and UUID-bound', () => {
  assert.equal(deterministicConversationName(ID.replacement), EXTERNAL_REFERENCE);
  assert.throws(() => deterministicConversationName(['not', 'a', 'uuid']), /interview_id_invalid/);
});

test('Tavus reconciliation 2. every transmitted error is ambiguous without an official non-creation guarantee', () => {
  for (const status of [400, 401, 403, 404, 422, 429, 500, 502, 504]) {
    assert.deepEqual(classifyTavusCreateError({ response: { status } }, { requestTransmitted: true }), {
      category: 'ambiguous_acceptance', retryable: false,
    });
  }
  const annotated = annotateTavusCreateError(new Error('timeout'), { requestTransmitted: true });
  assert.equal(annotated.failureCategory, 'ambiguous_acceptance');
  assert.equal(annotated.retryable, false);
});

test('Tavus reconciliation 3. only locally proven no-transmission failures are definite', () => {
  assert.deepEqual(classifyTavusCreateError(new Error('missing config'), { requestTransmitted: false }), {
    category: 'definite_pre_acceptance', retryable: true,
  });
});

test('Tavus reconciliation 4. one exact match from a complete scan binds once', async () => {
  const db = new FakeDb();
  const result = await reconcile(db, completeLookup([match()]));
  assert.equal(result.status, 'started');
  assert.equal(result.conversation_id, 'conversation-one');
  const completion = db.calls.at(-1).args;
  assert.equal(completion.p_scan_complete, true);
  assert.equal(completion.p_total_exact_match_count, 1);
});

test('Tavus reconciliation 5. complete zero-match scan is permanent manual review, never retry authorization', async () => {
  const db = new FakeDb();
  const result = await reconcile(db, completeLookup([]));
  assert.equal(result.status, 'vendor_reconciliation_manual_review');
  const serialized = JSON.stringify(db.calls);
  assert.doesNotMatch(serialized, /absence_proven|retry_authorized/);
});

test('Tavus reconciliation 6. multiple exact matches persist the true count and bounded references', async () => {
  const db = new FakeDb();
  const matches = Array.from({ length: 14 }, (_, index) => match(`conversation-${index}`));
  const result = await reconcile(db, completeLookup(matches));
  assert.equal(result.status, 'vendor_reconciliation_manual_review');
  const completion = db.calls.at(-1).args;
  assert.equal(completion.p_total_exact_match_count, 14);
  assert.equal(completion.p_stored_match_reference_count, 10);
  assert.equal(completion.p_match_references_truncated, true);
  assert.equal(completion.p_match_references.length, 10);
});

test('Tavus reconciliation 7. incomplete scan with a visible exact match does not bind', async () => {
  const db = new FakeDb();
  const result = await reconcile(db, {
    complete: false,
    scan_status: 'incomplete_page_limit',
    matches: [match()],
    total_exact_match_count: null,
    pages_requested: 25,
    pages_completed: 25,
    total_count_reported: 3000,
  });
  assert.equal(result.status, 'vendor_reconciliation_manual_review');
  assert.equal(db.calls.at(-1).args.p_outcome, 'unavailable');
  assert.equal(db.calls.at(-1).args.p_total_exact_match_count, null);
});

test('Tavus reconciliation 8. provider unavailability is manual review', async () => {
  const db = new FakeDb();
  const result = await reconcileAmbiguousTavusStart({
    db,
    provider: { findExactConversations: async () => { throw new Error('offline'); } },
    interviewId: ID.replacement,
    authorizationId: ID.authorization,
    requestId: 'offline',
  });
  assert.equal(result.status, 'vendor_reconciliation_manual_review');
  assert.equal(db.calls.at(-1).args.p_scan_status, 'unavailable');
});

test('Tavus reconciliation 9. concurrent actions produce one lookup and one result transition', async () => {
  const db = new FakeDb();
  let lookups = 0;
  const provider = { findExactConversations: async () => { lookups += 1; return completeLookup([match()]); } };
  const input = { db, provider, interviewId: ID.replacement, authorizationId: ID.authorization, requestId: 'concurrent' };
  const [first, second] = await Promise.all([
    reconcileAmbiguousTavusStart(input),
    reconcileAmbiguousTavusStart(input),
  ]);
  assert.equal(lookups, 1);
  assert.deepEqual(new Set([first.status, second.status]), new Set(['started', 'vendor_reconciliation_in_progress']));
});

test('Tavus reconciliation 10. list provider never traverses beyond one response', async () => {
  const pages = [];
  const provider = createTavusReadOnlyProvider({
    apiKey: 'test-key',
    httpClient: {
      get: async (_url, options) => {
        pages.push(options.params.page);
        const start = (options.params.page - 1) * 100;
        const count = options.params.page === 1 ? 100 : 1;
        return { data: {
          total_count: 101,
          data: Array.from({ length: count }, (_, index) => ({
            conversation_id: `conversation-${start + index}`,
            conversation_name: start + index === 100 ? EXTERNAL_REFERENCE : `other-${start + index}`,
            conversation_url: `https://tavus.daily.co/${start + index}`,
          })),
        } };
      },
    },
  });
  const result = await provider.findExactConversations(EXTERNAL_REFERENCE);
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(result.matches.length, 0);
  assert.deepEqual(pages, [1]);
});
