'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createAdminInterviewReliabilityRouter } = require('../src/routes/admin/interviewReliability');

const INTERVIEW_ID = 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function withServer({ isGlobalAdmin, service }, run) {
  const app = express();
  app.use((req, _res, next) => {
    req.isGlobalAdmin = isGlobalAdmin;
    req.request_id = 'bounded-request-id';
    next();
  });
  app.use('/admin/interview-reliability', createAdminInterviewReliabilityRouter({ service }));
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

test('Super Admin list and detail access succeed with no-store responses', async () => {
  const calls = [];
  const service = {
    async list(query) {
      calls.push(['list', query]);
      return { summary: { total_interviews: 0 }, items: [] };
    },
    async detail(id, query) {
      calls.push(['detail', id, query]);
      return { identity: { candidate: 'Synthetic Candidate' }, timeline: [] };
    },
  };
  await withServer({ isGlobalAdmin: true, service }, async (base) => {
    const list = await fetch(`${base}/admin/interview-reliability?page=1`);
    assert.equal(list.status, 200);
    assert.match(list.headers.get('cache-control') || '', /no-store/);
    assert.deepEqual(await list.json(), { summary: { total_interviews: 0 }, items: [] });

    const detail = await fetch(`${base}/admin/interview-reliability/${INTERVIEW_ID}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).identity.candidate, 'Synthetic Candidate');
  });
  assert.equal(calls.length, 2);
});

test('non-Super Admin access is rejected before the read service', async () => {
  let called = false;
  const service = {
    async list() {
      called = true;
      return {};
    },
    async detail() {
      called = true;
      return {};
    },
  };
  await withServer({ isGlobalAdmin: false, service }, async (base) => {
    const response = await fetch(`${base}/admin/interview-reliability`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'super_admin_required');
  });
  assert.equal(called, false);
});

test('route maps service failures to bounded responses without raw diagnostics', async () => {
  const raw = 'SECRET_DATABASE_URL_AND_PROVIDER_IDENTIFIER';
  const service = {
    async list() {
      const error = new Error(raw);
      error.code = 'interviews_read_failed';
      error.status = 503;
      throw error;
    },
    async detail() {
      throw new Error(raw);
    },
  };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await withServer({ isGlobalAdmin: true, service }, async (base) => {
      const response = await fetch(`${base}/admin/interview-reliability`);
      const body = await response.text();
      assert.equal(response.status, 503);
      assert.equal(body.includes(raw), false);
      assert.equal(body.includes('interviews_read_failed'), true);
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(JSON.stringify(logged).includes(raw), false);
});

test('app mounts the diagnostics router behind existing auth and admin authorization', () => {
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin', 'index.js'), 'utf8');
  assert.match(
    adminSource,
    /router\.use\('\/interview-reliability', requireAuth, requireAdmin, createAdminInterviewReliabilityRouter\(\)\)/,
  );
});
