'use strict';

const { createTavusHttpClient } = require('../clients/tavus');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIST_PAGE_SIZE = 100;
const MAX_STORED_MATCH_REFERENCES = 10;
const BOOLEAN_PAGINATION_FIELDS = ['has_more', 'has_next_page', 'has_next', 'more_results'];
const CURRENT_PAGE_FIELDS = ['current_page', 'page', 'page_number'];
const TOTAL_PAGE_FIELDS = ['total_pages', 'page_count', 'last_page'];
const NEXT_REFERENCE_FIELDS = ['next', 'next_url', 'next_page_url', 'next_cursor'];
const PAGINATION_CONTAINER_FIELDS = ['pagination', 'meta', 'metadata', 'paging', 'page_info', 'links'];

function deterministicConversationName(interviewId) {
  const id = typeof interviewId === 'string' ? interviewId.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(id)) {
    const error = new Error('interview_id_invalid');
    error.code = 'interview_id_invalid';
    error.failureCategory = 'definite_pre_acceptance';
    error.retryable = false;
    throw error;
  }
  return `alphascreen-interview-${id}`;
}

function classifyTavusCreateError(error, { requestTransmitted = false } = {}) {
  if (error?.failureCategory === 'ambiguous_acceptance') {
    return { category: 'ambiguous_acceptance', retryable: false };
  }
  if (requestTransmitted !== true || error?.beforeTransmission === true) {
    return { category: 'definite_pre_acceptance', retryable: error?.retryable !== false };
  }
  return { category: 'ambiguous_acceptance', retryable: false };
}

function annotateTavusCreateError(error, options) {
  const target = error instanceof Error ? error : new Error('Tavus create failed');
  const classification = classifyTavusCreateError(target, options);
  target.failureCategory = classification.category;
  target.retryable = classification.retryable;
  return target;
}

function boundedScanResult(status, {
  matches = [],
  pagesRequested = 0,
  pagesCompleted = 0,
  totalCountReported = null,
  complete = false,
} = {}) {
  return {
    complete,
    scan_status: status,
    matches,
    total_exact_match_count: complete ? matches.length : null,
    pages_requested: pagesRequested,
    pages_completed: pagesCompleted,
    total_count_reported: Number.isInteger(totalCountReported) ? totalCountReported : null,
  };
}

function hasOwn(target, field) {
  return Object.prototype.hasOwnProperty.call(target, field);
}

function validatePaginationMetadata(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { malformed: true, hasAdditionalPage: false };
  }

  const seenContainers = new Set();
  const fieldValues = new Map();
  const categoryValues = new Map();
  const queue = [body];
  let hasMoreSignal = false;
  let hasNoMoreSignal = false;
  let currentPage = null;
  let totalPages = null;
  let nextPage = null;

  function recordValue(field, category, value) {
    if (fieldValues.has(field) && !Object.is(fieldValues.get(field), value)) return false;
    fieldValues.set(field, value);
    if (categoryValues.has(category) && !Object.is(categoryValues.get(category), value)) return false;
    categoryValues.set(category, value);
    return true;
  }

  while (queue.length) {
    const container = queue.shift();
    if (seenContainers.has(container)) {
      return { malformed: true, hasAdditionalPage: false };
    }
    seenContainers.add(container);

    for (const field of PAGINATION_CONTAINER_FIELDS) {
      if (!hasOwn(container, field)) continue;
      const nested = container[field];
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
        return { malformed: true, hasAdditionalPage: false };
      }
      queue.push(nested);
    }

    for (const field of BOOLEAN_PAGINATION_FIELDS) {
      if (!hasOwn(container, field)) continue;
      const value = container[field];
      if (typeof value !== 'boolean' || !recordValue(field, 'boolean', value)) {
        return { malformed: true, hasAdditionalPage: false };
      }
      if (value) hasMoreSignal = true;
      else hasNoMoreSignal = true;
    }

    for (const field of CURRENT_PAGE_FIELDS) {
      if (!hasOwn(container, field)) continue;
      const value = container[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1
        || !recordValue(field, 'current_page', value)) {
        return { malformed: true, hasAdditionalPage: false };
      }
      currentPage = value;
      if (value > 1) hasMoreSignal = true;
    }

    for (const field of TOTAL_PAGE_FIELDS) {
      if (!hasOwn(container, field)) continue;
      const value = container[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1
        || !recordValue(field, 'total_pages', value)) {
        return { malformed: true, hasAdditionalPage: false };
      }
      totalPages = value;
      if (value > 1) hasMoreSignal = true;
      else hasNoMoreSignal = true;
    }

    if (hasOwn(container, 'next_page')) {
      const value = container.next_page;
      if (value === null) {
        if (!recordValue('next_page', 'next_page', value)) {
          return { malformed: true, hasAdditionalPage: false };
        }
        hasNoMoreSignal = true;
      } else if (typeof value === 'number' && Number.isInteger(value) && value >= 2
        && recordValue('next_page', 'next_page', value)) {
        nextPage = value;
        hasMoreSignal = true;
      } else {
        return { malformed: true, hasAdditionalPage: false };
      }
    }

    for (const field of NEXT_REFERENCE_FIELDS) {
      if (!hasOwn(container, field)) continue;
      const value = container[field];
      if (value === null) {
        if (!recordValue(field, field, value)) {
          return { malformed: true, hasAdditionalPage: false };
        }
        hasNoMoreSignal = true;
      } else if (typeof value === 'string' && value.length > 0 && recordValue(field, field, value)) {
        hasMoreSignal = true;
      } else {
        return { malformed: true, hasAdditionalPage: false };
      }
    }
  }

  if (hasMoreSignal && hasNoMoreSignal
    || (currentPage !== null && totalPages !== null && currentPage > totalPages)
    || (nextPage !== null && currentPage !== null && nextPage !== currentPage + 1)
    || (nextPage !== null && totalPages !== null && nextPage > totalPages)) {
    return { malformed: true, hasAdditionalPage: false };
  }
  return { malformed: false, hasAdditionalPage: hasMoreSignal };
}

