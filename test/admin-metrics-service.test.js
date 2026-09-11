'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildAdminMetricsPayload,
  normalizeEmailEvent,
} = require('../src/services/adminMetricsService');
const { buildOpenAIHealth } = require('../src/health/openaiHealth');
const { buildTavusHealth } = require('../src/health/tavusHealth');
const { buildRenderHealth } = require('../src/health/renderHealth');
const { buildSupabaseHealth } = require('../src/health/supabaseHealth');
const { buildSendGridHealth } = require('../src/health/sendgridHealth');
const { buildSentryHealth } = require('../src/health/sentryHealth');

const PLATFORM_HEALTH_FILES = [
  'index.js',
  'openaiHealth.js',
  'tavusHealth.js',
  'supabaseHealth.js',
  'sendgridHealth.js',
  'renderHealth.js',
  'sentryHealth.js',
  'awsS3Health.js',
  'stripeHealth.js',
  'normalizePlatformHealth.js',
];

const TABLE_NAMES = [
  'clients',
  'roles',
  'candidates',
  'interviews',
  'reports',
  'interview_perception_events',
  'email_delivery_events',
  'automation_action_approval_tokens',
  'automation_digest_approval_tokens',
  'contract_cancellation_runs',
];

function emptyTables() {
  return Object.fromEntries(TABLE_NAMES.map((name) => [name, []]));
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.ranges = [];
    this.orderField = null;
    this.ascending = false;
    this.limitCount = null;
  }

  select(columns) {
    this.db.selects.push({ table: this.table, columns: String(columns || '') });
    return this;
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value: String(value) });
    return this;
  }

  in(column, values) {
    this.filters.push({ type: 'in', column, values: new Set((values || []).map(String)) });
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
    this.limitCount = count;
    return this;
  }

  execute() {
    let rows = (this.db.tables[this.table] || []).map((row) => ({ ...row }));
    for (const filter of this.filters) {
      if (filter.type === 'eq') {
        rows = rows.filter((row) => String(row[filter.column] || '') === filter.value);
      } else if (filter.type === 'in') {
        rows = rows.filter((row) => filter.values.has(String(row[filter.column] || '')));
      }
    }
    for (const range of this.ranges) {
      rows = rows.filter((row) => {
        const value = new Date(row[range.column] || '').getTime();
        if (!Number.isFinite(value)) return false;
        return range.type === 'gte' ? value >= range.value : value <= range.value;
      });
    }
    if (this.orderField) {
      rows.sort((a, b) => {
        const left = String(a[this.orderField] || '');
        const right = String(b[this.orderField] || '');
        return this.ascending ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    if (this.limitCount) rows = rows.slice(0, this.limitCount);
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

function makeDb(tables = emptyTables()) {
  return {
    tables,
    selects: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

function serviceByKey(payload, key) {
  return (payload.services || []).find((service) => service.key === key) || null;
}

function openAIHealthContext(overrides = {}) {
  const now = new Date('2026-06-18T12:00:00.000Z');
  return {
    now,
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
    },
    dateRange: {
      from: new Date('2026-06-11T12:00:00.000Z'),
      to: now,
      date_from: '2026-06-11T12:00:00.000Z',
      date_to: '2026-06-18T12:00:00.000Z',
    },
    signals: {
      missingReports: 0,
      reports: [],
      completedInterviews: [],
      lastReportAt: null,
    },
    liveChecksEnabled: true,
    cacheEnabled: false,
    ...overrides,
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
      ...(overrides.env || {}),
    },
  };
}

function renderHealthContext(overrides = {}) {
  return {
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
    liveChecksEnabled: true,
    cacheEnabled: false,
    ...overrides,
    env: {
      ...(overrides.env || {}),
    },
  };
}

function renderStatusSummary(overrides = {}) {
  return {
    page: {
      updated_at: '2026-06-18T11:45:00.000Z',
    },
    status: {
      indicator: 'none',
      description: 'All Systems Operational',
    },
    components: [],
    incidents: [],
    scheduled_maintenances: [],
    ...overrides,
  };
}

function sendGridStatusSummary(overrides = {}) {
  return {
    page: {
      updated_at: '2026-06-18T11:50:00.000Z',
    },
    status: {
      indicator: 'none',
      description: 'All Systems Operational',
    },
    components: [],
    incidents: [],
    scheduled_maintenances: [],
    ...overrides,
  };
}

function sendGridHealthContext(overrides = {}) {
  const now = new Date('2026-06-18T12:00:00.000Z');
  return {
    now,
    env: {
      ...(overrides.env || {}),
    },
    dateRange: {
      from: new Date('2026-06-11T12:00:00.000Z'),
      to: now,
      date_from: '2026-06-11T12:00:00.000Z',
      date_to: '2026-06-18T12:00:00.000Z',
    },
    signals: {
      emailProblems: 0,
      emailProblemPercent: 0,
      emailCategoryCounts: {},
      emailEvents: [],
      lastEmailEventAt: null,
      ...(overrides.signals || {}),
    },
    liveChecksEnabled: true,
    cacheEnabled: overrides.cacheEnabled === undefined ? false : overrides.cacheEnabled,
    cacheTtlMs: overrides.cacheTtlMs,
    fetchImpl: overrides.fetchImpl,
    timeoutMs: overrides.timeoutMs,
  };
}

function sentryHealthContext(overrides = {}) {
  const now = new Date('2026-06-18T12:00:00.000Z');
  return {
    now,
    env: {
      ...(overrides.env || {}),
    },
    dateRange: {
      from: new Date('2026-06-11T12:00:00.000Z'),
      to: now,
      date_from: '2026-06-11T12:00:00.000Z',
      date_to: '2026-06-18T12:00:00.000Z',
    },
    liveChecksEnabled: true,
    cacheEnabled: false,
    fetchImpl: overrides.fetchImpl,
    timeoutMs: overrides.timeoutMs,
  };
}

function supabaseHealthContext(overrides = {}) {
  const now = new Date('2026-06-18T12:00:00.000Z');
  return {
    now,
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-secret',
      ...(overrides.env || {}),
    },
    dateRange: {
      from: new Date('2026-06-11T12:00:00.000Z'),
      to: now,
      date_from: '2026-06-11T12:00:00.000Z',
      date_to: '2026-06-18T12:00:00.000Z',
    },
    db: overrides.db || makeDb(),
    signals: {
      clients: [{ id: 'client-1' }],
      roles: [{ id: 'role-1' }],
      candidates: [{ id: 'candidate-1' }],
      ...(overrides.signals || {}),
    },
    warnings: overrides.warnings || [],
    liveChecksEnabled: true,
    cacheEnabled: false,
    fetchImpl: overrides.fetchImpl,
    timeoutMs: overrides.timeoutMs,
  };
}

function tavusHealthContext(overrides = {}) {
  const now = new Date('2026-06-18T12:00:00.000Z');
  const rows = {
    interviews: [],
    ...(overrides.rows || {}),
  };
  const signals = {
    interviews: rows.interviews,
    recordingReady: 0,
    transcriptReady: [],
    perceptionEvents: [],
    estimatedMinutes: null,
    recordingPending: 0,
    recordingProblems: 0,
    recordingDeleted: 0,
    perceptionMissing: 0,
    lastTavusWebhookAt: null,
    ...(overrides.signals || {}),
  };
  return {
    now,
    env: {
      TAVUS_API_KEY: 'tavus-secret',
      TAVUS_WEBHOOK_SECRET: Buffer.alloc(32, 13).toString('base64url'),
      ...(overrides.env || {}),
    },
    dateRange: {
      from: new Date('2026-06-11T12:00:00.000Z'),
      to: now,
      date_from: '2026-06-11T12:00:00.000Z',
      date_to: '2026-06-18T12:00:00.000Z',
    },
    rows,
    signals,
    liveChecksEnabled: true,
    cacheEnabled: false,
    fetchImpl: overrides.fetchImpl || (async (url) => {
      if (String(url).includes('/conversations')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [] }),
        };
      }
      throw new Error('unexpected_url');
    }),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['env', 'rows', 'signals', 'fetchImpl'].includes(key))),
  };
}

