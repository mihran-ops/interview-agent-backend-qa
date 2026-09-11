'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  archivePublicLeadCapture,
  BULK_ARCHIVE_LIMIT,
  buildAdminPublicAnalyticsLeadsCsv,
  buildAdminPublicAnalyticsPayload,
  CSV_EXPORT_LIMIT,
  unarchivePublicLeadCapture,
  updatePublicLeadCaptureArchiveBatch,
} = require('../src/lib/adminPublicAnalyticsService');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.ranges = [];
    this.nullFilters = [];
    this.notNullFilters = [];
    this.orderField = null;
    this.ascending = false;
    this.limitCount = null;
    this.rangeFrom = null;
    this.rangeTo = null;
    this.updatePayload = null;
    this.singleMode = '';
  }

  select(columns) {
    this.db.selects.push({ table: this.table, columns: String(columns || '') });
    return this;
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value: String(value) });
    return this;
  }

  is(column, value) {
    if (value === null) this.nullFilters.push(column);
    return this;
  }

  not(column, operator, value) {
    if (operator === 'is' && value === null) this.notNullFilters.push(column);
    return this;
  }

  gte(column, value) {
    this.ranges.push({ type: 'gte', column, value: new Date(value).getTime() });
    return this;
  }

  lte(column, value) {
    this.ranges.push({ type: 'lte', column, value: new Date(value).getTime() });
    return this;
  }

  order(column, options = {}) {
    this.orderField = column;
    this.ascending = options.ascending === true;
    return this;
  }

  limit(count) {
    this.limitCount = Number(count || 0);
    return this;
  }

  range(from, to) {
    this.rangeFrom = Number(from || 0);
    this.rangeTo = Number(to || 0);
    return this;
  }

  update(payload) {
    this.updatePayload = { ...(payload || {}) };
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  execute() {
    let rows = (this.db.tables[this.table] || []).map((row) => ({ ...row }));
    for (const filter of this.filters) {
      if (filter.type === 'eq') {
        rows = rows.filter((row) => String(row[filter.column] || '') === filter.value);
      }
    }
    for (const range of this.ranges) {
      rows = rows.filter((row) => {
        const value = new Date(row[range.column] || '').getTime();
        if (!Number.isFinite(value)) return false;
        return range.type === 'gte' ? value >= range.value : value <= range.value;
      });
    }
    for (const column of this.nullFilters) {
      rows = rows.filter((row) => row[column] === null || row[column] === undefined || row[column] === '');
    }
    for (const column of this.notNullFilters) {
      rows = rows.filter((row) => row[column] !== null && row[column] !== undefined && row[column] !== '');
    }

    if (this.updatePayload) {
      const tableRows = this.db.tables[this.table] || [];
      const ids = new Set(rows.map((row) => String(row.id || '')));
      for (const row of tableRows) {
        if (ids.has(String(row.id || ''))) Object.assign(row, this.updatePayload);
      }
      rows = tableRows.filter((row) => ids.has(String(row.id || ''))).map((row) => ({ ...row }));
    }

    if (this.orderField) {
      rows.sort((a, b) => {
        const left = String(a[this.orderField] || '');
        const right = String(b[this.orderField] || '');
        return this.ascending ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    } else if (this.limitCount) {
      rows = rows.slice(0, this.limitCount);
    }
    if (this.singleMode === 'single') return { data: rows[0] || null, error: rows[0] ? null : { message: 'No rows returned' } };
    if (this.singleMode === 'maybeSingle') return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      reject(error);
    }
  }
}

function makeDb(tables = {}) {
  return {
    tables: {
      public_lead_drafts: [],
      public_analytics_events: [],
      ...tables,
    },
    selects: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

const NOW = new Date('2026-06-22T12:00:00.000Z');

test('admin public analytics route is registered behind admin auth and public write routes remain mounted', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin', 'publicAnalytics.js'), 'utf8');
  assert.match(routeSource, /router\.get\('\/public-analytics', requireAuth, requireAdmin/);
  assert.match(routeSource, /router\.get\('\/public-analytics\/leads\.csv', requireAuth, requireAdmin/);
  assert.match(routeSource, /router\.post\('\/public-analytics\/leads\/archive', requireAuth, requireAdmin/);
  assert.match(routeSource, /router\.post\('\/public-analytics\/leads\/unarchive', requireAuth, requireAdmin/);
  assert.match(routeSource, /router\.post\('\/public-analytics\/leads\/:id\/archive', requireAuth, requireAdmin/);
  assert.match(routeSource, /router\.post\('\/public-analytics\/leads\/:id\/unarchive', requireAuth, requireAdmin/);
  assert.match(routeSource, /Content-Disposition/);
  assert.match(routeSource, /X-Export-Row-Count/);
  assert.match(appSource, /app\.use\('\/api\/public-analytics', require\('\.\/routes\/publicAnalytics'\)\)/);
  assert.match(appSource, /app\.use\('\/api\/public-leads', require\('\.\/routes\/publicLeads'\)\)/);
});

test('admin public analytics archive filter defaults to active leads', async () => {
  const db = makeDb({
    public_lead_drafts: [
      {
        id: '10000000-1000-4000-8000-000000000001',
        status: 'submitted',
        email: 'active@example.com',
        source_path: '/alphascreen',
        archived_at: null,
        created_at: '2026-06-21T09:00:00.000Z',
        updated_at: '2026-06-21T10:00:00.000Z',
      },
      {
        id: '10000000-1000-4000-8000-000000000002',
        status: 'submitted',
        email: 'archived@example.com',
        source_path: '/alphascreen',
        archived_at: '2026-06-22T10:00:00.000Z',
        archive_reason: 'No longer relevant',
        created_at: '2026-06-21T08:00:00.000Z',
        updated_at: '2026-06-21T09:00:00.000Z',
      },
    ],
  });

  const activePayload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30' },
  });
  const archivedPayload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30', archive_status: 'archived' },
  });
  const allPayload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30', archive_status: 'all' },
  });

  assert.equal(activePayload.filters.archive_status, 'active');
  assert.deepEqual(activePayload.leads.items.map((lead) => lead.id), ['10000000-1000-4000-8000-000000000001']);
  assert.equal(activePayload.summary.submitted_leads, 1);
  assert.equal(archivedPayload.filters.archive_status, 'archived');
  assert.deepEqual(archivedPayload.leads.items.map((lead) => lead.id), ['10000000-1000-4000-8000-000000000002']);
  assert.equal(archivedPayload.leads.items[0].archived, true);
  assert.equal(archivedPayload.leads.items[0].archive_reason, 'No longer relevant');
  assert.equal(allPayload.filters.archive_status, 'all');
  assert.deepEqual(allPayload.leads.items.map((lead) => lead.id), [
    '10000000-1000-4000-8000-000000000001',
    '10000000-1000-4000-8000-000000000002',
  ]);
});

test('admin public analytics payload returns sanitized leads and events', async () => {
  const db = makeDb({
    public_lead_drafts: [
      {
        id: 'lead-submitted',
        status: 'submitted',
        form_id: 'demo-form',
        form_type: 'demo',
        product_interest: 'alphaScreen',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'lead@example.com',
        phone: '+1 555 111 2222',
        message: 'Please follow up. Secret token sk-live-raw and person@example.com should not leak.',
        fields_completed: ['first_name', 'email', 'message'],
        last_field: 'message',
        source_path: '/alphascreen?utm_source=ad',
        source_referrer_path: 'https://www.alphasourceai.com/about?x=1',
        source_cta: 'hero-demo',
        utm: { utm_source: 'linkedin', email: 'utm@example.com', token: 'raw-token' },
        anonymous_id: 'anonymous-raw',
        session_id: 'session-raw',
        request_id: 'request-raw',
        privacy_notice_version: '2026-06',
        submitted_at: '2026-06-21T10:00:00.000Z',
        expires_at: '2026-09-21T10:00:00.000Z',
        created_at: '2026-06-21T09:45:00.000Z',
        updated_at: '2026-06-21T10:00:00.000Z',
      },
      {
        id: 'lead-partial',
        status: 'partial',
        email: 'partial@example.com',
        message: 'Partial draft message should not be shown.',
        fields_completed: ['email'],
        source_path: '/about',
        created_at: '2026-06-20T09:45:00.000Z',
        updated_at: '2026-06-20T10:00:00.000Z',
      },
    ],
    public_analytics_events: [
      {
        id: 'event-1',
        event_name: 'lead_form_submit',
        path: '/alphascreen',
        page_title: 'alphaScreen',
        referrer_path: '/about',
        utm: { utm_source: 'linkedin', secret: 'raw-secret' },
        properties: {
          cta_id: 'hero',
          scroll_depth: 75,
          email: 'metadata@example.com',
          token: 'raw-token',
          nested: { raw: 'payload' },
        },
        anonymous_id: 'anonymous-event',
        session_id: 'session-event',
        request_id: 'request-event',
        occurred_at: '2026-06-21T10:05:00.000Z',
        created_at: '2026-06-21T10:06:00.000Z',
      },
      {
        id: 'event-2',
        event_name: 'cta_clicked',
        path: '/',
        properties: {
          cta_label: 'Request a Demo',
          cta_target: '/alphascreen',
          placement: 'hero',
          email: 'cta@example.com',
        },
        occurred_at: '2026-06-21T10:04:00.000Z',
        created_at: '2026-06-21T10:04:30.000Z',
      },
      {
        id: 'event-3',
        event_name: 'lead_form_started',
        path: '/alphascreen',
        properties: {
          form_id: 'home-contact',
          form_type: 'contact',
          first_field: 'email',
        },
        occurred_at: '2026-06-21T10:03:00.000Z',
        created_at: '2026-06-21T10:03:30.000Z',
      },
    ],
  });

  const payload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30', limit: '25' },
    requestId: 'admin-request',
  });

  assert.equal(payload.summary.submitted_leads, 1);
  assert.equal(payload.summary.draft_or_partial_leads, 1);
  assert.equal(payload.summary.public_analytics_events, 3);
  assert.equal(payload.summary.most_active_page.display_name, 'alphaScreen');
  assert.equal(payload.leads.items[0].message_preview.includes('[redacted]'), true);
  assert.equal(payload.leads.items[1].message_preview, null);
  assert.deepEqual(payload.events.items[0].metadata_summary, [
    { key: 'cta_id', value: 'hero' },
    { key: 'scroll_depth', value: '75' },
    { key: 'nested', value: 'object' },
  ]);
  assert.deepEqual(payload.insights.cta_activity[0], {
    label: 'Request a Demo',
    placement: 'hero',
    target_path: '/alphascreen',
    count: 1,
    last_clicked_at: '2026-06-21T10:04:00.000Z',
  });
  assert.equal(payload.insights.page_activity[0].display_name, 'alphaScreen');
  assert.equal(payload.insights.page_activity[0].form_activity, 2);
  assert.equal(payload.insights.form_activity.some((item) => item.form_id === 'home-contact'), true);
  assert.equal(payload.insights.event_types.some((item) => item.event_name === 'cta_clicked' && item.count === 1), true);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /anonymous-raw|session-raw|request-raw|anonymous-event|session-event|request-event/i);
  assert.doesNotMatch(serialized, /sk-live-raw|person@example\.com|utm@example\.com|metadata@example\.com|cta@example\.com|raw-token|raw-secret|Partial draft message/i);
});

