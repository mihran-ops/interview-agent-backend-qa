'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');

const projectRoot = path.resolve(__dirname, '..');
const routePath = path.join(projectRoot, 'src', 'routes', 'automation', 'index.js');
const supabaseClientPath = path.join(projectRoot, 'src', 'clients', 'supabase.js');
const authMiddlewarePath = path.join(projectRoot, 'src', 'middleware', 'auth.js');
const mailerPath = path.join(projectRoot, 'src', 'clients', 'sendgrid.js');
const digestTokenHelpersPath = path.join(projectRoot, 'src', 'services', 'automationDigestApprovalTokens.js');
const sendgridMailPath = require.resolve('@sendgrid/mail');

const {
  createDigestApprovalTokenForDelivery,
  hashDigestApprovalToken,
  buildDigestApprovalItemId
} = require(digestTokenHelpersPath);
const {
  hashApprovalToken
} = require(path.join(projectRoot, 'src', 'services', 'automationApprovalTokens.js'));

const rawToken = 'digest-token-1234567890';
const now = Date.now();

function futureIso(hours = 1) {
  return new Date(now + hours * 60 * 60 * 1000).toISOString();
}

function pastIso(hours = 1) {
  return new Date(now - hours * 60 * 60 * 1000).toISOString();
}

function baseTokenRow(overrides = {}) {
  return {
    id: 'token-row-1',
    delivery_id: 'delivery-1',
    client_id: 'client-1',
    recipient_email: 'reviewer@example.com',
    token_hash: hashDigestApprovalToken(rawToken),
    token_purpose: 'pending_approval_digest',
    state: 'active',
    expires_at: futureIso(),
    item_salt: 'item-salt-12345678901234567890',
    last_viewed_at: null,
    view_count: 0,
    request_id: null,
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
    ...overrides,
  };
}

function baseDelivery(overrides = {}) {
  return {
    id: 'delivery-1',
    client_id: 'client-1',
    role_id: 'role-1',
    recipient_email: 'reviewer@example.com',
    digest_type: 'pending_approval',
    delivery_date: '2026-06-16',
    timezone: 'America/Denver',
    send_time_local: '09:00',
    status: 'sent',
    action_count: 2,
    action_ids: ['action-2', 'action-1'],
    request_id: 'digest-request-1',
    sent_at: '2026-06-16T09:00:00.000Z',
    failed_at: null,
    last_error: null,
    created_at: '2026-06-16T09:00:00.000Z',
    updated_at: '2026-06-16T09:00:00.000Z',
    ...overrides,
  };
}

function baseAction(id, overrides = {}) {
  return {
    id,
    evaluation_id: `evaluation-${id}`,
    rule_id: 'rule-1',
    rule_version: 1,
    client_id: 'client-1',
    role_id: 'role-1',
    candidate_id: `candidate-${id}`,
    report_id: `report-${id}`,
    interview_id: `interview-${id}`,
    action_type: 'send_second_round_scheduling_email',
    state: 'pending_approval',
    idempotency_key: `key-${id}`,
    candidate_snapshot: {
      candidate_name: id === 'action-1' ? 'Alex Candidate' : 'Jordan Applicant',
      role_title: 'Account Executive',
      candidate_email: `${id}@example.com`,
      overall_score: id === 'action-1' ? 85 : 91,
      resume_score: id === 'action-1' ? 82 : 90,
      interview_score: id === 'action-1' ? 88 : 93,
      content_sufficiency: {
        raw_notes: 'Do not expose.',
      },
      score_thresholds: {
        min_overall_score: 75,
      },
    },
    action_snapshot: {
      action_config: {
        scheduling_url: 'https://schedule.example.com/secret',
        rubric: {
          internal: true,
        },
      },
    },
    approved_by_user_id: null,
    approved_by_email: null,
    approved_at: null,
    rejected_at: null,
    canceled_at: null,
    sent_at: null,
    failed_at: null,
    last_error: null,
    send_attempt_count: 0,
    created_at: '2026-06-16T09:00:00.000Z',
    updated_at: '2026-06-16T09:00:00.000Z',
    ...overrides,
  };
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.operation = 'select';
    this.payload = null;
    this.selectedColumns = '';
  }

  select(columns) {
    this.selectedColumns = columns;
    this.db.selects.push({ table: this.table, columns });
    return this;
  }

  eq(column, value) {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }

  in(column, value) {
    this.filters.push({ op: 'in', column, value });
    return this;
  }

  is(column, value) {
    this.filters.push({ op: 'is', column, value });
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  insert(payload) {
    this.operation = 'insert';
    this.payload = payload;
    this.db.inserts.push({ table: this.table, payload });
    return this;
  }

  update(payload) {
    this.operation = 'update';
    this.payload = payload;
    this.db.updates.push({ table: this.table, payload });
    return this;
  }

  maybeSingle() {
    return Promise.resolve(this.db.resolve(this, true));
  }

  then(resolve, reject) {
    return Promise.resolve(this.db.resolve(this, false)).then(resolve, reject);
  }
}