function createTavusReadOnlyProvider({
  apiKey = process.env.TAVUS_API_KEY,
  tavusHttpClient = null,
  httpClient = null,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const client = tavusHttpClient || (httpClient
    ? {
        async listConversations(query) {
          const response = await httpClient.get('/conversations', { params: query });
          return response?.data;
        },
      }
    : createTavusHttpClient({ apiKey: key }));
  return {
    async findExactConversations(externalReference) {
      if (!key) return boundedScanResult('unavailable');
      const exactName = typeof externalReference === 'string' ? externalReference.trim() : '';
      if (!exactName || exactName.length > 100) return boundedScanResult('incomplete_malformed_page');

      let body;
      try {
        body = await client.listConversations({ limit: LIST_PAGE_SIZE, page: 1 });
      } catch (_) {
        return boundedScanResult('unavailable', { pagesRequested: 1 });
      }

      const rows = body?.data;
      const totalCount = body?.total_count;
      if (!Array.isArray(rows)) {
        return boundedScanResult('incomplete_malformed_page', { pagesRequested: 1 });
      }
      const pagination = validatePaginationMetadata(body);
      if (pagination.malformed) {
        return boundedScanResult('incomplete_malformed_page', {
          pagesRequested: 1,
          pagesCompleted: 1,
          totalCountReported: totalCount,
        });
      }
      if (!Number.isInteger(totalCount) || totalCount < 0) {
        return boundedScanResult('incomplete_missing_total', { pagesRequested: 1 });
      }
      if (totalCount > LIST_PAGE_SIZE || pagination.hasAdditionalPage) {
        return boundedScanResult('incomplete_multi_page_unsupported', {
          pagesRequested: 1,
          pagesCompleted: 1,
          totalCountReported: totalCount,
        });
      }
      if (rows.length !== totalCount) {
        return boundedScanResult(rows.length < totalCount ? 'incomplete_short_page' : 'incomplete_malformed_page', {
          pagesRequested: 1,
          pagesCompleted: 1,
          totalCountReported: totalCount,
        });
      }

      const safeRows = [];
      const conversationIds = new Set();
      for (const row of rows) {
        const conversationId = typeof row?.conversation_id === 'string' ? row.conversation_id.trim() : '';
        if (!row || typeof row !== 'object' || Array.isArray(row)
          || !conversationId || conversationId.length > 200
          || typeof row.conversation_name !== 'string'
          || Buffer.byteLength(row.conversation_name, 'utf8') > 1000
          || conversationIds.has(conversationId)) {
          return boundedScanResult('incomplete_malformed_page', {
            pagesRequested: 1, pagesCompleted: 1, totalCountReported: totalCount,
          });
        }
        conversationIds.add(conversationId);
        safeRows.push({
          conversation_id: conversationId,
          conversation_name: row.conversation_name,
          conversation_url: typeof row.conversation_url === 'string'
            ? row.conversation_url.trim()
            : null,
          status: typeof row.status === 'string' ? row.status.trim().slice(0, 40) : null,
        });
      }

      const matches = [];
      for (const row of safeRows) {
        if (row.conversation_name !== exactName) continue;
        if (!row.conversation_url || row.conversation_url.length > 1000) {
          return boundedScanResult('incomplete_malformed_page', {
            pagesRequested: 1, pagesCompleted: 1, totalCountReported: totalCount,
          });
        }
        matches.push(row);
      }
      return boundedScanResult('complete', {
        matches,
        pagesRequested: 1,
        pagesCompleted: 1,
        totalCountReported: totalCount,
        complete: true,
      });
    },
  };
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function boundedRequestId(value) {
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

async function completeReconciliation(db, claim, args) {
  const references = (args.lookup?.complete === true ? args.lookup?.matches || [] : [])
    .map((item) => item?.conversation_id)
    .filter((value) => typeof value === 'string' && value)
    .slice(0, MAX_STORED_MATCH_REFERENCES);
  const totalMatches = args.lookup?.complete === true
    ? args.lookup.total_exact_match_count
    : null;
  const { data, error } = await db.rpc('complete_interview_recovery_reconciliation_core', {
    p_interview_id: args.interviewId,
    p_authorization_id: args.authorizationId,
    p_claim_token: claim.claim_token,
    p_outcome: args.outcome,
    p_vendor_conversation_id: args.match?.conversation_id || null,
    p_vendor_conversation_url: args.match?.conversation_url || null,
    p_request_id: boundedRequestId(args.requestId),
    p_match_references: references.length ? references : null,
    p_total_exact_match_count: Number.isInteger(totalMatches) ? totalMatches : null,
    p_stored_match_reference_count: references.length,
    p_match_references_truncated: Number.isInteger(totalMatches)
      ? totalMatches > references.length
      : (args.lookup?.matches || []).length > references.length,
    p_scan_complete: args.lookup?.complete === true,
    p_scan_status: args.lookup?.scan_status || 'unavailable',
    p_pages_requested: Number.isInteger(args.lookup?.pages_requested)
      ? args.lookup.pages_requested
      : 0,
    p_pages_completed: Number.isInteger(args.lookup?.pages_completed)
      ? args.lookup.pages_completed
      : 0,
    p_total_count_reported: Number.isInteger(args.lookup?.total_count_reported)
      ? args.lookup.total_count_reported
      : null,
  });
  if (error) throw new Error('vendor_reconciliation_unavailable');
  return data;
}

async function reconcileAmbiguousTavusStart({
  db,
  provider,
  interviewId,
  authorizationId,
  requestId,
}) {
  const { data: claimData, error: claimError } = await db.rpc('claim_interview_recovery_reconciliation_core', {
    p_interview_id: interviewId,
    p_authorization_id: authorizationId,
    p_request_id: boundedRequestId(requestId),
  });
  if (claimError) throw new Error('vendor_reconciliation_unavailable');
  const claim = firstRow(claimData);
  if (!claim?.claimed) {
    return { status: claim?.state || 'vendor_reconciliation_manual_review', claimed: false };
  }

  let lookup;
  try {
    lookup = await provider.findExactConversations(claim.vendor_external_reference);
  } catch (_) {
    lookup = boundedScanResult('unavailable');
  }
  if (!lookup || !Array.isArray(lookup.matches)) lookup = boundedScanResult('incomplete_malformed_page');

  if (lookup.complete === true && lookup.scan_status === 'complete' && lookup.matches.length === 1) {
    const match = lookup.matches[0];
    const status = await completeReconciliation(db, claim, {
      interviewId, authorizationId, requestId, lookup, outcome: 'resolved', match,
    });
    return { status: status || 'started', claimed: true, conversation_id: match.conversation_id, scan_status: 'complete' };
  }

  const outcome = lookup.complete === true
    ? (lookup.matches.length === 0 ? 'no_match' : 'multiple_matches')
    : 'unavailable';
  const status = await completeReconciliation(db, claim, {
    interviewId, authorizationId, requestId, lookup, outcome,
  });
  return {
    status: status || 'vendor_reconciliation_manual_review',
    claimed: true,
    match_count: lookup.complete === true ? lookup.matches.length : null,
    scan_status: lookup.scan_status || 'unavailable',
    scan_complete: lookup.complete === true,
  };
}

module.exports = {
  LIST_PAGE_SIZE,
  MAX_STORED_MATCH_REFERENCES,
  annotateTavusCreateError,
  classifyTavusCreateError,
  createTavusReadOnlyProvider,
  deterministicConversationName,
  reconcileAmbiguousTavusStart,
  validatePaginationMetadata,
};