test('admin public analytics supports filters and page-size pagination without raw payloads', async () => {
  const db = makeDb({
    public_lead_drafts: [
      { id: 'lead-1', status: 'submitted', email: 'a@example.com', source_path: '/alphascreen', updated_at: '2026-06-21T10:00:00.000Z', created_at: '2026-06-21T10:00:00.000Z' },
      { id: 'lead-2', status: 'partial', email: 'b@example.com', source_path: '/alphascreen', updated_at: '2026-06-21T09:00:00.000Z', created_at: '2026-06-21T09:00:00.000Z' },
      { id: 'lead-3', status: 'submitted', email: 'c@example.com', source_path: '/about', updated_at: '2026-06-21T08:00:00.000Z', created_at: '2026-06-21T08:00:00.000Z' },
    ],
    public_analytics_events: [
      { id: 'event-1', event_name: 'page_view', path: '/alphascreen', properties: { section: 'hero' }, occurred_at: '2026-06-21T10:00:00.000Z', created_at: '2026-06-21T10:00:00.000Z' },
      { id: 'event-2', event_name: 'page_view', path: '/alphascreen', properties: { section: 'pricing' }, occurred_at: '2026-06-21T09:00:00.000Z', created_at: '2026-06-21T09:00:00.000Z' },
      { id: 'event-3', event_name: 'page_view', path: '/alphascreen', properties: { section: 'faq' }, occurred_at: '2026-06-21T08:00:00.000Z', created_at: '2026-06-21T08:00:00.000Z' },
      { id: 'event-4', event_name: 'cta_click', path: '/about', properties: { section: 'footer' }, occurred_at: '2026-06-21T07:00:00.000Z', created_at: '2026-06-21T07:00:00.000Z' },
    ],
  });

  const payload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: {
      date_from: '2026-06-20',
      date_to: '2026-06-22',
      status: 'submitted',
      event_name: 'page_view',
      path: '/alphascreen?ignored=true',
      lead_limit: '1',
      event_limit: '2',
    },
  });

  assert.equal(payload.filters.lead_status, 'submitted');
  assert.equal(payload.filters.event_name, 'page_view');
  assert.equal(payload.filters.path, '/alphascreen');
  assert.equal(payload.leads.items.length, 1);
  assert.equal(payload.leads.items[0].id, 'lead-1');
  assert.equal(payload.leads.pagination.has_more, false);
  assert.equal(payload.events.items.length, 2);
  assert.equal(payload.events.pagination.has_more, true);
  assert.deepEqual(payload.events.items.map((item) => item.id), ['event-1', 'event-2']);
});