class FakeDb {
  constructor({ tokenRow, delivery, deliveries, actions, candidates, rules, actionTokens } = {}) {
    this.tokenRow = tokenRow === undefined ? baseTokenRow() : tokenRow;
    this.delivery = delivery === undefined ? baseDelivery() : delivery;
    this.deliveries = deliveries === undefined
      ? (this.delivery ? [this.delivery] : [])
      : deliveries;
    this.digestTokens = this.tokenRow ? [this.tokenRow] : [];
    this.actions = actions === undefined
      ? [
        baseAction('action-1'),
        baseAction('action-2', { state: 'sent' }),
        baseAction('action-outside-delivery', {
          candidate_snapshot: {
            candidate_name: 'Outside Candidate',
            role_title: 'Account Executive',
          },
        }),
      ]
      : actions;
    this.candidates = candidates === undefined
      ? [
        { id: 'candidate-action-1', client_id: 'client-1', role_id: 'role-1', name: 'Alex Candidate', email: 'alex@example.com' },
        { id: 'candidate-action-2', client_id: 'client-1', role_id: 'role-1', name: 'Jordan Applicant', email: 'jordan@example.com' },
        {
          id: 'candidate-action-outside-delivery',
          client_id: 'client-1',
          role_id: 'role-1',
          name: 'Outside Candidate',
          email: 'outside@example.com',
        },
      ]
      : candidates;
    this.rules = rules === undefined
      ? [
        {
          id: 'rule-1',
          name: 'Digest rule',
          client_id: 'client-1',
          role_id: 'role-1',
          enabled: true,
          mode: 'daily_digest_pending_approval',
          criteria_config: {},
          action_config: {},
          digest_config: {
            pending_approval_digest: {
              enabled: true,
              recipient_emails: ['reviewer@example.com'],
              recipient_names: {
                'reviewer@example.com': 'Reviewer',
              },
              approval_base_url: 'https://app.example.com',
            },
          },
          rule_version: 1,
          archived_at: null,
          created_at: '2026-06-16T00:00:00.000Z',
          updated_at: '2026-06-16T00:00:00.000Z',
        },
      ]
      : rules;
    this.actionTokens = actionTokens === undefined ? [] : actionTokens;
    this.events = [];
    this.inserts = [];
    this.updates = [];
    this.selects = [];
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  findFilter(query, column, op = 'eq') {
    return query.filters.find((filter) => filter.op === op && filter.column === column);
  }

  resolve(query, single) {
    if (query.table === 'automation_digest_approval_tokens') {
      return this.resolveTokenQuery(query);
    }
    if (query.table === 'automation_digest_deliveries') {
      return this.resolveDeliveryQuery(query);
    }
    if (query.table === 'automation_actions') {
      return this.resolveActionsQuery(query, single);
    }
    if (query.table === 'automation_action_events') {
      return this.resolveEventQuery(query);
    }
    if (query.table === 'automation_action_approval_tokens') {
      return this.resolveActionApprovalTokenQuery(query);
    }
    if (query.table === 'automation_rules') {
      return this.resolveRulesQuery(query, single);
    }
    if (query.table === 'roles') {
      return { data: single ? { id: 'role-1', client_id: 'client-1', title: 'Account Executive' } : [], error: null };
    }
    if (query.table === 'candidates') {
      return this.resolveCandidateQuery(query);
    }
    return { data: single ? null : [], error: null };
  }

  resolveTokenQuery(query) {
    if (query.operation === 'insert') {
      const token = {
        id: `created-digest-token-${this.digestTokens.length + 1}`,
        ...query.payload,
        last_viewed_at: null,
        view_count: 0,
        created_at: '2026-06-16T00:00:00.000Z',
        updated_at: '2026-06-16T00:00:00.000Z',
      };
      this.digestTokens.push(token);
      return {
        data: token,
        error: null,
      };
    }
    if (query.operation === 'update') {
      const token = this.digestTokens.find((row) => this.matchesFilters(row, query.filters));
      if (!token) return { data: null, error: null };
      Object.assign(token, query.payload);
      if (this.tokenRow?.id === token.id) this.tokenRow = token;
      return { data: token, error: null };
    }

    const hash = this.findFilter(query, 'token_hash')?.value;
    const token = this.digestTokens.find((row) => row.token_hash === hash);
    if (!token) {
      return { data: null, error: null };
    }
    return { data: token, error: null };
  }

  resolveActionApprovalTokenQuery(query) {
    if (query.operation === 'insert') {
      const token = {
        id: `created-action-token-${this.actionTokens.length + 1}`,
        used_at: null,
        last_viewed_at: null,
        view_count: 0,
        rejected_at: null,
        created_at: '2026-06-16T00:00:00.000Z',
        updated_at: '2026-06-16T00:00:00.000Z',
        ...query.payload,
      };
      this.actionTokens.push(token);
      return { data: token, error: null };
    }
    if (query.operation === 'update') {
      const token = this.actionTokens.find((row) => this.matchesFilters(row, query.filters));
      if (!token) return { data: null, error: null };
      Object.assign(token, query.payload);
      return { data: token, error: null };
    }

    const token = this.actionTokens.find((row) => this.matchesFilters(row, query.filters));
    return { data: token || null, error: null };
  }

  resolveDeliveryQuery(query) {
    if (query.operation === 'insert') {
      const delivery = {
        id: `created-delivery-${this.deliveries.length + 1}`,
        sent_at: null,
        failed_at: null,
        last_error: null,
        created_at: '2026-06-16T09:00:00.000Z',
        updated_at: '2026-06-16T09:00:00.000Z',
        ...query.payload,
      };
      this.deliveries.push(delivery);
      return { data: delivery, error: null };
    }
    if (query.operation === 'update') {
      const delivery = this.deliveries.find((row) => this.matchesFilters(row, query.filters));
      if (!delivery) return { data: null, error: null };
      Object.assign(delivery, query.payload);
      if (this.delivery?.id === delivery.id) this.delivery = delivery;
      return { data: delivery, error: null };
    }
    const rows = this.deliveries.filter((delivery) => this.matchesFilters(delivery, query.filters));
    return { data: rows[0] || null, error: null };
  }

  resolveActionsQuery(query, single) {
    if (query.operation === 'update') {
      const action = this.actions.find((row) => this.matchesFilters(row, query.filters));
      if (!action) return { data: null, error: null };
      Object.assign(action, query.payload);
      return { data: { ...action }, error: null };
    }

    const rows = this.actions.filter((action) => this.matchesFilters(action, query.filters));
    return { data: single ? rows[0] || null : rows, error: null };
  }

  resolveEventQuery(query) {
    if (query.operation !== 'insert') return { data: null, error: null };
    const event = {
      id: `event-${this.events.length + 1}`,
      created_at: '2026-06-16T09:00:00.000Z',
      ...query.payload,
    };
    this.events.push(event);
    return { data: event, error: null };
  }

  resolveCandidateQuery(query) {
    const row = this.candidates.find((candidate) => this.matchesFilters(candidate, query.filters));
    return { data: row || null, error: null };
  }

  resolveRulesQuery(query, single) {
    const rows = this.rules.filter((rule) => this.matchesFilters(rule, query.filters));
    return { data: single ? rows[0] || null : rows, error: null };
  }

  matchesFilters(row, filters) {
    return filters.every((filter) => {
      if (filter.op === 'eq') return row[filter.column] === filter.value;
      if (filter.op === 'is') return row[filter.column] === filter.value;
      if (filter.op === 'in') {
        const values = Array.isArray(filter.value) ? filter.value : [];
        return values.includes(row[filter.column]);
      }
      return true;
    });
  }
}

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

function buildApp(db, mailer = {}) {
  // The router is assembled from several files that each cache the modules stubbed
  // below, so every first-party module reloads on each build.
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(projectRoot) && !cached.includes('node_modules')) {
      delete require.cache[cached]
    }
  }
  delete require.cache[routePath];
  delete require.cache[supabaseClientPath];
  delete require.cache[authMiddlewarePath];
  delete require.cache[mailerPath];

  injectModule(supabaseClientPath, { supabaseAdmin: db });
  injectModule(authMiddlewarePath, {
    requireAuth: (req, _res, next) => {
      req.user = { id: 'user-1', email: 'user@example.com' };
      req.isGlobalAdmin = true;
      req.isAdmin = true;
      return next();
    },
    withClientScope: (_req, _res, next) => next(),
  });
  injectModule(mailerPath, mailer);

  const router = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/automation', router);
  return app;
}

