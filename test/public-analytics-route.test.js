'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');

const routePath = path.join(__dirname, '..', 'src', 'routes', 'public', 'analytics.js');
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js');

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

function makeDb(options = {}) {
  const db = {
    inserts: [],
    error: options.error || null,
    from(table) {
      return {
        insert: async (rows) => {
          db.inserts.push({ table, rows });
          return { error: db.error };
        },
      };
    },
  };
  return db;
}

function buildApp(db) {
  delete require.cache[routePath];
  delete require.cache[supabaseClientPath];

  injectModule(supabaseClientPath, { supabaseAdmin: db });

  const router = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/public-analytics', router);
  return app;
}

async function request(app, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/public-analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('public analytics route accepts valid event and stores only allowed safe properties', async () => {
  const db = makeDb();
  const app = buildApp(db);
  const response = await request(app, {
    event_name: 'cta_clicked',
    anonymous_id: 'anon-123',
    session_id: 'session-123',
    path: 'https://www.alphasourceai.com/?secret=drop',
    page_title: 'alphaScreen',
    referrer_path: 'https://www.alphasourceai.com/alphascreen?token=drop',
    utm: {
      utm_source: 'newsletter',
      utm_campaign: 'x'.repeat(220),
      utm_secret: 'drop-me',
      raw_payload: { nested: true },
    },
    properties: {
      cta_label: 'Request a Demo'.padEnd(260, '!'),
      cta_target: 'https://www.alphasourceai.com/contact?token=drop#demo',
      placement: 'hero',
      unknown: 'drop-me',
      token: 'drop-me',
      session: 'drop-me',
      metadata: { nested: true },
      flags: ['drop-me'],
    },
    occurred_at: '2026-06-22T12:00:00.000Z',
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, 1);
  assert.equal(db.inserts.length, 1);
  assert.equal(db.inserts[0].table, 'public_analytics_events');
  assert.equal(db.inserts[0].rows.length, 1);

  const row = db.inserts[0].rows[0];
  assert.equal(row.event_name, 'cta_clicked');
  assert.equal(row.path, '/');
  assert.equal(row.referrer_path, '/alphascreen');
  assert.deepEqual(Object.keys(row.properties).sort(), ['cta_label', 'cta_target', 'placement']);
  assert.equal(row.properties.cta_label.length, 180);
  assert.equal(row.properties.cta_target, '/contact');
  assert.equal(row.properties.placement, 'hero');
  assert.deepEqual(Object.keys(row.utm).sort(), ['utm_campaign', 'utm_source']);
  assert.equal(row.utm.utm_campaign.length, 180);
  assert.doesNotMatch(JSON.stringify(row), /drop-me|raw_payload|metadata|flags|utm_secret/i);
});

test('public analytics route rejects unknown event names without inserting', async () => {
  const db = makeDb();
  const app = buildApp(db);
  const response = await request(app, {
    event_name: 'arbitrary_payload_event',
    path: '/',
    properties: {
      cta_label: 'Should not insert',
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid_event');
  assert.equal(db.inserts.length, 0);
});

test('public analytics route accepts the pricing-page signup back event', async () => {
  const db = makeDb();
  const app = buildApp(db);
  const response = await request(app, {
    event_name: 'signup_back_clicked',
    path: '/alphascreen/pricing',
    properties: {
      plan: 'basic',
      step: 'agreement_created',
    },
  });

  assert.equal(response.status, 202);
  assert.deepEqual(db.inserts[0].rows[0].properties, {
    plan: 'basic',
    step: 'agreement_created',
  });
});

test('public analytics route bounds and sanitizes allowed array properties', async () => {
  const db = makeDb();
  const app = buildApp(db);
  const fields = Array.from({ length: 25 }, (_, index) => `field_${index}`);
  const response = await request(app, {
    event_name: 'lead_form_abandoned',
    path: '/alphascreen',
    properties: {
      form_id: 'demo-form',
      form_type: 'demo',
      product_interest: 'alphaScreen',
      fields_completed: [...fields, 'field_1', '', null, { nested: true }],
      message_body: 'drop-me',
      password: 'drop-me',
    },
    occurred_at: '2026-06-22T12:00:00.000Z',
  });

  assert.equal(response.status, 202);
  const row = db.inserts[0].rows[0];
  assert.equal(row.properties.form_id, 'demo-form');
  assert.equal(row.properties.form_type, 'demo');
  assert.equal(row.properties.product_interest, 'alphaScreen');
  assert.equal(row.properties.fields_completed.length, 20);
  assert.equal(row.properties.fields_completed[0], 'field_0');
  assert.equal(row.properties.fields_completed[19], 'field_19');
  assert.equal(row.properties.fields_completed.includes('field_24'), false);
  assert.doesNotMatch(JSON.stringify(row.properties), /drop-me|message_body|password/i);
});

test('public analytics route preserves fields required by admin insights', async () => {
  const db = makeDb();
  const app = buildApp(db);
  const response = await request(app, {
    events: [
      {
        event_name: 'cta_clicked',
        path: '/alphascreen',
        properties: {
          cta_label: 'Request a Demo',
          placement: 'hero',
          cta_target: '/contact',
        },
      },
      {
        event_name: 'lead_draft_saved',
        path: '/alphascreen',
        properties: {
          form_id: 'demo-form',
          form_type: 'demo',
          status: 'partial',
          fields_completed: ['email', 'phone'],
        },
      },
    ],
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, 2);
  const [ctaRow, formRow] = db.inserts[0].rows;
  assert.deepEqual(ctaRow.properties, {
    cta_label: 'Request a Demo',
    cta_target: '/contact',
    placement: 'hero',
  });
  assert.deepEqual(formRow.properties, {
    form_id: 'demo-form',
    form_type: 'demo',
    status: 'partial',
    fields_completed: ['email', 'phone'],
  });
});