test('GET /admin/metrics route is registered behind admin auth', () => {
  const routePath = path.resolve(__dirname, '../src/routes/admin/metrics.js');
  const source = fs.readFileSync(routePath, 'utf8');
  assert.match(source, /router\.get\('\/metrics', requireAuth, requireAdmin/);
});

test('platform health adapter framework includes all required service files', () => {
  for (const file of PLATFORM_HEALTH_FILES) {
    const fullPath = path.resolve(__dirname, '../src/health', file);
    assert.equal(fs.existsSync(fullPath), true, `${file} should exist`);
  }
});

test('admin metrics returns platform-only service shape with all required services', async () => {
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: {},
    requestId: 'req-empty',
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
    liveChecksEnabled: false,
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.request_id, 'req-empty');
  assert.equal(payload.filters.date_range, '30d');
  assert.equal(payload.filters.selected_client_id, undefined);
  assert.equal(payload.filters.entity_filter, undefined);
  assert.equal(payload.filters.role_id, undefined);
  assert.deepEqual(payload.services.map((service) => service.key), [
    'openai',
    'tavus',
    'supabase',
    'sendgrid',
    'render',
    'sentry',
    'aws_s3',
    'stripe',
  ]);
  assert.equal(payload.status_cards.length, 8);
  assert.equal(payload.integration_readiness.length, 8);
  assert.equal(payload.attention, undefined);
  assert.equal(payload.entity_operations, undefined);
  assert.equal(payload.interview_funnel, undefined);
  assert.equal(payload.email, undefined);
  assert.equal(serviceByKey(payload, 'render').status, 'not_configured');
  assert.equal(serviceByKey(payload, 'sentry').status, 'not_configured');
  for (const service of payload.services) {
    assert.equal(typeof service.connection_label, 'string');
    assert.equal(typeof service.source_label, 'string');
    assert.equal(typeof service.meaning, 'string');
    assert.ok(Array.isArray(service.usage_summary));
    assert.ok(Array.isArray(service.problem_summary));
    assert.ok(Array.isArray(service.readiness_items));
    assert.equal(typeof service.live_api_connected, 'boolean');
  }
});

test('admin metrics applies platform date range filters and preserves interview completion bug fix', async () => {
  const tables = emptyTables();
  tables.clients.push(
    { id: 'client-1', name: 'Espire Dental', parent_client_id: null, archived_at: null, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', subscription_status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'client-2', name: 'Other Client', parent_client_id: null, archived_at: null, created_at: '2026-01-01T00:00:00.000Z' },
  );
  tables.roles.push({ id: 'role-1', client_id: 'client-1', title: 'Dental Assistant', status: 'active', created_at: '2026-05-01T00:00:00.000Z' });
  tables.candidates.push(
    { id: 'candidate-in', client_id: 'client-1', role_id: 'role-1', status: 'Interview Completed', interview_status: 'Interview Completed', created_at: '2026-06-10T10:00:00.000Z' },
    { id: 'candidate-out', client_id: 'client-1', role_id: 'role-1', status: 'Interview Completed', interview_status: 'Interview Completed', created_at: '2026-04-10T10:00:00.000Z' },
  );
  tables.interviews.push(
    { id: 'interview-in', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-in', created_at: '2026-06-10T11:00:00.000Z', updated_at: '2026-06-10T12:00:00.000Z', status: 'completed', transcript: 'ready', recording_status: 'ready', recording_ready_at: '2026-06-10T12:10:00.000Z', recording_metadata: { duration_seconds: 600 } },
    { id: 'interview-out', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-out', created_at: '2026-04-10T11:00:00.000Z', updated_at: '2026-04-10T12:00:00.000Z', status: 'completed' },
  );
  tables.reports.push(
    { id: 'report-in', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-in', created_at: '2026-06-10T12:20:00.000Z' },
    { id: 'report-out', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-out', created_at: '2026-04-10T12:20:00.000Z' },
  );
  tables.interview_perception_events.push({ id: 'event-1', client_id: 'client-1', interview_id: 'interview-in', event_type: 'application.perception_analysis', received_at: '2026-06-10T12:15:00.000Z' });
  tables.email_delivery_events.push(
    { id: 'email-in', created_at: '2026-06-11T00:00:00.000Z', event_type: 'bounce', is_problem: true },
    { id: 'email-out', created_at: '2026-04-11T00:00:00.000Z', event_type: 'bounce', is_problem: true },
  );

  const db = makeDb(tables);
  const payload = await buildAdminMetricsPayload({
    db,
    query: { client_id: 'ignored-client', entity_filter: 'ignored-entity', role_id: 'ignored-role', date_range: '30d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
    liveChecksEnabled: false,
  });

  assert.equal(payload.filters.date_range, '30d');
  assert.equal(payload.filters.selected_client_id, undefined);
  assert.equal(serviceByKey(payload, 'openai').usage.find((row) => row.label === 'Reports generated').value, 1);
  assert.equal(serviceByKey(payload, 'tavus').usage.find((row) => row.label === 'Interview starts').value, 1);
  assert.equal(serviceByKey(payload, 'tavus').usage.find((row) => row.label === 'Estimated minutes').value, 10);
  assert.equal(serviceByKey(payload, 'sendgrid').errors.find((row) => row.label === 'Delivery diagnostics').value, 'Audit Logs');
  assert.equal(serviceByKey(payload, 'sendgrid').errors.find((row) => row.label === 'Bounces'), undefined);
  const interviewSelect = db.selects.find((entry) => entry.table === 'interviews')?.columns || '';
  assert.doesNotMatch(interviewSelect, /completed_at|interview_status/);
  assert.match(interviewSelect, /\bstatus\b/);
});

test('admin metrics response does not expose raw secrets, tokens, raw links, or raw event lists', async () => {
  const tables = emptyTables();
  tables.clients.push({ id: 'client-1', name: 'Espire Dental', parent_client_id: null, archived_at: null });
  tables.automation_action_approval_tokens.push({
    id: 'token-1',
    client_id: 'client-1',
    token_hash: 'super-secret-token-hash',
    recipient_email: 'reviewer@example.com',
    created_at: '2026-06-12T00:00:00.000Z',
  });
  tables.automation_digest_approval_tokens.push({
    id: 'digest-token-1',
    client_id: 'client-1',
    token_hash: 'super-secret-digest-token-hash',
    item_salt: 'secret-salt',
    recipient_email: 'digest@example.com',
    created_at: '2026-06-12T00:00:00.000Z',
  });
  tables.email_delivery_events.push({
    id: 'email-1',
    created_at: '2026-06-12T00:00:00.000Z',
    event_type: 'bounce',
    is_problem: true,
    reason: 'Failed for person@example.com at https://example.test/review?token=raw',
    raw_payload: 'raw-sendgrid-payload',
  });

  const db = makeDb(tables);
  const payload = await buildAdminMetricsPayload({
    db,
    query: { date_range: '30d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_API_KEY: 'sk-test-secret',
      TAVUS_API_KEY: 'tavus-secret',
      SENDGRID_API_KEY: 'sendgrid-secret',
      SUPABASE_SERVICE_ROLE_KEY: 'supabase-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      RENDER_API_KEY: 'render-secret',
      SENTRY_DSN: 'sentry-dsn-secret',
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      AWS_ACCESS_KEY_ID: 'aws-access-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key-secret',
      STRIPE_SECRET_KEY: 'stripe-secret',
      STRIPE_WEBHOOK_SECRET: 'stripe-webhook-secret',
      AUTOMATION_DIGEST_RUNNER_SECRET: 'scheduler-secret',
      SENTRY_ENABLED: '1',
    },
    liveChecksEnabled: false,
  });
  const serialized = JSON.stringify(payload);

  assert.equal(db.selects.some((entry) => entry.table === 'automation_action_approval_tokens'), false);
  assert.equal(db.selects.some((entry) => entry.table === 'automation_digest_approval_tokens'), false);
  assert.equal(payload.services.find((service) => service.key === 'sendgrid').recent_problem_events, undefined);
  assert.equal(payload.services.find((service) => service.key === 'sendgrid').events, undefined);
  assert.doesNotMatch(serialized, /super-secret|raw-sendgrid-payload|reviewer@example\.com|digest@example\.com|person@example\.com|https:\/\/example\.test|sk-test-secret|tavus-secret|sendgrid-secret|supabase-secret|render-secret|sentry-dsn-secret|sentry-token-secret|aws-access-secret|aws-secret-key-secret|stripe-secret|stripe-webhook-secret|scheduler-secret/i);
  assert.doesNotMatch(serialized, /api_key|webhook_secret|service_role|private_key|access_key|approval_token|digest_token|token_hash|item_salt|raw_payload|bearer/i);
});

test('admin metrics marks missing live integrations as not connected without fake usage', async () => {
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
    liveChecksEnabled: false,
  });

  assert.equal(payload.filters.date_range, '7d');
  assert.equal(serviceByKey(payload, 'render').source_label, 'Configuration check');
  assert.equal(serviceByKey(payload, 'sentry').source_label, 'Not connected yet');
  assert.equal(serviceByKey(payload, 'aws_s3').status, 'not_configured');
  assert.equal(serviceByKey(payload, 'stripe').status, 'not_configured');
  assert.equal(payload.integration_readiness.find((row) => row.service === 'Render').live_usage_connected, false);
});

test('admin metrics SendGrid delivery events do not drive Metrics status', async () => {
  const tables = emptyTables();
  for (let index = 0; index < 10; index += 1) {
    tables.email_delivery_events.push({
      id: `email-${index}`,
      created_at: '2026-06-12T00:00:00.000Z',
      event_type: 'bounce',
      is_problem: true,
      reason: 'Failed for person@example.com with raw SendGrid detail',
    });
  }

  const payload = await buildAdminMetricsPayload({
    db: makeDb(tables),
    query: { date_range: '30d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
    liveChecksEnabled: false,
  });

  const sendGrid = serviceByKey(payload, 'sendgrid');
  assert.notEqual(sendGrid.status, 'problem');
  assert.equal(sendGrid.errors.find((row) => row.label === 'Delivery diagnostics').value, 'Audit Logs');
  assert.equal(sendGrid.errors.find((row) => row.label === 'Bounces'), undefined);
  assert.equal(sendGrid.errors.find((row) => row.label === 'Problem rate'), undefined);
  assert.equal(sendGrid.usage.find((row) => row.label === 'Events in range'), undefined);
  assert.doesNotMatch(JSON.stringify(sendGrid), /person@example\.com|raw SendGrid detail/i);
});

test('admin metrics SendGrid status-only behavior is safe', async () => {
  const calls = [];
  const service = await buildSendGridHealth(sendGridHealthContext({
    env: {
      SENDGRID_API_KEY: 'sendgrid-secret',
      SENDGRID_EVENT_WEBHOOK_SECRET: 'webhook-secret',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: String(options.headers?.Authorization || '') });
      if (String(url).includes('api.sendgrid.com/v3/scopes')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ scopes: ['mail.send', 'alerts.read'] }),
        };
      }
      if (String(url).includes('status.sendgrid.com/api/v2/summary.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(sendGridStatusSummary()),
        };
      }
      throw new Error('unexpected_url');
    },
  }));
  const serialized = JSON.stringify(service);

  assert.equal(service.status, 'healthy');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.source_label, 'Live SendGrid API and SendGrid status page');
  assert.equal(service.usage_summary.find((row) => row.label === 'SendGrid API reachability').value, 'Connected');
  assert.equal(service.usage_summary.find((row) => row.label === 'SendGrid platform status').value, 'All Systems Operational');
  assert.equal(service.problem_summary.find((row) => row.label === 'Delivery diagnostics').value, 'Audit Logs');
  assert.equal(service.usage_summary.find((row) => row.label === 'Delivered'), undefined);
  assert.equal(service.problem_summary.find((row) => row.label === 'Bounces'), undefined);
  assert.equal(service.diagnostics.sendgrid_api_connected, true);
  assert.equal(service.diagnostics.sendgrid_status_page_connected, true);
  assert.equal(calls.find((call) => call.url.includes('/v3/scopes'))?.authorization, 'Bearer sendgrid-secret');
  assert.equal(calls.find((call) => call.url.includes('status.sendgrid.com'))?.authorization, '');
  assert.doesNotMatch(serialized, /sendgrid-secret|webhook-secret|mail\.send|alerts\.read/i);
});