test('admin public analytics lead CSV export is sanitized and respects filters', async () => {
  const db = makeDb({
    public_lead_drafts: [
      {
        id: 'lead-export-1',
        status: 'submitted',
        form_id: 'demo-form',
        form_type: 'demo',
        product_interest: 'alphaScreen',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'lead@example.com',
        phone: '+1 555 111 2222',
        message: '=Formula token sk-live-raw person@example.com 555-111-2222',
        fields_completed: ['first_name', 'email', 'message'],
        last_field: 'message',
        source_path: '/alphascreen',
        source_cta: 'hero-demo',
        anonymous_id: 'anonymous-raw',
        session_id: 'session-raw',
        request_id: 'request-raw',
        submitted_at: '2026-06-21T10:00:00.000Z',
        created_at: '2026-06-21T09:45:00.000Z',
        updated_at: '2026-06-21T10:00:00.000Z',
      },
      {
        id: 'lead-export-2',
        status: 'partial',
        email: 'partial@example.com',
        message: 'Partial draft message should not export.',
        fields_completed: ['email'],
        source_path: '/alphascreen',
        created_at: '2026-06-21T09:00:00.000Z',
        updated_at: '2026-06-21T09:00:00.000Z',
      },
      {
        id: 'lead-export-3',
        status: 'submitted',
        email: 'other@example.com',
        source_path: '/about',
        created_at: '2026-06-21T08:00:00.000Z',
        updated_at: '2026-06-21T08:00:00.000Z',
      },
    ],
  });

  const payload = await buildAdminPublicAnalyticsLeadsCsv({
    db,
    now: NOW,
    query: {
      date_from: '2026-06-20',
      date_to: '2026-06-22',
      status: 'submitted',
      path: '/alphascreen?ignored=true',
    },
  });

  assert.equal(payload.content_type, 'text/csv; charset=utf-8');
  assert.equal(payload.filename, 'public-leads-2026-06-20-to-2026-06-22-submitted-active.csv');
  assert.equal(payload.row_count, 1);
  assert.equal(payload.truncated, false);
  assert.match(payload.csv, /^created_at,updated_at,status,submitted,submitted_at,source_page,source_path/m);
  assert.match(payload.csv, /lead@example\.com/);
  assert.match(payload.csv, /alphaScreen,\/alphascreen/);
  assert.match(payload.csv, /hero-demo/);
  assert.match(payload.csv, /\[redacted\]/);

  assert.doesNotMatch(payload.csv, /lead-export-1|anonymous-raw|session-raw|request-raw/i);
  assert.doesNotMatch(payload.csv, /sk-live-raw|person@example\.com|555-111-2222|Partial draft message|partial@example\.com|other@example\.com/i);
  assert.doesNotMatch(payload.csv, /^=/m);
});