function itemIdFor(actionId, tokenRow = baseTokenRow()) {
  return buildDigestApprovalItemId(tokenRow.item_salt, actionId);
}

function assertSafeDigestActionResponse(body) {
  const bodyText = JSON.stringify(body);
  assert.ok(!bodyText.includes('action-1'));
  assert.ok(!bodyText.includes('action-2'));
  assert.ok(!bodyText.includes('delivery-1'));
  assert.ok(!bodyText.includes(rawToken));
  assert.ok(!bodyText.includes('token_hash'));
  assert.ok(!bodyText.includes('candidate_email'));
  assert.ok(!bodyText.includes('alex@example.com'));
  assert.ok(!bodyText.includes('jordan@example.com'));
  assert.ok(!bodyText.includes('schedule.example.com'));
  assert.ok(!bodyText.includes('content_sufficiency'));
  assert.ok(!bodyText.includes('score_thresholds'));
  assert.ok(!bodyText.includes('rubric'));
}

function createMailerStub(options = {}) {
  const sent = [];
  const pendingDigests = [];
  return {
    sent,
    pendingDigests,
    async sendSecondRoundSchedulingEmail(email, payload) {
      sent.push({ email, payload });
      return { ok: true };
    },
    async sendPendingApprovalDigestEmail(email, payload) {
      pendingDigests.push({ email, payload });
      if (options.digestThrows) throw new Error('send failed');
      if (options.digestSkipped) return { skipped: true };
      return { ok: true };
    },
  };
}