test('admin metrics Sentry not configured behavior remains safe', async () => {
  const service = await buildSentryHealth(sentryHealthContext());

  assert.equal(service.status, 'not_configured');
  assert.equal(service.configured, false);
  assert.equal(service.live_api_connected, false);
  assert.equal(service.connection_label, 'Configuration missing');
  assert.equal(service.usage_summary.find((row) => row.label === 'Capture configured').value, 'No');
  assert.equal(service.usage_summary.find((row) => row.label === 'Projects configured').value, 0);
  assert.equal(service.usage_summary.find((row) => row.label === 'Recent issue details').value, 'Not available');
  assert.deepEqual(service.recent_issues, []);
  assert.equal(service.diagnostics.sentry_capture_configured, false);
  assert.equal(service.diagnostics.sentry_api_status, 'not_configured');
  assert.equal(service.diagnostics.sentry_project_count, 0);
});

test('admin metrics Sentry API connected includes safe summary and recent issue details', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: String(options.headers?.Authorization || '') });
    if (String(url).includes('status.sendgrid.com/api/v2/summary.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(sendGridStatusSummary()),
      };
    }
    if (String(url).includes('status.render.com/api/v2/summary.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(renderStatusSummary()),
      };
    }
    if (String(url).includes('/organizations/alpha-org/issues/')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{
          project: { slug: 'backend', name: 'Backend', id: '2' },
          title: 'TypeError for person@example.com from 192.168.1.4 using Bearer abc123 at https://secret.example/path?token=sk-test',
          culprit: 'POST /api/private 10.0.0.2',
          level: 'error',
          status: 'unresolved',
          count: '12',
          userCount: '3',
          firstSeen: '2026-06-17T10:00:00.000Z',
          lastSeen: '2026-06-18T11:00:00.000Z',
          permalink: 'https://alpha.sentry.io/issues/123/?query=secret-token',
          platform: 'node',
          metadata: { environment: 'production', request_body: 'raw secret body' },
          stacktrace: { frames: [{ raw: 'raw stack trace secret' }] },
          headers: { Authorization: 'Bearer raw-header-token' },
          cookies: 'raw-cookie-secret',
        }]),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      SENTRY_ENABLED: 'true',
      SENTRY_DSN: 'sentry-dsn-secret',
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_PROJECT_FRONTEND: 'frontend',
      SENTRY_METRICS_ENABLED: 'true',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'sentry');
  const issue = service.recent_issues[0];
  const serialized = JSON.stringify(service);

  assert.equal(service.status, 'warning');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.usage.find((row) => row.label === 'Projects checked').value, 2);
  assert.equal(service.usage.find((row) => row.label === 'Recent issue details').value, 1);
  assert.equal(service.errors.find((row) => row.label === 'Open unresolved issues').value, 1);
  assert.equal(service.errors.find((row) => row.label === 'New issues in range').value, 1);
  assert.equal(service.diagnostics.sentry_capture_configured, true);
  assert.equal(service.diagnostics.sentry_api_status, 'connected');
  assert.equal(service.diagnostics.sentry_project_count, 2);
  assert.equal(service.diagnostics.sentry_projects_checked, 2);
  assert.equal(service.diagnostics.sentry_recent_issue_count, 1);
  assert.equal(service.diagnostics.sentry_api_base_source, 'default');
  assert.equal(service.diagnostics.sentry_issue_endpoint_source, 'organization_issues');
  assert.equal(service.recent_issues.length, 1);
  assert.equal(issue.project, 'backend');
  assert.match(issue.title, /\[redacted-email\]/);
  assert.match(issue.title, /\[redacted-ip\]/);
  assert.match(issue.title, /Bearer \[redacted\]/);
  assert.match(issue.title, /\[redacted-url\]/);
  assert.equal(issue.count, 12);
  assert.equal(issue.user_count, 3);
  assert.equal(issue.first_seen, '2026-06-17T10:00:00.000Z');
  assert.equal(issue.last_seen, '2026-06-18T11:00:00.000Z');
  assert.equal(issue.permalink, 'https://alpha.sentry.io/issues/123/');
  const sentryCall = calls.find((call) => call.url.includes('sentry.io/api/0/organizations/alpha-org/issues/'));
  assert.ok(sentryCall);
  const sentryUrl = new URL(sentryCall.url);
  assert.equal(sentryUrl.pathname, '/api/0/organizations/alpha-org/issues/');
  assert.equal(sentryUrl.searchParams.get('query'), 'is:unresolved');
  assert.equal(sentryUrl.searchParams.get('statsPeriod'), '7d');
  assert.equal(sentryUrl.searchParams.get('sort'), 'date');
  assert.equal(sentryUrl.searchParams.get('limit'), '10');
  assert.deepEqual(sentryUrl.searchParams.getAll('project'), ['backend', 'frontend']);
  assert.equal(sentryCall.authorization, 'Bearer sentry-token-secret');
  assert.doesNotMatch(serialized, /sentry-token-secret|sentry-dsn-secret|person@example\.com|192\.168\.1\.4|10\.0\.0\.2|secret\.example|secret-token|sk-test|raw secret body|raw stack trace|raw-header-token|raw-cookie-secret/i);
});