test('admin public analytics lead CSV excludes archived leads by default and can include archived', async () => {
  const db = makeDb({
    public_lead_drafts: [
      {
        id: '10000000-1000-4000-8000-000000000011',
        status: 'submitted',
        email: 'active@example.com',
        source_path: '/alphascreen',
        archived_at: null,
        created_at: '2026-06-21T09:00:00.000Z',
        updated_at: '2026-06-21T10:00:00.000Z',
      },
      {
        id: '10000000-1000-4000-8000-000000000012',
        status: 'submitted',
        email: 'archived@example.com',
        source_path: '/alphascreen',
        archived_at: '2026-06-22T10:00:00.000Z',
        archive_reason: 'Manual admin archive',
        created_at: '2026-06-21T08:00:00.000Z',
        updated_at: '2026-06-21T09:00:00.000Z',
      },
    ],
  });

  const activePayload = await buildAdminPublicAnalyticsLeadsCsv({
    db,
    now: NOW,
    query: { days: '30' },
  });
  const archivedPayload = await buildAdminPublicAnalyticsLeadsCsv({
    db,
    now: NOW,
    query: { days: '30', archive_status: 'archived' },
  });
  const allPayload = await buildAdminPublicAnalyticsLeadsCsv({
    db,
    now: NOW,
    query: { days: '30', archive_status: 'all' },
  });

  assert.equal(activePayload.row_count, 1);
  assert.match(activePayload.csv, /active@example\.com/);
  assert.doesNotMatch(activePayload.csv, /archived@example\.com|Manual admin archive/i);
  assert.equal(archivedPayload.row_count, 1);
  assert.match(archivedPayload.csv, /archived@example\.com/);
  assert.match(archivedPayload.csv, /archived,2026-06-22T10:00:00.000Z,Manual admin archive/);
  assert.equal(allPayload.row_count, 2);
  assert.match(allPayload.csv, /active@example\.com/);
  assert.match(allPayload.csv, /archived@example\.com/);
});