async function request(app, method, pathname, body = null) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('createDigestApprovalTokenForDelivery stores only token hash', async () => {
  const db = new FakeDb();

  const outcome = await createDigestApprovalTokenForDelivery({
    db,
    delivery: {
      id: 'delivery-create-1',
      client_id: 'client-1',
      recipient_email: 'Reviewer@Example.com ',
    },
    requestId: 'request-1',
  });

  assert.equal(typeof outcome.token, 'string');
  assert.ok(outcome.token.length >= 40);

  const insert = db.inserts.find((entry) => entry.table === 'automation_digest_approval_tokens');
  assert.ok(insert);
  assert.equal(insert.payload.delivery_id, 'delivery-create-1');
  assert.equal(insert.payload.client_id, 'client-1');
  assert.equal(insert.payload.recipient_email, 'reviewer@example.com');
  assert.equal(insert.payload.token_purpose, 'pending_approval_digest');
  assert.equal(insert.payload.state, 'active');
  assert.equal(insert.payload.token_hash, hashDigestApprovalToken(outcome.token));
  assert.notEqual(insert.payload.token_hash, outcome.token);
  assert.ok(!Object.values(insert.payload).includes(outcome.token));
  assert.ok(insert.payload.item_salt);
});

test('direct legacy action approval token creation requires explicit opt-in', async () => {
  const db = new FakeDb();
  const result = await request(
    buildApp(db),
    'POST',
    '/api/automation/actions/action-1/approval-token',
    {
      recipient_email: 'reviewer@example.com',
    }
  );

  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'legacy_action_approval_link_requires_explicit_opt_in');
  assert.match(result.body.detail, /Action-level approval links are legacy/);
  assert.equal(db.inserts.filter((entry) => entry.table === 'automation_action_approval_tokens').length, 0);
});

test('direct legacy action approval token creation works with explicit opt-in metadata', async () => {
  const db = new FakeDb();
  const result = await request(
    buildApp(db),
    'POST',
    '/api/automation/actions/action-1/approval-token',
    {
      allow_legacy_action_approval_link: true,
      recipient_email: 'Reviewer@Example.com ',
    }
  );

  assert.equal(result.status, 201);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.legacy, true);
  assert.equal(result.body.emails_sent_on_confirm, false);
  assert.match(result.body.approval_url_path, /^\/automation\/approval\//);
  assert.ok(!JSON.stringify(result.body).includes('/automation/digest-approval/'));

  const tokenInsert = db.inserts.find((entry) => entry.table === 'automation_action_approval_tokens');
  assert.ok(tokenInsert);
  assert.equal(tokenInsert.payload.action_id, 'action-1');
  assert.equal(tokenInsert.payload.client_id, 'client-1');
  assert.equal(tokenInsert.payload.recipient_email, 'Reviewer@Example.com');
  assert.equal(tokenInsert.payload.token_hash, hashApprovalToken(result.body.token));
  assert.ok(!JSON.stringify(tokenInsert.payload).includes(result.body.token));

  const event = db.events.find((entry) => entry.event_type === 'legacy_action_approval_token_created');
  assert.ok(event);
  assert.equal(event.action_id, 'action-1');
  assert.equal(event.metadata.explicit_legacy_opt_in, true);
  assert.equal(event.metadata.approval_link_type, 'legacy_action');
  assert.equal(event.metadata.emails_sent_on_confirm, false);
});

test('public legacy approval GET returns minimized safe candidate summary', async () => {
  const db = new FakeDb();
  const app = buildApp(db);
  const created = await request(
    app,
    'POST',
    '/api/automation/actions/action-1/approval-token',
    {
      allow_legacy_action_approval_link: true,
      recipient_email: 'reviewer@example.com',
    }
  );

  assert.equal(created.status, 201);
  const result = await request(
    app,
    'GET',
    `/api/automation/approval/${encodeURIComponent(created.body.token)}`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.item.candidate_name, 'Alex Candidate');
  assert.equal(result.body.item.role_title, 'Account Executive');
  assert.equal(result.body.item.scores.overall_score, 85);

  const bodyText = JSON.stringify(result.body);
  assert.ok(!Object.prototype.hasOwnProperty.call(result.body.item, 'action_id'));
  assert.ok(!Object.prototype.hasOwnProperty.call(result.body.item, 'content_sufficiency'));
  assert.ok(!bodyText.includes('action-1'));
  assert.ok(!bodyText.includes(created.body.token));
  assert.ok(!bodyText.includes('token_hash'));
  assert.ok(!bodyText.includes('created-action-token'));
  assert.ok(!bodyText.includes('candidate_email'));
  assert.ok(!bodyText.includes('raw_notes'));
  assert.ok(!bodyText.includes('score_thresholds'));
  assert.ok(!bodyText.includes('rubric'));
});