test('admin metrics Sentry filters non-open issues after API response', async () => {
  const service = await buildSentryHealth(sentryHealthContext({
    env: {
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_PROJECT_FRONTEND: 'frontend',
      SENTRY_METRICS_ENABLED: 'true',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        {
          project: { slug: 'backend' },
          title: 'Unresolved TypeError',
          status: 'unresolved',
          count: '7',
          userCount: '2',
          firstSeen: '2026-06-17T10:00:00.000Z',
          lastSeen: '2026-06-18T11:00:00.000Z',
          permalink: 'https://alpha.sentry.io/issues/123/',
        },
        {
          project: { slug: 'backend' },
          title: 'Closed marker with raw-secret',
          status: 'resolved',
          count: '4',
          firstSeen: '2026-06-17T10:00:00.000Z',
          lastSeen: '2026-06-18T10:00:00.000Z',
          metadata: { request_body: 'raw resolved payload' },
        },
        {
          project: { slug: 'frontend' },
          title: 'Ignored marker with raw-secret',
          status: 'ignored',
          count: '3',
          firstSeen: '2026-06-17T10:00:00.000Z',
          lastSeen: '2026-06-18T09:00:00.000Z',
          statusDetails: { ignoreUntil: '2026-06-19T00:00:00.000Z' },
        },
        {
          project: { slug: 'frontend' },
          title: 'Archived marker with raw-secret',
          status: 'unresolved',
          substatus: 'archived_until_escalating',
          count: '2',
          firstSeen: '2026-06-17T10:00:00.000Z',
          lastSeen: '2026-06-18T08:00:00.000Z',
        },
        {
          project: { slug: 'frontend' },
          title: 'Snoozed marker with raw-secret',
          status: 'unresolved',
          statusDetails: { substatus: 'archived_until_condition_met' },
          count: '1',
          firstSeen: '2026-06-17T10:00:00.000Z',
          lastSeen: '2026-06-18T07:00:00.000Z',
        },
      ]),
    }),
  }));
  const serialized = JSON.stringify(service);

  assert.equal(service.live_api_connected, true);
  assert.equal(service.usage_summary.find((row) => row.label === 'Recent issue details').value, 1);
  assert.equal(service.problem_summary.find((row) => row.label === 'Open unresolved issues').value, 1);
  assert.equal(service.problem_summary.find((row) => row.label === 'New issues in range').value, 1);
  assert.equal(service.diagnostics.sentry_recent_issue_count, 1);
  assert.equal(service.recent_issues.length, 1);
  assert.equal(service.recent_issues[0].title, 'Unresolved TypeError');
  assert.equal(service.recent_issues[0].status, 'unresolved');
  assert.equal(service.recent_issues[0].count, 7);
  assert.doesNotMatch(serialized, /Closed marker|Ignored marker|Archived marker|Snoozed marker|raw-secret|raw resolved payload/i);
});

test('admin metrics Sentry refresh does not reuse stale issue cache', async () => {
  let calls = 0;
  const context = sentryHealthContext({
    cacheEnabled: true,
    env: {
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_METRICS_ENABLED: 'true',
    },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(calls === 1 ? [{
          project: { slug: 'backend' },
          title: 'Issue resolved after first refresh',
          status: 'unresolved',
          count: '1',
          firstSeen: '2026-06-17T10:00:00.000Z',
          lastSeen: '2026-06-18T11:00:00.000Z',
        }] : []),
      };
    },
  });

  const first = await buildSentryHealth(context);
  const second = await buildSentryHealth({
    ...context,
    now: new Date('2026-06-18T12:00:30.000Z'),
  });

  assert.equal(calls, 2);
  assert.equal(first.problem_summary.find((row) => row.label === 'Open unresolved issues').value, 1);
  assert.equal(first.recent_issues.length, 1);
  assert.equal(second.problem_summary.find((row) => row.label === 'Open unresolved issues').value, 0);
  assert.deepEqual(second.recent_issues, []);
});

test('admin metrics Sentry uses custom API base URL and trims trailing slash', async () => {
  const calls = [];
  const service = await buildSentryHealth(sentryHealthContext({
    env: {
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_METRICS_ENABLED: 'true',
      SENTRY_API_BASE_URL: 'https://us.sentry.io/api/0///',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: String(options.headers?.Authorization || '') });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([]),
      };
    },
  }));
  const serialized = JSON.stringify(service);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.startsWith('https://us.sentry.io/api/0/organizations/alpha-org/issues/'), true);
  assert.deepEqual(new URL(calls[0].url).searchParams.getAll('project'), ['backend']);
  assert.equal(calls[0].authorization, 'Bearer sentry-token-secret');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.diagnostics.sentry_api_status, 'connected');
  assert.equal(service.diagnostics.sentry_api_base_source, 'env');
  assert.doesNotMatch(serialized, /sentry-token-secret|https:\/\/us\.sentry\.io/i);
});

test('admin metrics Sentry normalizes quoted auth token', async () => {
  const calls = [];
  const service = await buildSentryHealth(sentryHealthContext({
    env: {
      SENTRY_AUTH_TOKEN: '"sentry-token-secret"',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_METRICS_ENABLED: 'true',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: String(options.headers?.Authorization || '') });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([]),
      };
    },
  }));

  assert.equal(service.live_api_connected, true);
  assert.equal(calls[0].authorization, 'Bearer sentry-token-secret');
});

test('admin metrics Sentry normalizes Bearer-prefixed auth token', async () => {
  const calls = [];
  const service = await buildSentryHealth(sentryHealthContext({
    env: {
      SENTRY_AUTH_TOKEN: 'Bearer sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_METRICS_ENABLED: 'true',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: String(options.headers?.Authorization || '') });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([]),
      };
    },
  }));

  assert.equal(service.live_api_connected, true);
  assert.equal(calls[0].authorization, 'Bearer sentry-token-secret');
});

test('admin metrics Sentry invalid API base fails safely', async () => {
  const service = await buildSentryHealth(sentryHealthContext({
    env: {
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_METRICS_ENABLED: 'true',
      SENTRY_API_BASE_URL: 'http://bad.example/api/0?token=raw-secret',
    },
    fetchImpl: async () => {
      throw new Error('fetch_should_not_run');
    },
  }));
  const serialized = JSON.stringify(service);

  assert.equal(service.status, 'warning');
  assert.equal(service.live_api_connected, false);
  assert.equal(service.diagnostics.sentry_api_status, 'failed');
  assert.equal(service.diagnostics.sentry_api_base_source, 'invalid');
  assert.equal(service.diagnostics.sentry_projects_checked, 0);
  assert.equal(service.troubleshooting_note, 'Invalid Sentry API base URL.');
  assert.doesNotMatch(serialized, /sentry-token-secret|bad\.example|raw-secret|fetch_should_not_run/i);
});

test('admin metrics Sentry 401 failure sanitizes response body', async () => {
  const service = await buildSentryHealth(sentryHealthContext({
    env: {
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_METRICS_ENABLED: 'true',
    },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        detail: 'raw Sentry 401 for sentry-token-secret and person@example.com',
      }),
    }),
  }));
  const serialized = JSON.stringify(service);

  assert.equal(service.status, 'warning');
  assert.equal(service.live_api_connected, false);
  assert.equal(service.diagnostics.sentry_api_status, 'failed');
  assert.equal(service.diagnostics.sentry_api_base_source, 'default');
  assert.equal(service.troubleshooting_note, 'Live API returned 401.');
  assert.doesNotMatch(serialized, /sentry-token-secret|person@example\.com|raw Sentry 401/i);
});

test('admin metrics Sentry 400 failure sanitizes response body', async () => {
  const service = await buildSentryHealth(sentryHealthContext({
    env: {
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_METRICS_ENABLED: 'true',
    },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        detail: 'raw Sentry 400 for sentry-token-secret and person@example.com',
      }),
    }),
  }));
  const serialized = JSON.stringify(service);

  assert.equal(service.status, 'warning');
  assert.equal(service.live_api_connected, false);
  assert.equal(service.diagnostics.sentry_api_status, 'failed');
  assert.equal(service.diagnostics.sentry_issue_endpoint_source, 'organization_issues');
  assert.equal(service.troubleshooting_note, 'Live API returned 400.');
  assert.doesNotMatch(serialized, /sentry-token-secret|person@example\.com|raw Sentry 400/i);
});

test('admin metrics Sentry API failure does not leak secrets or raw payloads', async () => {
  const service = await buildSentryHealth(sentryHealthContext({
    env: {
      SENTRY_ENABLED: 'true',
      SENTRY_DSN: 'sentry-dsn-secret',
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      SENTRY_ORG: 'alpha-org',
      SENTRY_PROJECT_BACKEND: 'backend',
      SENTRY_METRICS_ENABLED: 'true',
    },
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({
        message: 'raw Sentry failure for sentry-token-secret person@example.com with stack trace',
      }),
    }),
  }));
  const serialized = JSON.stringify(service);

  assert.equal(service.status, 'warning');
  assert.equal(service.configured, true);
  assert.equal(service.live_api_connected, false);
  assert.equal(service.connection_label, 'Live API not connected');
  assert.deepEqual(service.recent_issues, []);
  assert.equal(service.diagnostics.sentry_capture_configured, true);
  assert.equal(service.diagnostics.sentry_api_status, 'failed');
  assert.equal(service.diagnostics.sentry_projects_checked, 0);
  assert.equal(service.troubleshooting_note, 'Live API returned 403.');
  assert.doesNotMatch(serialized, /sentry-token-secret|sentry-dsn-secret|person@example\.com|raw Sentry failure|stack trace/i);
});

