const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const WebSocket = require('ws');
const { createSupportVoiceGateway } = require('../src/services/supportVoiceGateway');
const { createBacking, createMemorySupportVoiceStore } = require('./helpers/supportVoiceTestStore');

const ORIGIN = 'https://alphasourceai-com.onrender.com';

class OpeningUpstream extends EventEmitter {
  static instances = [];
  constructor() {
    super();
    this.readyState = WebSocket.CONNECTING;
    this.bufferedAmount = 0;
    OpeningUpstream.instances.push(this);
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }
  send(_payload, callback) { callback?.(); }
  close() {
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close', 1000, Buffer.alloc(0)));
  }
}

function membershipDb() {
  return {
    from() {
      return {
        select() {
          return { eq() { return { is() { return Promise.resolve({ data: null, count: 1, error: null }); } }; } };
        },
      };
    },
  };
}

async function makeInstance(backing, options = {}) {
  const sessionStore = createMemorySupportVoiceStore({ backing, consumeDelayMs: options.consumeDelayMs });
  const gateway = createSupportVoiceGateway({
    env: {
      NODE_ENV: 'test', SUPPORT_VOICE_ENABLED: 'true', SUPPORT_VOICE_ALLOWED_ORIGIN: ORIGIN,
      SUPPORT_VOICE_XFF_MODE: 'best_effort', XAI_API_KEY: 'xai-test-key-not-a-real-secret',
    },
    serviceDb: membershipDb(),
    sessionStore,
    WebSocketClient: OpeningUpstream,
    requireAuth(req, res, next) {
      if (!req.headers.authorization) return res.status(401).end();
      req.user = { id: 'shared-user', email: null };
      next();
    },
    rateLimit: async () => ({ allowed: true }),
  });
  const app = express();
  app.use('/api/support/voice', gateway.router);
  const server = http.createServer(app);
  gateway.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const httpOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    gateway, server, sessionStore, httpOrigin,
    async close() {
      gateway.finalizeAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('wait_timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('credential reserved on instance A is atomically consumed on instance B', async () => {
  OpeningUpstream.instances = [];
  const backing = createBacking();
  const a = await makeInstance(backing);
  const b = await makeInstance(backing);
  let socket;
  try {
    const response = await fetch(`${a.httpOrigin}/api/support/voice/sessions`, {
      method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer token' },
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    socket = new WebSocket(`${b.httpOrigin.replace(/^http:/, 'ws:')}/api/support/voice`, 'alphascreen-support-v1', {
      headers: { Origin: ORIGIN }, perMessageDeflate: false,
    });
    await new Promise((resolve, reject) => {
      socket.once('open', () => { socket.send(JSON.stringify({ type: 'authenticate', credential: created.credential })); resolve(); });
      socket.once('error', reject);
    });
    await waitFor(() => OpeningUpstream.instances.length === 1);
    assert.equal(backing.sessions.get(created.session_id).phase, 'active');
    assert.equal(a.gateway._state.sessions.size, 0);
    assert.equal(b.gateway._state.sessions.size, 1);
  } finally {
    try { socket?.close(); } catch {}
    await a.close();
    await b.close();
  }
});

test('same-user conflict is global across gateway instances', async () => {
  const backing = createBacking();
  const a = await makeInstance(backing);
  const b = await makeInstance(backing);
  try {
    const request = (instance) => fetch(`${instance.httpOrigin}/api/support/voice/sessions`, {
      method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer token' },
    });
    const responses = await Promise.all([request(a), request(b)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    assert.equal([...backing.sessions.values()].filter((row) => ['pending', 'active'].includes(row.phase)).length, 1);
  } finally {
    await a.close();
    await b.close();
  }
});

test('a second browser frame while durable consume is in flight closes before xAI connection', async () => {
  OpeningUpstream.instances = [];
  const backing = createBacking();
  const a = await makeInstance(backing);
  const b = await makeInstance(backing, { consumeDelayMs: 40 });
  let socket;
  try {
    const response = await fetch(`${a.httpOrigin}/api/support/voice/sessions`, {
      method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer token' },
    });
    const created = await response.json();
    socket = new WebSocket(`${b.httpOrigin.replace(/^http:/, 'ws:')}/api/support/voice`, 'alphascreen-support-v1', {
      headers: { Origin: ORIGIN }, perMessageDeflate: false,
    });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await new Promise((resolve, reject) => {
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'authenticate', credential: created.credential }));
        socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
        resolve();
      });
      socket.once('error', reject);
    });
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(OpeningUpstream.instances.length, 0);
  } finally {
    try { socket?.close(); } catch {}
    await a.close();
    await b.close();
  }
});