test('public legacy approval confirm still approves without sending email', async () => {
  const db = new FakeDb();
  const app = buildApp(db);
  const created = await request(
    app,
    'POST',
    '/api/automation/actions/action-1/approval-token',
    {
      allow_legacy_action_approval_link: true,
      recipient_email: 'reviewer@example.com',
    }
  );

  assert.equal(created.status, 201);
  const confirmed = await request(
    app,
    'POST',
    `/api/automation/approval/${encodeURIComponent(created.body.token)}/confirm`
  );

  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.ok, true);
  assert.equal(confirmed.body.state, 'approved');
  assert.equal(confirmed.body.side_effects.emails_sent, 0);
  assert.equal(confirmed.body.side_effects.digests_sent, 0);
  assert.equal(db.actions.find((action) => action.id === 'action-1').state, 'approved');
  assert.equal(db.actionTokens[0].state, 'used');
  assert.deepEqual(db.events.map((event) => event.event_type), [
    'legacy_action_approval_token_created',
    'action_approved_from_approval_token',
  ]);
});

test('configured digest email creates one delivery token and one digest review URL', async () => {
  const db = new FakeDb({
    tokenRow: null,
    delivery: null,
    actions: [
      baseAction('action-1'),
      baseAction('action-2'),
    ],
  });
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    '/api/automation/actions/send-configured-pending-approval-digests',
    {
      client_id: 'client-1',
      approval_base_url_override: 'https://app.example.com',
    }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.side_effects.emails_sent, 1);
  assert.equal(result.body.side_effects.digests_sent, 1);
  assert.equal(mailer.pendingDigests.length, 1);

  const tokenInserts = db.inserts.filter((entry) => entry.table === 'automation_digest_approval_tokens');
  assert.equal(tokenInserts.length, 1);
  const deliveryInsert = db.inserts.find((entry) => entry.table === 'automation_digest_deliveries');
  assert.ok(deliveryInsert);
  assert.equal(tokenInserts[0].payload.delivery_id, 'created-delivery-1');
  assert.equal(tokenInserts[0].payload.token_purpose, 'pending_approval_digest');
  assert.equal(tokenInserts[0].payload.state, 'active');

  const payloadText = JSON.stringify(tokenInserts[0].payload);
  const digestUrl = mailer.pendingDigests[0].payload.digestApprovalUrl;
  const rawTokenFromUrl = digestUrl.split('/').pop();
  assert.match(digestUrl, /^https:\/\/app\.example\.com\/automation\/digest-approval\//);
  assert.equal(tokenInserts[0].payload.token_hash, hashDigestApprovalToken(rawTokenFromUrl));
  assert.ok(!payloadText.includes(rawTokenFromUrl));
  assert.ok(!JSON.stringify(result.body).includes(rawTokenFromUrl));
  assert.ok(!JSON.stringify(result.body).includes('/automation/digest-approval/'));
  assert.equal(mailer.pendingDigests[0].payload.actions.length, 2);
  assert.ok(mailer.pendingDigests[0].payload.actions.every((item) => item.approval_url === undefined));
  assert.ok(!JSON.stringify(mailer.pendingDigests[0].payload.actions).includes('/automation/approval/'));
});

test('configured digest email retry skips existing sent delivery without duplicate token or send', async () => {
  const db = new FakeDb({
    tokenRow: null,
    delivery: null,
    actions: [
      baseAction('action-1'),
      baseAction('action-2'),
    ],
  });
  const mailer = createMailerStub();
  const app = buildApp(db, mailer);
  const body = {
    client_id: 'client-1',
    approval_base_url_override: 'https://app.example.com',
  };

  const first = await request(app, 'POST', '/api/automation/actions/send-configured-pending-approval-digests', body);
  const second = await request(app, 'POST', '/api/automation/actions/send-configured-pending-approval-digests', body);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.side_effects.digests_sent, 1);
  assert.equal(second.body.side_effects.digests_sent, 0);
  assert.equal(second.body.digests[0].delivery_status, 'already_sent');
  assert.equal(mailer.pendingDigests.length, 1);
  assert.equal(db.inserts.filter((entry) => entry.table === 'automation_digest_approval_tokens').length, 1);
});