test('admin metrics Supabase app DB healthy without management config stays healthy', async () => {
  const service = await buildSupabaseHealth(supabaseHealthContext());

  assert.equal(service.status, 'healthy');
  assert.equal(service.connection_label, 'Connected');
  assert.equal(service.live_api_connected, false);
  assert.equal(service.source_label, 'Database health check');
  assert.match(service.health_summary, /Database health check succeeded/);
  assert.match(service.health_summary, /Management API is not configured/);
  assert.equal(service.usage_summary.find((row) => row.label === 'App database health').value, 'Connected');
  assert.equal(service.usage_summary.find((row) => row.label === 'Management API').value, 'Not configured');
  assert.equal(service.problem_summary.find((row) => row.label === 'Management API check').value, 'Not configured');
  assert.equal(service.diagnostics.supabase_app_db_status, 'connected');
  assert.equal(service.diagnostics.supabase_management_status, 'not_configured');
  assert.equal(service.diagnostics.supabase_project_scope, 'absent');
  assert.equal(service.diagnostics.supabase_management_auth, 'absent');
  assert.equal(service.troubleshooting_note, null);
});

test('admin metrics Supabase management API connected returns safe project summary', async () => {
  const calls = [];
  const service = await buildSupabaseHealth(supabaseHealthContext({
    env: {
      SUPABASE_ACCESS_TOKEN: 'supabase-access-secret',
      SUPABASE_PROJECT_REF: 'secret-project-ref',
      SUPABASE_METRICS_ENABLED: 'true',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: String(options.headers?.Authorization || '') });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 'secret-project-ref',
          name: 'Hidden project name',
          region: 'us-west-2',
          status: 'ACTIVE_HEALTHY',
          database: { status: 'AVAILABLE' },
        }),
      };
    },
  }));
  const serialized = JSON.stringify(service);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes('/v1/projects/secret-project-ref'), true);
  assert.equal(calls[0].authorization, 'Bearer supabase-access-secret');
  assert.equal(service.status, 'healthy');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.source_label, 'Database health check and Supabase Management API');
  assert.equal(service.usage_summary.find((row) => row.label === 'Management API').value, 'Connected');
  assert.equal(service.usage_summary.find((row) => row.label === 'Project status').value, 'ACTIVE_HEALTHY');
  assert.equal(service.usage_summary.find((row) => row.label === 'Project region').value, 'us-west-2');
  assert.equal(service.problem_summary.find((row) => row.label === 'Usage and cost availability').value, 'Unavailable');
  assert.equal(service.cost_summary.display, 'Not available');
  assert.equal(service.diagnostics.supabase_management_status, 'connected');
  assert.equal(service.diagnostics.supabase_management_http_status, null);
  assert.equal(service.diagnostics.supabase_management_error_kind, null);
  assert.equal(service.diagnostics.supabase_project_scope, 'present');
  assert.equal(service.diagnostics.supabase_management_auth, 'present');
  assert.doesNotMatch(serialized, /supabase-access-secret|secret-project-ref|Hidden project name/i);
});

test('admin metrics Supabase management API failure degrades safely without secret leakage', async () => {
  const service = await buildSupabaseHealth(supabaseHealthContext({
    env: {
      SUPABASE_ACCESS_TOKEN: 'supabase-access-secret',
      SUPABASE_PROJECT_REF: 'secret-project-ref',
      SUPABASE_METRICS_ENABLED: 'true',
    },
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({
        message: 'raw failure for supabase-access-secret and secret-project-ref',
      }),
    }),
  }));
  const serialized = JSON.stringify(service);

  assert.equal(service.status, 'warning');
  assert.equal(service.connection_label, 'Connected');
  assert.equal(service.live_api_connected, false);
  assert.equal(service.usage_summary.find((row) => row.label === 'App database health').value, 'Connected');
  assert.equal(service.usage_summary.find((row) => row.label === 'Management API').value, 'Check failed');
  assert.equal(service.problem_summary.find((row) => row.label === 'Management API check').value, 'Check failed');
  assert.equal(service.diagnostics.supabase_app_db_status, 'connected');
  assert.equal(service.diagnostics.supabase_management_status, 'failed');
  assert.equal(service.diagnostics.supabase_management_http_status, 403);
  assert.equal(service.diagnostics.supabase_management_error_kind, 'permission');
  assert.equal(service.troubleshooting_note, 'Live API returned 403.');
  assert.match(service.notes.join(' '), /app database health is still checked/);
  assert.doesNotMatch(serialized, /supabase-access-secret|secret-project-ref|raw failure/i);
});

test('admin metrics uses live vendor APIs when configured and still returns safe summaries', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{
            results: [{
              num_model_requests: 3,
              input_tokens: 100,
              output_tokens: 50,
              model: 'gpt-test',
            }],
          }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ amount: { value: 1.23, currency: 'usd' } }] }],
        }),
      };
    }
    if (String(url).includes('api.sendgrid.com/v3/scopes')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ scopes: ['mail.send'] }),
      };
    }
    if (String(url).includes('status.sendgrid.com/api/v2/summary.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(sendGridStatusSummary()),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-test-secret',
      OPENAI_USAGE_ENABLED: 'true',
      SENDGRID_API_KEY: 'sendgrid-secret',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  assert.ok(calls.some((url) => url.includes('/organization/usage/completions')));
  assert.ok(calls.some((url) => url.includes('api.sendgrid.com/v3/scopes')));
  assert.ok(calls.some((url) => url.includes('status.sendgrid.com/api/v2/summary.json')));
  const costCall = new URL(calls.find((url) => url.includes('/organization/costs')));
  assert.equal(costCall.pathname, '/v1/organization/costs');
  assert.equal(costCall.searchParams.has('start_time'), true);
  assert.equal(costCall.searchParams.has('end_time'), true);
  assert.equal(costCall.searchParams.get('bucket_width'), '1d');
  assert.equal(costCall.searchParams.get('limit'), '180');
  assert.equal(costCall.searchParams.has('group_by'), false);
  assert.equal(costCall.searchParams.has('project_ids'), false);
  assert.equal(serviceByKey(payload, 'openai').live_api_connected, true);
  assert.equal(serviceByKey(payload, 'openai').source_label, 'Live OpenAI API');
  assert.equal(serviceByKey(payload, 'openai').usage.find((row) => row.label === 'Requests').value, 3);
  assert.equal(serviceByKey(payload, 'openai').cost_summary.display, '$1.23');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_usage_status, 'connected');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_status, 'connected');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_call_status, 'called_connected');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_http_status, 200);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_error_kind, null);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_endpoint_version, 'organization_costs');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_response_kind, 'buckets');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_bucket_count, 1);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_total_seen, true);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_request_attempted, true);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_request_url_valid, true);
  assert.deepEqual(serviceByKey(payload, 'openai').diagnostics.openai_cost_query_param_keys, ['start_time', 'end_time', 'bucket_width', 'limit']);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_exception_kind, null);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_exception_message_safe, null);
  const sendGrid = serviceByKey(payload, 'sendgrid');
  assert.equal(sendGrid.live_api_connected, true);
  assert.equal(sendGrid.source_label, 'Live SendGrid API and SendGrid status page');
  assert.equal(sendGrid.usage.find((row) => row.label === 'SendGrid API reachability').value, 'Connected');
  assert.equal(sendGrid.usage.find((row) => row.label === 'SendGrid platform status').value, 'All Systems Operational');
  assert.equal(sendGrid.usage.find((row) => row.label === 'Delivered'), undefined);
  assert.equal(sendGrid.errors.find((row) => row.label === 'Delivery diagnostics').value, 'Audit Logs');
  assert.equal(sendGrid.diagnostics.sendgrid_api_connected, true);
  assert.equal(sendGrid.diagnostics.sendgrid_status_page_connected, true);
  assert.doesNotMatch(JSON.stringify(payload), /sk-test-secret|sendgrid-secret/i);
});

test('admin metrics Tavus connected with no recent webhook events stays healthy', async () => {
  const service = await buildTavusHealth(tavusHealthContext({
    signals: {
      estimatedMinutes: 61.8,
    },
  }));

  assert.equal(service.status, 'healthy');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.health_summary, 'Tavus API is reachable. No recent Tavus connectivity or webhook processing issues were found.');
  assert.equal(service.readiness_items.find((row) => row.label === 'Webhook receiver').status, 'No recent events');
  assert.equal(service.diagnostics.tavus_api_connected, true);
  assert.equal(service.diagnostics.tavus_webhook_recent_event_present, false);
  assert.equal(service.diagnostics.tavus_warning_reason_count, 0);
  assert.equal(service.cost_summary.display, '$0.00');
  assert.equal(service.cost_summary.source_label, 'Estimated from Tavus invoice rate card');
  assert.equal(service.usage_summary.find((row) => row.label === 'Estimated blended allocation').value, '$59.00');
  assert.doesNotMatch(JSON.stringify(service), /tavus-secret|webhook-secret/i);
});