test('admin public analytics archive and unarchive are idempotent and preserve lead data', async () => {
  const db = makeDb({
    public_lead_drafts: [
      {
        id: '10000000-1000-4000-8000-000000000021',
        status: 'submitted',
        email: 'lead@example.com',
        phone: '+1 555 111 2222',
        message: 'Submitted message remains on the record.',
        source_path: '/alphascreen',
        fields_completed: ['email', 'phone', 'message'],
        archived_at: null,
        created_at: '2026-06-21T09:00:00.000Z',
        updated_at: '2026-06-21T10:00:00.000Z',
      },
    ],
  });

  const archived = await archivePublicLeadCapture({
    db,
    leadId: '10000000-1000-4000-8000-000000000021',
    actorUserId: 'admin-user-1',
    reason: 'Handled',
    now: new Date('2026-06-22T10:00:00.000Z'),
    requestId: 'req-archive',
  });
  const archivedAgain = await archivePublicLeadCapture({
    db,
    leadId: '10000000-1000-4000-8000-000000000021',
    actorUserId: 'admin-user-2',
    reason: 'Should not overwrite',
    now: new Date('2026-06-23T10:00:00.000Z'),
    requestId: 'req-archive-again',
  });
  const activePayload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30' },
  });
  const archivedPayload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30', archive_status: 'archived' },
  });
  const unarchived = await unarchivePublicLeadCapture({
    db,
    leadId: '10000000-1000-4000-8000-000000000021',
    requestId: 'req-unarchive',
  });
  const unarchivedAgain = await unarchivePublicLeadCapture({
    db,
    leadId: '10000000-1000-4000-8000-000000000021',
    requestId: 'req-unarchive-again',
  });
  const restoredPayload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30' },
  });

  assert.equal(archived.ok, true);
  assert.equal(archived.item.archived, true);
  assert.equal(archived.item.archived_at, '2026-06-22T10:00:00.000Z');
  assert.equal(archived.item.archive_reason, 'Handled');
  assert.equal(archivedAgain.item.archived_at, '2026-06-22T10:00:00.000Z');
  assert.equal(archivedAgain.item.archive_reason, 'Handled');
  assert.deepEqual(activePayload.leads.items, []);
  assert.equal(archivedPayload.leads.items[0].id, '10000000-1000-4000-8000-000000000021');
  assert.equal(unarchived.item.archived, false);
  assert.equal(unarchived.item.archived_at, null);
  assert.equal(unarchivedAgain.item.archived, false);
  assert.equal(restoredPayload.leads.items[0].id, '10000000-1000-4000-8000-000000000021');
  assert.equal(db.tables.public_lead_drafts.length, 1);
  assert.equal(db.tables.public_lead_drafts[0].email, 'lead@example.com');
  assert.equal(db.tables.public_lead_drafts[0].message, 'Submitted message remains on the record.');
});