test('configured digest email failure revokes delivery token', async () => {
  const db = new FakeDb({
    tokenRow: null,
    delivery: null,
    actions: [
      baseAction('action-1'),
      baseAction('action-2'),
    ],
  });
  const mailer = createMailerStub({ digestSkipped: true });
  const originalConsoleError = console.error;
  let result;
  console.error = () => {};
  try {
    result = await request(
      buildApp(db, mailer),
      'POST',
      '/api/automation/actions/send-configured-pending-approval-digests',
      {
        client_id: 'client-1',
        approval_base_url_override: 'https://app.example.com',
      }
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(result.status, 503);
  const createdToken = db.digestTokens.find((token) => token.id === 'created-digest-token-1');
  assert.ok(createdToken);
  assert.equal(createdToken.state, 'revoked');
  assert.equal(db.deliveries.find((delivery) => delivery.id === 'created-delivery-1').status, 'failed');
});

test('manual pending approval digest creates one delivery token and one digest review URL', async () => {
  const db = new FakeDb({
    tokenRow: null,
    delivery: null,
    actions: [
      baseAction('action-1'),
      baseAction('action-2'),
    ],
  });
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    '/api/automation/actions/send-pending-approval-digest',
    {
      client_id: 'client-1',
      role_id: 'role-1',
      recipient_email: 'Reviewer@Example.com ',
      recipient_name: 'Reviewer',
      approval_base_url: 'https://app.example.com',
      limit: 10,
    }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.items_count, 2);
  assert.equal(result.body.delivery_status, 'sent');
  assert.equal(result.body.side_effects.emails_sent, 1);
  assert.equal(result.body.side_effects.digests_sent, 1);
  assert.equal(mailer.pendingDigests.length, 1);

  const deliveryInsert = db.inserts.find((entry) => entry.table === 'automation_digest_deliveries');
  assert.ok(deliveryInsert);
  assert.equal(deliveryInsert.payload.client_id, 'client-1');
  assert.equal(deliveryInsert.payload.role_id, 'role-1');
  assert.equal(deliveryInsert.payload.recipient_email, 'reviewer@example.com');
  assert.equal(deliveryInsert.payload.digest_type, 'pending_approval');
  assert.equal(deliveryInsert.payload.status, 'sending');
  assert.equal(deliveryInsert.payload.timezone, 'America/Denver');
  assert.match(deliveryInsert.payload.send_time_local, /^(?:[01]\d|2[0-3]):[0-5]\d$/);

  const sentDelivery = db.deliveries.find((delivery) => delivery.id === 'created-delivery-1');
  assert.equal(sentDelivery.status, 'sent');
  assert.equal(sentDelivery.action_count, 2);
  assert.deepEqual(sentDelivery.action_ids, ['action-1', 'action-2']);

  const tokenInserts = db.inserts.filter((entry) => entry.table === 'automation_digest_approval_tokens');
  assert.equal(tokenInserts.length, 1);
  assert.equal(tokenInserts[0].payload.delivery_id, 'created-delivery-1');
  assert.equal(tokenInserts[0].payload.token_purpose, 'pending_approval_digest');
  assert.equal(tokenInserts[0].payload.state, 'active');

  const digestUrl = mailer.pendingDigests[0].payload.digestApprovalUrl;
  const rawTokenFromUrl = digestUrl.split('/').pop();
  assert.match(digestUrl, /^https:\/\/app\.example\.com\/automation\/digest-approval\//);
  assert.equal(tokenInserts[0].payload.token_hash, hashDigestApprovalToken(rawTokenFromUrl));
  assert.ok(!JSON.stringify(tokenInserts[0].payload).includes(rawTokenFromUrl));
  assert.ok(!JSON.stringify(result.body).includes(rawTokenFromUrl));
  assert.ok(!JSON.stringify(result.body).includes('/automation/digest-approval/'));
  assert.equal(mailer.pendingDigests[0].payload.actions.length, 2);
  assert.ok(mailer.pendingDigests[0].payload.actions.every((item) => item.approval_url === undefined));
  assert.ok(result.body.items.every((item) => item.approval_url === undefined));
  assert.ok(!JSON.stringify(mailer.pendingDigests[0].payload).includes('/automation/approval/'));
  assert.ok(!JSON.stringify(result.body).includes('/automation/approval/'));
});

test('manual pending approval digest retry skips existing sent delivery without duplicate token or send', async () => {
  const db = new FakeDb({
    tokenRow: null,
    delivery: null,
    actions: [
      baseAction('action-1'),
      baseAction('action-2'),
    ],
  });
  const mailer = createMailerStub();
  const app = buildApp(db, mailer);
  const body = {
    client_id: 'client-1',
    role_id: 'role-1',
    recipient_email: 'reviewer@example.com',
    recipient_name: 'Reviewer',
    approval_base_url: 'https://app.example.com',
    limit: 10,
  };

  const first = await request(app, 'POST', '/api/automation/actions/send-pending-approval-digest', body);
  const second = await request(app, 'POST', '/api/automation/actions/send-pending-approval-digest', body);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.side_effects.digests_sent, 1);
  assert.equal(second.body.side_effects.digests_sent, 0);
  assert.equal(second.body.delivery_status, 'already_sent');
  assert.equal(mailer.pendingDigests.length, 1);
  assert.equal(db.inserts.filter((entry) => entry.table === 'automation_digest_deliveries').length, 1);
  assert.equal(db.inserts.filter((entry) => entry.table === 'automation_digest_approval_tokens').length, 1);
});

test('manual pending approval digest failure revokes delivery token and marks delivery failed', async () => {
  const db = new FakeDb({
    tokenRow: null,
    delivery: null,
    actions: [
      baseAction('action-1'),
      baseAction('action-2'),
    ],
  });
  const mailer = createMailerStub({ digestSkipped: true });
  const result = await request(
    buildApp(db, mailer),
    'POST',
    '/api/automation/actions/send-pending-approval-digest',
    {
      client_id: 'client-1',
      role_id: 'role-1',
      recipient_email: 'reviewer@example.com',
      recipient_name: 'Reviewer',
      approval_base_url: 'https://app.example.com',
      limit: 10,
    }
  );

  assert.equal(result.status, 503);
  assert.equal(mailer.pendingDigests.length, 1);
  const createdToken = db.digestTokens.find((token) => token.id === 'created-digest-token-1');
  assert.ok(createdToken);
  assert.equal(createdToken.state, 'revoked');
  assert.equal(db.deliveries.find((delivery) => delivery.id === 'created-delivery-1').status, 'failed');
});

test('sendPendingApprovalDigestEmail renders one digest-level CTA without per-action links', async () => {
  const originalApiKey = process.env.SENDGRID_API_KEY;
  const sentMessages = [];
  delete require.cache[mailerPath];
  delete require.cache[sendgridMailPath];
  injectModule(sendgridMailPath, {
    setApiKey() {},
    async send(message) {
      sentMessages.push(message);
      return [{ statusCode: 202 }];
    },
  });
  process.env.SENDGRID_API_KEY = 'test-key';
  try {
    const { sendPendingApprovalDigestEmail } = require(mailerPath);
    await sendPendingApprovalDigestEmail('reviewer@example.com', {
      recipientName: 'Reviewer',
      clientId: 'client-1',
      roleId: 'role-1',
      digestActionCount: 2,
      digestApprovalUrl: 'https://app.example.com/automation/digest-approval/raw-digest-token',
      actions: [
        {
          candidate_name: 'Alex Candidate',
          role_title: 'Account Executive',
          approval_url: 'https://app.example.com/automation/approval/action-token-1',
        },
        {
          candidate_name: 'Jordan Applicant',
          role_title: 'Account Executive',
          approval_url: 'https://app.example.com/automation/approval/action-token-2',
        },
      ],
    });
  } finally {
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = originalApiKey;
    delete require.cache[mailerPath];
    delete require.cache[sendgridMailPath];
  }

  assert.equal(sentMessages.length, 1);
  const messageText = `${sentMessages[0].text}\n${sentMessages[0].html}`;
  assert.match(messageText, /Review candidates/);
  assert.match(messageText, /Open the review page to approve or decline each candidate/);
  assert.match(messageText, /Approving a candidate sends the second-round scheduling email/);
  assert.equal((messageText.match(/automation\/digest-approval\/raw-digest-token/g) || []).length, 2);
  assert.ok(!messageText.includes('automation/approval/action-token-1'));
  assert.ok(!messageText.includes('automation/approval/action-token-2'));
  assert.ok(!messageText.includes('Review approval'));
});

test('GET /api/automation/digest-approval/:token returns multiple safe items', async () => {
  const db = new FakeDb();
  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.item.expires_at, db.tokenRow.expires_at);
  assert.equal(result.body.item.items.length, 2);
  assert.equal(result.body.item.items[0].candidate_name, 'Jordan Applicant');
  assert.equal(result.body.item.items[0].status, 'approved_or_sent');
  assert.equal(result.body.item.items[1].candidate_name, 'Alex Candidate');
  assert.equal(result.body.item.items[1].status, 'pending');
  assert.equal(result.body.item.items[1].can_approve_send, true);
  assert.equal(result.body.item.items[1].scores.overall_score, 85);

  const actionSelect = db.selects.find((entry) => entry.table === 'automation_actions')?.columns || '';
  assert.match(actionSelect, /\bcandidate_snapshot\b/);
  assert.doesNotMatch(actionSelect, /\baction_snapshot\b/);
  assert.doesNotMatch(actionSelect, /\bcandidate_id\b/);

  const itemIds = result.body.item.items.map((item) => item.item_id);
  assert.equal(new Set(itemIds).size, 2);
  assert.ok(itemIds.every((itemId) => typeof itemId === 'string' && itemId.length === 64));
  assert.ok(!itemIds.includes('action-1'));
  assert.ok(!itemIds.includes('action-2'));

  const bodyText = JSON.stringify(result.body);
  assert.ok(!bodyText.includes('action-1'));
  assert.ok(!bodyText.includes('action-2'));
  assert.ok(!bodyText.includes('action-outside-delivery'));
  assert.ok(!bodyText.includes('delivery-1'));
  assert.ok(!bodyText.includes(rawToken));
  assert.ok(!bodyText.includes('token_hash'));
  assert.ok(!bodyText.includes('candidate_email'));
  assert.ok(!bodyText.includes('schedule.example.com'));
  assert.ok(!bodyText.includes('content_sufficiency'));
  assert.ok(!bodyText.includes('score_thresholds'));
  assert.ok(!bodyText.includes('rubric'));

  assert.equal(db.tokenRow.view_count, 1);
  assert.ok(db.tokenRow.last_viewed_at);
  assert.equal(db.updates.length, 1);
});