test('admin metrics Tavus zero perception events does not create warning by itself', async () => {
  const rows = {
    interviews: [{
      id: 'interview-ready',
      video_url: 'https://example.invalid/video',
      recording_status: 'ready',
      recording_ready_at: '2026-06-18T11:00:00.000Z',
      recording_metadata: { duration_seconds: 600 },
      updated_at: '2026-06-18T11:00:00.000Z',
    }],
  };
  const service = await buildTavusHealth(tavusHealthContext({
    rows,
    signals: {
      interviews: rows.interviews,
      recordingReady: 1,
      perceptionEvents: [],
      perceptionMissing: 1,
      estimatedMinutes: 10,
    },
  }));

  assert.equal(service.status, 'healthy');
  assert.equal(service.usage_summary.find((row) => row.label === 'Perception events').value, 0);
  assert.equal(service.problem_summary.find((row) => row.label === 'Perception missing proxy').value, 1);
  assert.equal(service.diagnostics.tavus_warning_reason_count, 0);
  assert.equal(service.cost_summary.display, '$0.00');
});

test('admin metrics Tavus API unreachable creates problem', async () => {
  const service = await buildTavusHealth(tavusHealthContext({
    fetchImpl: async (url) => {
      if (String(url).includes('/conversations')) {
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ raw_error: 'do not expose tavus failure' }),
        };
      }
      throw new Error('unexpected_url');
    },
  }));

  assert.equal(service.status, 'problem');
  assert.equal(service.live_api_connected, false);
  assert.equal(service.health_summary, 'Tavus API or webhook connectivity failed.');
  assert.equal(service.diagnostics.tavus_api_connected, false);
  assert.doesNotMatch(JSON.stringify(service), /tavus-secret|webhook-secret|do not expose/i);
});

test('admin metrics Tavus recent delayed recording creates warning', async () => {
  const rows = {
    interviews: [{
      id: 'interview-pending',
      video_url: 'https://example.invalid/video',
      recording_status: 'pending',
      updated_at: '2026-06-18T10:00:00.000Z',
      created_at: '2026-06-18T10:00:00.000Z',
    }],
  };
  const service = await buildTavusHealth(tavusHealthContext({
    rows,
    signals: {
      interviews: rows.interviews,
      recordingPending: 1,
      estimatedMinutes: 5,
    },
  }));

  assert.equal(service.status, 'warning');
  assert.equal(service.health_summary, 'Tavus API is reachable, but recent recording or webhook processing issues need review.');
  assert.equal(service.problem_summary.find((row) => row.label === 'Actionable recording delays').value, 1);
  assert.equal(service.diagnostics.tavus_warning_reason_count, 1);
});

test('admin metrics Tavus persistent recording problem creates problem', async () => {
  const rows = {
    interviews: [{
      id: 'interview-failed',
      video_url: 'https://example.invalid/video',
      recording_status: 'failed',
      recording_delete_error: 'safe synthetic failure',
      updated_at: '2026-06-18T11:00:00.000Z',
    }],
  };
  const service = await buildTavusHealth(tavusHealthContext({
    rows,
    signals: {
      interviews: rows.interviews,
      recordingProblems: 1,
      estimatedMinutes: 5,
    },
  }));

  assert.equal(service.status, 'problem');
  assert.equal(service.problem_summary.find((row) => row.label === 'Persistent recording problems').value, 1);
});

test('admin metrics Tavus estimated minutes below included tier produces zero variable cost', async () => {
  const service = await buildTavusHealth(tavusHealthContext({
    signals: {
      estimatedMinutes: 60,
    },
  }));

  assert.equal(service.cost_summary.display, '$0.00');
  assert.equal(service.cost_summary.value, 0);
  assert.equal(service.cost_summary.help, 'Variable usage estimate based on invoice rates. This is an internal estimate, not a Tavus invoice.');
  assert.equal(service.usage_summary.find((row) => row.label === 'Conversation overage minutes').value, 0);
  assert.equal(service.usage_summary.find((row) => row.label === 'Estimated variable usage cost').value, '$0.00');
  assert.equal(service.diagnostics.tavus_cost_source, 'invoice_rate_card');
  assert.equal(service.diagnostics.tavus_estimated_minutes_source, 'recording_metadata');
  assert.equal(service.diagnostics.tavus_variable_cost_calculated, true);
  assert.ok(service.notes.some((note) => note.includes('internal estimates')));
});

test('admin metrics Tavus estimated minutes above included tier calculates variable cost', async () => {
  const service = await buildTavusHealth(tavusHealthContext({
    signals: {
      estimatedMinutes: 125,
    },
  }));

  assert.equal(service.cost_summary.display, '$9.25');
  assert.equal(service.cost_summary.value, 9.25);
  assert.equal(service.cost_summary.source_label, 'Estimated from Tavus invoice rate card');
  assert.equal(service.usage_summary.find((row) => row.label === 'Conversation overage minutes').value, 25);
  assert.equal(service.usage_summary.find((row) => row.label === 'Estimated variable usage cost').value, '$9.25');
  assert.equal(service.diagnostics.tavus_variable_cost_calculated, true);
});

test('admin metrics OpenAI cost skips when OPENAI_COSTS_ENABLED is false', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    throw new Error('cost_should_not_be_called');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
      OPENAI_COSTS_ENABLED: 'false',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'openai');
  assert.equal(calls.some((url) => url.includes('/organization/usage/completions')), true);
  assert.equal(calls.some((url) => url.includes('/organization/costs')), false);
  assert.equal(service.live_api_connected, true);
  assert.equal(service.cost_summary.display, 'Not available');
  assert.equal(service.diagnostics.openai_usage_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_status, 'not_called');
  assert.equal(service.diagnostics.openai_cost_call_status, 'skipped_by_env');
  assert.equal(service.diagnostics.openai_cost_response_kind, 'not_called');
  assert.equal(service.diagnostics.openai_cost_bucket_count, null);
  assert.equal(service.diagnostics.openai_cost_total_seen, false);
  assert.equal(service.diagnostics.openai_cost_request_attempted, false);
  assert.equal(service.diagnostics.openai_cost_request_url_valid, false);
  assert.doesNotMatch(JSON.stringify(payload), /sk-admin-secret/i);
});

test('admin metrics OpenAI cost skips without OPENAI_ADMIN_KEY', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    throw new Error('cost_should_not_be_called');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_API_KEY: 'sk-standard-secret',
      OPENAI_USAGE_ENABLED: 'true',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'openai');
  assert.equal(calls.some((url) => url.includes('/organization/usage/completions')), true);
  assert.equal(calls.some((url) => url.includes('/organization/costs')), false);
  assert.equal(service.live_api_connected, true);
  assert.equal(service.diagnostics.openai_key_source, 'standard_key');
  assert.equal(service.diagnostics.openai_usage_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_status, 'not_called');
  assert.equal(service.diagnostics.openai_cost_call_status, 'skipped_missing_admin_key');
  assert.equal(service.diagnostics.openai_cost_response_kind, 'not_called');
  assert.equal(service.diagnostics.openai_cost_request_attempted, false);
  assert.equal(service.diagnostics.openai_cost_request_url_valid, false);
  assert.doesNotMatch(JSON.stringify(payload), /sk-standard-secret/i);
});

test('admin metrics OpenAI cost treats empty buckets as connected zero cost', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ object: 'page', data: [], has_more: false, next_page: null }),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'openai');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.cost_summary.display, '$0.00');
  assert.equal(service.cost_summary.help, 'No cost returned for selected period');
  assert.equal(service.notes.includes('No cost returned for selected period'), true);
  assert.equal(service.diagnostics.openai_usage_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_call_status, 'called_connected');
  assert.equal(service.diagnostics.openai_cost_http_status, 200);
  assert.equal(service.diagnostics.openai_cost_error_kind, null);
  assert.equal(service.diagnostics.openai_cost_endpoint_version, 'organization_costs');
  assert.equal(service.diagnostics.openai_cost_response_kind, 'empty_buckets');
  assert.equal(service.diagnostics.openai_cost_bucket_count, 0);
  assert.equal(service.diagnostics.openai_cost_total_seen, false);
  assert.equal(service.diagnostics.openai_cost_request_attempted, true);
  assert.equal(service.diagnostics.openai_cost_request_url_valid, true);
  assert.deepEqual(service.diagnostics.openai_cost_query_param_keys, ['start_time', 'end_time', 'bucket_width', 'limit']);
  assert.equal(service.diagnostics.openai_cost_exception_kind, null);
  assert.equal(service.diagnostics.openai_cost_exception_message_safe, null);
  assert.doesNotMatch(JSON.stringify(payload), /sk-admin-secret/i);
});