test('admin public analytics bulk archive and unarchive selected leads safely', async () => {
  const db = makeDb({
    public_lead_drafts: [
      {
        id: '10000000-1000-4000-8000-000000000031',
        status: 'submitted',
        email: 'lead-one@example.com',
        source_path: '/alphascreen',
        archived_at: null,
        created_at: '2026-06-21T09:00:00.000Z',
        updated_at: '2026-06-21T10:00:00.000Z',
      },
      {
        id: '10000000-1000-4000-8000-000000000032',
        status: 'partial',
        email: 'lead-two@example.com',
        source_path: '/alphascreen',
        archived_at: null,
        created_at: '2026-06-21T08:00:00.000Z',
        updated_at: '2026-06-21T09:00:00.000Z',
      },
      {
        id: '10000000-1000-4000-8000-000000000033',
        status: 'submitted',
        email: 'already-archived@example.com',
        source_path: '/alphascreen',
        archived_at: '2026-06-22T09:00:00.000Z',
        archive_reason: 'Handled earlier',
        created_at: '2026-06-21T07:00:00.000Z',
        updated_at: '2026-06-21T08:00:00.000Z',
      },
    ],
  });

  const archived = await updatePublicLeadCaptureArchiveBatch({
    db,
    leadIds: [
      '10000000-1000-4000-8000-000000000031',
      '10000000-1000-4000-8000-000000000032',
      '10000000-1000-4000-8000-000000000033',
    ],
    archive: true,
    actorUserId: 'admin-user-1',
    reason: 'Selected in admin',
    now: new Date('2026-06-22T10:00:00.000Z'),
    requestId: 'req-bulk-archive',
  });
  const activeAfterArchive = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30' },
  });
  const archivedAfterArchive = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30', archive_status: 'archived' },
  });
  const unarchived = await updatePublicLeadCaptureArchiveBatch({
    db,
    leadIds: [
      '10000000-1000-4000-8000-000000000031',
      '10000000-1000-4000-8000-000000000032',
    ],
    archive: false,
    requestId: 'req-bulk-unarchive',
  });
  const activeAfterUnarchive = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30' },
  });

  assert.deepEqual(archived, {
    ok: true,
    requested_count: 3,
    updated_count: 2,
    skipped_count: 1,
    request_id: 'req-bulk-archive',
  });
  assert.deepEqual(activeAfterArchive.leads.items, []);
  assert.deepEqual(archivedAfterArchive.leads.items.map((lead) => lead.id), [
    '10000000-1000-4000-8000-000000000031',
    '10000000-1000-4000-8000-000000000032',
    '10000000-1000-4000-8000-000000000033',
  ]);
  assert.equal(db.tables.public_lead_drafts.length, 3);
  assert.equal(db.tables.public_lead_drafts[0].email, 'lead-one@example.com');
  assert.equal(archivedAfterArchive.leads.items[0].archived_at, '2026-06-22T10:00:00.000Z');
  assert.equal(db.tables.public_lead_drafts[2].archive_reason, 'Handled earlier');
  assert.deepEqual(unarchived, {
    ok: true,
    requested_count: 2,
    updated_count: 2,
    skipped_count: 0,
    request_id: 'req-bulk-unarchive',
  });
  assert.deepEqual(activeAfterUnarchive.leads.items.map((lead) => lead.id), [
    '10000000-1000-4000-8000-000000000031',
    '10000000-1000-4000-8000-000000000032',
  ]);
  assert.equal(db.tables.public_lead_drafts[0].archived_at, null);
});