test('GET /api/automation/digest-approval/:token returns only delivery action_ids', async () => {
  const db = new FakeDb({
    delivery: baseDelivery({ action_ids: ['action-1'] }),
  });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.item.items.length, 1);
  assert.equal(result.body.item.items[0].candidate_name, 'Alex Candidate');
  assert.ok(!JSON.stringify(result.body).includes('Jordan Applicant'));
});

test('GET /api/automation/digest-approval/:token rejects expired token', async () => {
  const db = new FakeDb({
    tokenRow: baseTokenRow({ expires_at: pastIso() }),
  });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 410);
  assert.equal(result.body.code, 'digest_approval_token_expired');
  assert.equal(db.updates.length, 0);
});

test('GET /api/automation/digest-approval/:token rejects invalid token', async () => {
  const db = new FakeDb({ tokenRow: null });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_token_invalid');
  assert.equal(db.updates.length, 0);
});

test('GET /api/automation/digest-approval/:token rejects unavailable delivery', async () => {
  const db = new FakeDb({
    delivery: baseDelivery({ status: 'failed' }),
  });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_unavailable');
  assert.equal(db.updates.length, 0);
});

test('GET /api/automation/digest-approval/:token does not mark unavailable reads viewed', async () => {
  const db = new FakeDb({
    actions: [],
  });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_unavailable');
  assert.equal(db.tokenRow.view_count, 0);
  assert.equal(db.updates.length, 0);
});