test('admin metrics OpenAI diagnostics use admin key and classify cost permission failures', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      authorization: String(options.headers?.Authorization || ''),
    });
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: 'forbidden raw detail' } }),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_API_KEY: 'sk-standard-secret',
      OPENAI_USAGE_ENABLED: 'true',
      OPENAI_PROJECT_ID: 'proj-test',
      OPENAI_ORG_ID: 'org-test',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const usageCall = calls.find((call) => call.url.includes('/organization/usage/completions'));
  const costCall = calls.find((call) => call.url.includes('/organization/costs'));
  assert.ok(usageCall);
  assert.ok(costCall);
  assert.equal(usageCall.authorization, 'Bearer sk-admin-secret');
  assert.equal(costCall.authorization, 'Bearer sk-admin-secret');
  const costUrl = new URL(costCall.url);
  assert.equal(costUrl.pathname, '/v1/organization/costs');
  assert.equal(costUrl.searchParams.get('project_ids'), 'proj-test');
  assert.equal(costUrl.searchParams.get('bucket_width'), '1d');
  assert.equal(costUrl.searchParams.get('limit'), '180');
  assert.equal(costUrl.searchParams.has('group_by'), false);

  const diagnostics = serviceByKey(payload, 'openai').diagnostics;
  assert.deepEqual(diagnostics, {
    openai_usage_status: 'connected',
    openai_cost_status: 'failed',
    openai_cost_call_status: 'called_failed',
    openai_cost_http_status: 403,
    openai_cost_error_kind: 'permission',
    openai_cost_endpoint_version: 'organization_costs',
    openai_cost_response_kind: 'http_error',
    openai_cost_bucket_count: null,
    openai_cost_total_seen: false,
    openai_cost_request_attempted: true,
    openai_cost_request_url_valid: true,
    openai_cost_query_param_keys: ['start_time', 'end_time', 'bucket_width', 'limit', 'project_ids'],
    openai_cost_exception_kind: null,
    openai_cost_exception_message_safe: null,
    openai_key_source: 'admin_key',
    openai_project_scope: 'present',
    openai_org_scope: 'present',
  });
  assert.equal(serviceByKey(payload, 'openai').cost_summary.display, 'Not available');
  assert.doesNotMatch(JSON.stringify(payload), /sk-admin-secret|sk-standard-secret|forbidden raw detail/i);
});

test('admin metrics OpenAI cost captures fetch TypeError as request exception', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      throw new TypeError('fetch failed for https://api.openai.com/v1/organization/costs?api_key=sk-admin-secret');
    }
    throw new Error('unexpected_url');
  };

  const service = await buildOpenAIHealth(openAIHealthContext({ fetchImpl }));
  const diagnostics = service.diagnostics;
  assert.equal(diagnostics.openai_usage_status, 'connected');
  assert.equal(diagnostics.openai_cost_status, 'failed');
  assert.equal(diagnostics.openai_cost_call_status, 'called_failed');
  assert.equal(diagnostics.openai_cost_http_status, null);
  assert.equal(diagnostics.openai_cost_error_kind, 'unavailable');
  assert.equal(diagnostics.openai_cost_response_kind, 'request_exception');
  assert.equal(diagnostics.openai_cost_request_attempted, true);
  assert.equal(diagnostics.openai_cost_request_url_valid, true);
  assert.deepEqual(diagnostics.openai_cost_query_param_keys, ['start_time', 'end_time', 'bucket_width', 'limit']);
  assert.equal(diagnostics.openai_cost_exception_kind, 'fetch');
  assert.match(diagnostics.openai_cost_exception_message_safe, /fetch failed/i);
  assert.doesNotMatch(JSON.stringify(service), /sk-admin-secret|api\.openai\.com\/v1\/organization\/costs\?api_key/i);
});

test('admin metrics OpenAI cost captures AbortController timeout as request exception', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return new Promise((resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('raw abort detail for https://api.openai.com/v1/organization/costs');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal?.aborted) rejectAbort();
        else options.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    }
    throw new Error('unexpected_url');
  };

  const service = await buildOpenAIHealth(openAIHealthContext({ fetchImpl, timeoutMs: 1 }));
  const diagnostics = service.diagnostics;
  assert.equal(diagnostics.openai_usage_status, 'connected');
  assert.equal(diagnostics.openai_cost_status, 'failed');
  assert.equal(diagnostics.openai_cost_call_status, 'called_failed');
  assert.equal(diagnostics.openai_cost_http_status, null);
  assert.equal(diagnostics.openai_cost_error_kind, 'unavailable');
  assert.equal(diagnostics.openai_cost_response_kind, 'request_exception');
  assert.equal(diagnostics.openai_cost_request_attempted, true);
  assert.equal(diagnostics.openai_cost_request_url_valid, true);
  assert.equal(diagnostics.openai_cost_exception_kind, 'abort');
  assert.match(diagnostics.openai_cost_exception_message_safe, /timed out/i);
  assert.doesNotMatch(JSON.stringify(service), /sk-admin-secret|api\.openai\.com\/v1\/organization\/costs/i);
});

test('admin metrics OpenAI cost captures invalid URL construction safely', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    throw new Error('cost_should_not_be_called');
  };

  const service = await buildOpenAIHealth(openAIHealthContext({
    fetchImpl,
    openAICostOrganizationBaseUrl: 'https://[invalid-openai-url',
  }));
  const diagnostics = service.diagnostics;
  assert.equal(diagnostics.openai_usage_status, 'connected');
  assert.equal(diagnostics.openai_cost_status, 'failed');
  assert.equal(diagnostics.openai_cost_call_status, 'called_failed');
  assert.equal(diagnostics.openai_cost_http_status, null);
  assert.equal(diagnostics.openai_cost_error_kind, 'unknown');
  assert.equal(diagnostics.openai_cost_response_kind, 'request_exception');
  assert.equal(diagnostics.openai_cost_request_attempted, false);
  assert.equal(diagnostics.openai_cost_request_url_valid, false);
  assert.deepEqual(diagnostics.openai_cost_query_param_keys, []);
  assert.equal(diagnostics.openai_cost_exception_kind, 'url');
  assert.match(diagnostics.openai_cost_exception_message_safe, /invalid url/i);
  assert.doesNotMatch(JSON.stringify(service), /sk-admin-secret|invalid-openai-url/i);
});

test('admin metrics OpenAI cost marks invalid response shape as failed without raw payload', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          object: 'page',
          data: { raw_detail: 'invalid raw cost payload detail' },
        }),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'openai');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.cost_summary.display, 'Not available');
  assert.equal(service.diagnostics.openai_usage_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_status, 'failed');
  assert.equal(service.diagnostics.openai_cost_call_status, 'called_failed');
  assert.equal(service.diagnostics.openai_cost_http_status, 200);
  assert.equal(service.diagnostics.openai_cost_error_kind, 'unknown');
  assert.equal(service.diagnostics.openai_cost_endpoint_version, 'organization_costs');
  assert.equal(service.diagnostics.openai_cost_response_kind, 'invalid_shape');
  assert.equal(service.diagnostics.openai_cost_bucket_count, null);
  assert.equal(service.diagnostics.openai_cost_total_seen, false);
  assert.equal(service.diagnostics.openai_cost_request_attempted, true);
  assert.equal(service.diagnostics.openai_cost_request_url_valid, true);
  assert.deepEqual(service.diagnostics.openai_cost_query_param_keys, ['start_time', 'end_time', 'bucket_width', 'limit']);
  assert.equal(service.diagnostics.openai_cost_exception_kind, null);
  assert.equal(service.diagnostics.openai_cost_exception_message_safe, null);
  assert.doesNotMatch(JSON.stringify(payload), /sk-admin-secret|invalid raw cost payload detail/i);
});

test('admin metrics Render status summary operational combines API and status page', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: String(options.headers?.Authorization || '') });
    if (String(url).includes('status.render.com/api/v2/summary.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(renderStatusSummary()),
      };
    }
    if (String(url).includes('/services/srv-backend/deploys')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ status: 'live', finishedAt: '2026-06-18T11:00:00.000Z' }]),
      };
    }
    if (String(url).includes('/services/srv-backend')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ name: 'QA Backend', type: 'web_service' }),
      };
    }
    throw new Error('unexpected_url');
  };

  const service = await buildRenderHealth(renderHealthContext({
    env: {
      RENDER_API_KEY: 'render-secret',
      RENDER_SERVICE_ID: 'srv-backend',
    },
    fetchImpl,
  }));

  assert.equal(service.live_api_connected, true);
  assert.equal(service.source_label, 'Live Render API and Render status page');
  assert.equal(service.usage_summary.find((row) => row.label === 'Render platform status').value, 'All Systems Operational');
  assert.equal(service.usage_summary.find((row) => row.label === 'Active Render incidents').value, 'None');
  assert.equal(service.usage_summary.find((row) => row.label === 'Scheduled maintenance').value, 'None');
  assert.equal(service.usage_summary.find((row) => row.label === 'Affected components').value, 'None reported');
  assert.equal(service.diagnostics.render_api_connected, true);
  assert.equal(service.diagnostics.render_status_page_connected, true);
  assert.equal(service.diagnostics.render_status_indicator, 'none');
  assert.equal(service.diagnostics.render_active_incident_count, 0);
  assert.equal(service.diagnostics.render_scheduled_maintenance_count, 0);
  assert.equal(service.diagnostics.render_status_error_kind, null);
  assert.ok(calls.some((call) => call.url.includes('/services/srv-backend')));
  assert.ok(calls.some((call) => call.url.includes('status.render.com/api/v2/summary.json')));
  assert.equal(calls.find((call) => call.url.includes('status.render.com'))?.authorization, '');
  assert.doesNotMatch(JSON.stringify(service), /render-secret/i);
});

