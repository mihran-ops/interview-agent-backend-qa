'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createAdminSmsMonitoringRouter } = require('../routes/adminSmsMonitoring');

async function withServer({ isGlobalAdmin, service }, run) {
  const app = express();
  app.use((req, _res, next) => {
    req.isGlobalAdmin = isGlobalAdmin;
    req.request_id = 'bounded-request-id';
    next();
  });
  app.use('/admin/sms-monitoring', createAdminSmsMonitoringRouter({ service }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Super Admin can read the no-store monitoring snapshot', async () => {
  const calls = [];
  const service = {
    async snapshot(query) {
      calls.push(query);
      return { delivery: { requested: 3 }, incidents: [] };
    },
  };
  await withServer({ isGlobalAdmin: true, service }, async (base) => {
    const response = await fetch(`${base}/admin/sms-monitoring?range=24h`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.deepEqual(await response.json(), { delivery: { requested: 3 }, incidents: [] });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].range, '24h');
});

test('non-Super Admin access is rejected before the read service', async () => {
  let called = false;
  const service = { async snapshot() { called = true; return {}; } };
  await withServer({ isGlobalAdmin: false, service }, async (base) => {
    const response = await fetch(`${base}/admin/sms-monitoring`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'super_admin_required');
  });
  assert.equal(called, false);
});

test('route failures are bounded and do not expose raw diagnostics', async () => {
  const raw = 'SECRET_DATABASE_URL_AND_PROVIDER_IDENTIFIER';
  const service = {
    async snapshot() {
      const error = new Error(raw);
      error.code = 'sms_monitoring_unavailable';
      error.status = 503;
      throw error;
    },
  };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await withServer({ isGlobalAdmin: true, service }, async (base) => {
      const response = await fetch(`${base}/admin/sms-monitoring`);
      const body = await response.text();
      assert.equal(response.status, 503);
      assert.equal(body.includes(raw), false);
      assert.equal(body.includes('sms_monitoring_unavailable'), true);
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(JSON.stringify(logged).includes(raw), false);
});

test('app mounts the monitoring router behind existing auth and admin authorization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin', 'index.js'), 'utf8');
  assert.match(
    source,
    /router\.use\('\/sms-monitoring', requireAuth, requireAdmin, createAdminSmsMonitoringRouter\(\)\)/,
  );
});