test('POST digest approve-send sends exactly once for pending action', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/approve-send`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.item.item_id, itemIdFor('action-1'));
  assert.equal(result.body.item.status, 'sent');
  assert.equal(result.body.item.can_approve_send, false);
  assert.equal(result.body.item.can_reject, false);
  assert.equal(result.body.side_effects.emails_sent, 1);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].email, 'alex@example.com');
  assert.equal(db.actions.find((action) => action.id === 'action-1').state, 'sent');
  assert.deepEqual(db.events.map((event) => event.event_type), [
    'action_approved_from_digest_approval_token',
    'candidate_scheduling_email_sent',
  ]);
  assertSafeDigestActionResponse(result.body);
});

test('POST digest approve-send retry does not send duplicate email', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const app = buildApp(db, mailer);
  const path = `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/approve-send`;

  const first = await request(app, 'POST', path);
  const second = await request(app, 'POST', path);

  assert.equal(first.status, 200);
  assert.equal(first.body.side_effects.emails_sent, 1);
  assert.equal(second.status, 200);
  assert.equal(second.body.item.status, 'sent');
  assert.equal(second.body.side_effects.emails_sent, 0);
  assert.equal(mailer.sent.length, 1);
  assertSafeDigestActionResponse(second.body);
});

test('POST digest approve-send rejects item outside digest', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-outside-delivery')}/approve-send`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_item_unavailable');
  assert.equal(mailer.sent.length, 0);
});

test('POST digest approve-send rejects expired token', async () => {
  const db = new FakeDb({
    tokenRow: baseTokenRow({ expires_at: pastIso() }),
  });
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/approve-send`
  );

  assert.equal(result.status, 410);
  assert.equal(result.body.code, 'digest_approval_token_expired');
  assert.equal(mailer.sent.length, 0);
});

test('POST digest approve-send rejects invalid token', async () => {
  const db = new FakeDb({ tokenRow: null });
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/approve-send`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_token_invalid');
  assert.equal(mailer.sent.length, 0);
});

test('POST digest reject marks pending action rejected and sends no email', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/reject`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.item.item_id, itemIdFor('action-1'));
  assert.equal(result.body.item.status, 'rejected');
  assert.equal(result.body.side_effects.emails_sent, 0);
  assert.equal(mailer.sent.length, 0);
  assert.equal(db.actions.find((action) => action.id === 'action-1').state, 'rejected');
  assert.deepEqual(db.events.map((event) => event.event_type), [
    'action_rejected_from_digest_approval_token',
  ]);
  assertSafeDigestActionResponse(result.body);
});

test('POST digest reject is idempotent for already rejected action', async () => {
  const db = new FakeDb({
    actions: [
      baseAction('action-1', { state: 'rejected' }),
      baseAction('action-2', { state: 'sent' }),
    ],
  });
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/reject`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.item.status, 'rejected');
  assert.equal(result.body.side_effects.emails_sent, 0);
  assert.equal(db.events.length, 0);
  assert.equal(mailer.sent.length, 0);
  assertSafeDigestActionResponse(result.body);
});

test('POST digest reject conflicts after action was sent', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-2')}/reject`
  );

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'automation_digest_approval_action_already_sent');
  assert.equal(mailer.sent.length, 0);
});