test('admin metrics Render status summary reports active incident safely', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('status.render.com/api/v2/summary.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(renderStatusSummary({
          status: { indicator: 'major', description: 'Partial System Outage' },
          components: [{ name: 'Builds and Deploys', status: 'degraded_performance' }],
          incidents: [{
            name: 'raw incident title',
            status: 'investigating',
            components: [{ name: 'Web Services', status: 'major_outage' }],
          }],
        })),
      };
    }
    throw new Error('unexpected_url');
  };

  const service = await buildRenderHealth(renderHealthContext({ fetchImpl }));

  assert.equal(service.source_label, 'Render status page');
  assert.equal(service.status, 'problem');
  assert.equal(service.usage_summary.find((row) => row.label === 'Render platform status').value, 'Partial System Outage');
  assert.equal(service.usage_summary.find((row) => row.label === 'Active Render incidents').value, '1 active incident');
  assert.equal(service.usage_summary.find((row) => row.label === 'Affected components').value, 'Builds and Deploys, Web Services');
  assert.equal(service.diagnostics.render_api_connected, false);
  assert.equal(service.diagnostics.render_status_page_connected, true);
  assert.equal(service.diagnostics.render_status_indicator, 'major');
  assert.equal(service.diagnostics.render_active_incident_count, 1);
  assert.equal(service.diagnostics.render_status_error_kind, null);
});

test('admin metrics Render status summary reports scheduled maintenance safely', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url) === 'https://status.example.test/render-summary.json') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(renderStatusSummary({
          scheduled_maintenances: [{
            name: 'raw maintenance title',
            status: 'in_progress',
            components: [{ name: 'PostgreSQL', status: 'under_maintenance' }],
          }],
        })),
      };
    }
    throw new Error('unexpected_url');
  };

  const service = await buildRenderHealth(renderHealthContext({
    env: {
      RENDER_STATUS_SUMMARY_URL: 'https://status.example.test/render-summary.json',
    },
    fetchImpl,
  }));

  assert.deepEqual(calls, ['https://status.example.test/render-summary.json']);
  assert.equal(service.source_label, 'Render status page');
  assert.equal(service.usage_summary.find((row) => row.label === 'Scheduled maintenance').value, '1 scheduled maintenance');
  assert.equal(service.usage_summary.find((row) => row.label === 'Affected components').value, 'PostgreSQL');
  assert.equal(service.diagnostics.render_status_page_connected, true);
  assert.equal(service.diagnostics.render_scheduled_maintenance_count, 1);
  assert.equal(service.diagnostics.render_status_error_kind, null);
});

test('admin metrics Render status endpoint failure does not crash service health', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('status.render.com/api/v2/summary.json')) {
      return {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ raw_error: 'do not expose' }),
      };
    }
    if (String(url).includes('/services/srv-backend/deploys')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ status: 'live', finishedAt: '2026-06-18T11:00:00.000Z' }]),
      };
    }
    if (String(url).includes('/services/srv-backend')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ name: 'QA Backend', type: 'web_service' }),
      };
    }
    throw new Error('unexpected_url');
  };

  const service = await buildRenderHealth(renderHealthContext({
    env: {
      RENDER_API_KEY: 'render-secret',
      RENDER_SERVICE_ID: 'srv-backend',
    },
    fetchImpl,
  }));

  assert.equal(service.live_api_connected, true);
  assert.equal(service.source_label, 'Live Render API');
  assert.equal(service.usage_summary.find((row) => row.label === 'Render platform status').value, 'Not available');
  assert.equal(service.problem_summary.find((row) => row.label === 'Render status page check').value, 'Check failed');
  assert.equal(service.diagnostics.render_api_connected, true);
  assert.equal(service.diagnostics.render_status_page_connected, false);
  assert.equal(service.diagnostics.render_status_error_kind, 'http_error');
  assert.doesNotMatch(JSON.stringify(service), /render-secret|do not expose/i);
});

test('admin metrics Render service API missing still uses public status page', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('status.render.com/api/v2/summary.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(renderStatusSummary()),
      };
    }
    throw new Error('unexpected_url');
  };

  const service = await buildRenderHealth(renderHealthContext({ fetchImpl }));

  assert.equal(service.configured, false);
  assert.equal(service.live_api_connected, true);
  assert.equal(service.connection_label, 'Connected');
  assert.equal(service.source_label, 'Render status page');
  assert.equal(service.usage_summary.find((row) => row.label === 'Render platform status').value, 'All Systems Operational');
  assert.equal(service.diagnostics.render_api_connected, false);
  assert.equal(service.diagnostics.render_status_page_connected, true);
  assert.equal(service.diagnostics.render_status_indicator, 'none');
  assert.equal(service.readiness_items.find((row) => row.label === 'Credentials').status, 'Missing');
  assert.equal(service.readiness_items.find((row) => row.label === 'Render status page').status, 'Connected');
});

test('admin metrics AWS/S3 diagnostics align with recording storage env names', async () => {
  const sentCommands = [];
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      TAVUS_RECORDING_S3_BUCKET_NAME: 'recordings-secret-bucket',
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'aws-access-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key-secret',
      AWS_S3_BUCKET: 'wrong-generic-bucket',
    },
    liveChecksEnabled: true,
    cacheEnabled: false,
    awsS3ClientFactory: ({ region }) => ({
      send: async (command) => {
        sentCommands.push({ region, input: command.input });
        return {};
      },
    }),
  });

  const service = serviceByKey(payload, 'aws_s3');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.diagnostics.aws_key_source, 'explicit_credentials');
  assert.equal(service.diagnostics.aws_bucket_source, 'TAVUS_RECORDING_S3_BUCKET_NAME');
  assert.equal(service.diagnostics.aws_region_source, 'AWS_REGION');
  assert.equal(service.diagnostics.aws_health_check, 'head_bucket');
  assert.equal(service.diagnostics.aws_health_status, 'connected');
  assert.equal(service.diagnostics.aws_error_kind, null);
  assert.equal(service.diagnostics.aws_error_http_status, null);
  assert.equal(sentCommands[0].region, 'us-west-2');
  assert.equal(sentCommands[0].input.Bucket, 'recordings-secret-bucket');
  assert.doesNotMatch(JSON.stringify(payload), /recordings-secret-bucket|wrong-generic-bucket|aws-access-secret|aws-secret-key-secret/i);
});

test('admin metrics AWS/S3 diagnostics classify HeadBucket AccessDenied safely', async () => {
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      TAVUS_RECORDING_S3_BUCKET_NAME: 'recordings-secret-bucket',
      TAVUS_RECORDING_S3_BUCKET_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'aws-access-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key-secret',
    },
    liveChecksEnabled: true,
    cacheEnabled: false,
    awsS3ClientFactory: () => ({
      send: async () => {
        const error = new Error('raw aws access denied detail for recordings-secret-bucket');
        error.name = 'AccessDenied';
        error.$metadata = { httpStatusCode: 403 };
        throw error;
      },
    }),
  });

  const service = serviceByKey(payload, 'aws_s3');
  assert.equal(service.live_api_connected, false);
  assert.equal(service.diagnostics.aws_bucket_source, 'TAVUS_RECORDING_S3_BUCKET_NAME');
  assert.equal(service.diagnostics.aws_region_source, 'TAVUS_RECORDING_S3_BUCKET_REGION');
  assert.equal(service.diagnostics.aws_health_check, 'head_bucket');
  assert.equal(service.diagnostics.aws_health_status, 'failed');
  assert.equal(service.diagnostics.aws_error_kind, 'permission');
  assert.equal(service.diagnostics.aws_error_http_status, 403);
  assert.doesNotMatch(JSON.stringify(payload), /recordings-secret-bucket|aws-access-secret|aws-secret-key-secret|raw aws access denied detail/i);
});

test('email event taxonomy normalizes delivery, engagement, problem, and unknown events', () => {
  assert.equal(normalizeEmailEvent({ event_type: 'delivered' }), 'sent_delivered');
  assert.equal(normalizeEmailEvent({ event_type: 'click' }), 'engagement');
  assert.equal(normalizeEmailEvent({ event_type: 'dropped' }), 'problem');
  assert.equal(normalizeEmailEvent({ event_type: 'custom_event' }), 'unknown');
});