test('admin public analytics bulk archive rejects invalid and oversized selections', async () => {
  const db = makeDb();
  await assert.rejects(
    () => updatePublicLeadCaptureArchiveBatch({
      db,
      leadIds: ['not-a-valid-id'],
      archive: true,
      requestId: 'req-invalid',
    }),
    (error) => error.status === 400 && error.code === 'invalid_public_lead_id'
  );
  await assert.rejects(
    () => updatePublicLeadCaptureArchiveBatch({
      db,
      leadIds: [],
      archive: true,
      requestId: 'req-empty',
    }),
    (error) => error.status === 400 && error.code === 'public_lead_ids_required'
  );
  await assert.rejects(
    () => updatePublicLeadCaptureArchiveBatch({
      db,
      leadIds: Array.from({ length: BULK_ARCHIVE_LIMIT + 1 }, (_, index) => `10000000-1000-4000-8000-${String(index).padStart(12, '0')}`),
      archive: true,
      requestId: 'req-too-many',
    }),
    (error) => error.status === 400 && error.code === 'too_many_public_lead_ids'
  );
  assert.deepEqual(db.tables.public_lead_drafts, []);
});

test('admin public analytics lead CSV export is bounded', async () => {
  const publicLeadDrafts = Array.from({ length: CSV_EXPORT_LIMIT + 5 }, (_, index) => ({
    id: `lead-${index}`,
    status: 'submitted',
    email: `lead${index}@example.com`,
    source_path: '/alphascreen',
    created_at: '2026-06-21T08:00:00.000Z',
    updated_at: `2026-06-21T08:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }));
  const db = makeDb({ public_lead_drafts: publicLeadDrafts });

  const payload = await buildAdminPublicAnalyticsLeadsCsv({
    db,
    now: NOW,
    query: { days: '30' },
  });

  assert.equal(payload.row_count, CSV_EXPORT_LIMIT);
  assert.equal(payload.truncated, true);
  assert.equal(payload.csv.trim().split('\n').length, CSV_EXPORT_LIMIT + 1);
});
