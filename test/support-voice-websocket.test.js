const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const WebSocket = require('ws');
const { createSupportVoiceGateway } = require('../src/services/supportVoiceGateway');
const { createBacking, createMemorySupportVoiceStore } = require('./helpers/supportVoiceTestStore');

const ORIGIN = 'https://alphasourceai-com.onrender.com';

class FakeUpstream extends EventEmitter {
  static instances = [];
  static greetingResponseBeforeCallback = false;
  static preAttestationEvents = [];
  static sessionUpdatedDelayMs = 0;
  static stallAudioCallbacks = false;
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = WebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeUpstream.instances.push(this);
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }
  send(payload, callback) {
    const event = JSON.parse(payload);
    this.sent.push(event);
    if (event.type === 'session.update') {
      const prompt = event.session.instructions;
      const acknowledge = () => {
        for (const providerEvent of FakeUpstream.preAttestationEvents) this.emitProvider(providerEvent);
        this.emitProvider({
          type: 'session.updated',
          event_id: '00000000-0000-4000-8000-000000000000',
          previous_item_id: null,
          session: {
            audio: {
              input: { format: { type: 'audio/pcm', rate: 24000 }, transport: 'json' },
              output: { format: { type: 'audio/pcm', rate: 24000 }, transport: 'json' },
            },
            enable_noise_suppression: true,
            enable_phonetic_spelling: false,
            input_audio_format: 'not specified',
            input_audio_transcription: null,
            instructions: prompt,
            keep_context: false,
            max_response_output_tokens: 'inf',
            modalities: ['audio'],
            model: 'grok-voice-think-fast-2.0',
            output_audio_format: 'not specified',
            temperature: -1,
            tool_choice: 'auto',
            turn_detection: { prefix_padding_ms: 300, silence_duration_ms: 800, threshold: 0.85, type: 'server_vad' },
          },
        });
      };
      if (FakeUpstream.sessionUpdatedDelayMs > 0) setTimeout(acknowledge, FakeUpstream.sessionUpdatedDelayMs);
      else queueMicrotask(acknowledge);
    }
    if (event.type === 'conversation.item.create' && FakeUpstream.greetingResponseBeforeCallback) {
      queueMicrotask(() => this.emitProvider({ type: 'response.created' }));
    }
    if (callback && !(FakeUpstream.stallAudioCallbacks && event.type === 'input_audio_buffer.append')) queueMicrotask(() => callback(null));
  }
  emitProvider(event) {
    this.emit('message', Buffer.from(JSON.stringify(event)), false);
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close'));
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

async function setup(options = {}) {
  FakeUpstream.instances = [];
  FakeUpstream.greetingResponseBeforeCallback = options.greetingResponseBeforeCallback === true;
  FakeUpstream.preAttestationEvents = options.preAttestationEvents || [];
  FakeUpstream.sessionUpdatedDelayMs = options.sessionUpdatedDelayMs || 0;
  FakeUpstream.stallAudioCallbacks = options.stallAudioCallbacks === true;
  const env = {
    NODE_ENV: 'test',
    SUPPORT_VOICE_ENABLED: 'true',
    SUPPORT_VOICE_ALLOWED_ORIGIN: ORIGIN,
    SUPPORT_VOICE_XFF_MODE: 'best_effort',
    XAI_API_KEY: 'xai-test-key-not-a-real-secret',
  };
  const logs = [];
  const backing = options.backing || createBacking();
  const sessionStore = options.sessionStore || createMemorySupportVoiceStore({
    backing,
    consumeDelayMs: options.consumeDelayMs,
    consumeFailureAfterCommit: options.consumeFailureAfterCommit,
    closeFailures: options.closeFailures,
  });
  const gateway = createSupportVoiceGateway({
    env,
    logger: { warn(event, metadata) { logs.push({ event, metadata }); } },
    serviceDb: membershipDb(),
    sessionStore,
    WebSocketClient: FakeUpstream,
    requireAuth(req, res, next) {
      if (!req.headers.authorization) return res.status(401).end();
      req.user = { id: 'voice-user', email: null };
      req.isGlobalAdmin = false;
      next();
    },
    rateLimit: async () => ({ allowed: true, count: 1, remaining: 1, retryAfterSeconds: 0 }),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatGraceMs: options.heartbeatGraceMs,
    idleMs: options.idleMs,
    maxSessionMs: options.maxSessionMs,
    closeRetryBaseMs: options.closeRetryBaseMs,
  });
  const app = express();
  app.use('/api/support/voice', gateway.router);
  const server = http.createServer(app);
  gateway.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/support/voice/sessions`, { method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer token' } });
  assert.equal(response.status, 201);
  const created = await response.json();
  const socket = new WebSocket(`${origin.replace(/^http:/, 'ws:')}/api/support/voice`, 'alphascreen-support-v1', {
    headers: { Origin: ORIGIN },
    perMessageDeflate: false,
    autoPong: options.autoPong !== false,
  });
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString('utf8'))));
  await new Promise((resolve, reject) => {
    socket.once('open', () => { socket.send(JSON.stringify({ type: 'authenticate', credential: created.credential })); resolve(); });
    socket.once('error', reject);
  });
  return {
    gateway,
    backing,
    logs,
    messages,
    socket,
    server,
    sessionStore,
    close: async () => {
      try { socket.close(); } catch {}
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

test('authenticated browser WS receives ready only after exact provider attestation and greeting send', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    assert.equal(FakeUpstream.instances.length, 1);
    const upstream = FakeUpstream.instances[0];
    assert.equal(upstream.url, 'wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0');
    assert.equal(upstream.options.maxPayload, 512 * 1024);
    assert.equal(upstream.options.perMessageDeflate, false);
    assert.match(upstream.options.headers.Authorization, /^Bearer /);
    assert.equal(upstream.sent[0].type, 'session.update');
    assert.deepEqual(upstream.sent[0].session.modalities, ['audio']);
    assert.equal(upstream.sent[0].session.input_audio_transcription, null);
    assert.equal(Object.hasOwn(upstream.sent[0].session, 'tools'), false);
    assert.equal(upstream.sent[1].item.type, 'force_message');
  } finally {
    await h.close();
  }
});

test('ambiguous consume failure closes the durable row before any xAI connection', async () => {
  const h = await setup({ consumeFailureAfterCommit: true });
  try {
    await waitFor(() => [...h.backing.sessions.values()].some((row) => row.phase === 'closed'));
    assert.equal(FakeUpstream.instances.length, 0);
    assert.equal([...h.backing.sessions.values()][0].reason, 'response_failed');
  } finally {
    await h.close();
  }
});

test('client error close telemetry accepts only a bounded content-free reason', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    h.socket.close(4000, 'client_media_error');
    await waitFor(() => h.logs.some((entry) => entry.event === '[support-voice] client_session_closed'));
    assert.deepEqual(h.logs.find((entry) => entry.event === '[support-voice] client_session_closed'), {
      event: '[support-voice] client_session_closed',
      metadata: { reason: 'client_media_error' },
    });
    assert.equal(JSON.stringify(h.logs).includes('audio_delta'), false);
  } finally {
    await h.close();
  }
});

test('unrecognized client close text is discarded instead of logged', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    h.socket.close(4000, 'untrusted-close-text');
    await waitFor(() => h.socket.readyState === WebSocket.CLOSED);
    assert.equal(h.logs.some((entry) => entry.event === '[support-voice] client_session_closed'), false);
    assert.equal(JSON.stringify(h.logs).includes('untrusted-close-text'), false);
  } finally {
    await h.close();
  }
});

test('provider close telemetry is bounded and never logs the provider reason body', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    const upstream = FakeUpstream.instances[0];
    upstream.emitProvider({ type: 'response.created' });
    await waitFor(() => h.messages.some((message) => message.type === 'speaking' && message.active === true));
    upstream.emit('close', 1006, Buffer.from('untrusted-provider-reason'));
    await waitFor(() => h.logs.some((entry) => entry.event === '[support-voice] provider_session_closed'));
    assert.deepEqual(h.logs.find((entry) => entry.event === '[support-voice] provider_session_closed'), {
      event: '[support-voice] provider_session_closed',
      metadata: {
        close_code: 1006,
        reason_present: true,
        phase: 'ready',
        during_response: true,
        last_provider_event: 'response.created',
      },
    });
    assert.equal(JSON.stringify(h.logs).includes('untrusted-provider-reason'), false);
  } finally {
    await h.close();
  }
});

test('current bounded xAI control prelude is ignored until exact session attestation succeeds', async () => {
  const h = await setup({
    preAttestationEvents: [
      {
        type: 'session.created',
        event_id: '00000000-0000-4000-8000-000000000001',
        session: { id: 'session-1', instructions: '', modalities: ['audio'], model: 'grok-voice-think-fast-2.0', object: 'realtime.session', tools: [], turn_detection: { type: null }, voice: 'xai_ara' },
      },
      {
        type: 'conversation.created',
        event_id: '00000000-0000-4000-8000-000000000002',
        previous_item_id: null,
        conversation: { id: 'conversation-1', object: 'realtime.conversation' },
      },
      {
        type: 'ping',
        event_id: '00000000-0000-4000-8000-000000000003',
        previous_item_id: null,
        timestamp: 1_786_466_400,
      },
    ],
  });
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    assert.equal(h.messages.some((message) => message.type === 'error'), false);
    assert.equal(FakeUpstream.instances[0].sent.filter((event) => event.type === 'conversation.item.create').length, 1);
  } finally {
    await h.close();
  }
});

test('provider may begin greeting response before the send callback without closing the session', async () => {
  const h = await setup({ greetingResponseBeforeCallback: true });
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    await waitFor(() => h.messages.some((message) => message.type === 'speaking' && message.active === true));
    assert.equal(h.messages.some((message) => message.type === 'error'), false);
    assert.equal(FakeUpstream.instances[0].sent.filter((event) => event.type === 'conversation.item.create').length, 1);
  } finally {
    await h.close();
  }
});

test('unknown or malformed pre-attestation provider control fails closed before greeting', async () => {
  const h = await setup({
    preAttestationEvents: [{
      type: 'ping',
      event_id: '00000000-0000-4000-8000-000000000003',
      previous_item_id: null,
      timestamp: 1_786_466_400,
      provider_metadata: true,
    }],
  });
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'error'));
    assert.equal(h.messages.some((message) => message.type === 'ready'), false);
    assert.equal(FakeUpstream.instances[0].sent.some((event) => event.type === 'conversation.item.create'), false);
    assert.deepEqual(h.logs.at(-1), {
      event: '[support-voice] session_finalized',
      metadata: { reason: 'support_voice_unavailable', phase: 'session_update_sent', last_provider_event: 'ping' },
    });
    assert.equal(JSON.stringify(h.logs).includes('provider_metadata'), false);
  } finally {
    await h.close();
  }
});

test('bounded provider ping remains content-free and non-terminal after attestation', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    const before = h.messages.length;
    FakeUpstream.instances[0].emitProvider({
      type: 'ping',
      event_id: '00000000-0000-4000-8000-000000000004',
      previous_item_id: 'item-1',
      timestamp: 1_786_466_401,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(h.messages.length, before);
    assert.equal(h.socket.readyState, WebSocket.OPEN);
  } finally {
    await h.close();
  }
});

test('late session-created control terminates instead of resetting an attested session', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    FakeUpstream.instances[0].emitProvider({
      type: 'session.created',
      event_id: '00000000-0000-4000-8000-000000000005',
      session: { id: 'session-2', instructions: '', modalities: ['audio'], model: 'grok-voice-think-fast-2.0', object: 'realtime.session', tools: [], turn_detection: { type: 'server_vad' }, voice: 'xai_ara' },
    });
    await waitFor(() => h.messages.some((message) => message.type === 'error'));
    assert.equal(FakeUpstream.instances[0].sent.filter((event) => event.type === 'conversation.item.create').length, 1);
  } finally {
    await h.close();
  }
});

test('browser audio is schema-validated, transcript is dropped, and capability events finalize', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    const upstream = FakeUpstream.instances[0];
    const audio = Buffer.from([0, 0]).toString('base64');
    h.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    await waitFor(() => upstream.sent.some((event) => event.type === 'input_audio_buffer.append'));
    upstream.emitProvider({ type: 'response.output_audio_transcript.delta', delta: 'not-forwarded' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(JSON.stringify(h.messages).includes('not-forwarded'), false);
    const upstreamEventsBeforeResponse = upstream.sent.length;
    upstream.emitProvider({ type: 'response.created' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(upstream.sent.length, upstreamEventsBeforeResponse);
    assert.equal(upstream.sent.some((event) => event.type === 'input_audio_buffer.clear'), false);
    upstream.emitProvider({ type: 'response.output_audio.delta', delta: audio });
    upstream.emitProvider({ type: 'response.done' });
    await waitFor(() => h.messages.some((message) => message.type === 'audio_delta'));
    upstream.emitProvider({ type: 'response.function_call_arguments.done' });
    await waitFor(() => h.messages.some((message) => message.type === 'error'));
  } finally {
    await h.close();
  }
});

test('invalid post-auth browser event finalizes without forwarding upstream', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    const upstream = FakeUpstream.instances[0];
    const before = upstream.sent.length;
    h.socket.send(JSON.stringify({ type: 'response.create', instructions: 'override' }));
    await waitFor(() => h.messages.some((message) => message.type === 'error'));
    assert.equal(upstream.sent.length, before);
  } finally {
    await h.close();
  }
});

test('provider response epochs drop pre-response audio but incidental speech cannot truncate an active half-duplex answer', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    const upstream = FakeUpstream.instances[0];
    const audio = Buffer.from([0, 0]).toString('base64');
    upstream.emitProvider({ type: 'response.output_audio.delta', delta: audio });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.messages.filter((message) => message.type === 'audio_delta').length, 0);
    const upstreamEventsBeforeResponse = upstream.sent.length;
    upstream.emitProvider({ type: 'response.created' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(upstream.sent.length, upstreamEventsBeforeResponse);
    assert.equal(upstream.sent.some((event) => event.type === 'input_audio_buffer.clear'), false);
    const forwardedInputFrames = upstream.sent.filter((event) => event.type === 'input_audio_buffer.append').length;
    h.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(upstream.sent.filter((event) => event.type === 'input_audio_buffer.append').length, forwardedInputFrames);
    upstream.emitProvider({ type: 'response.output_audio.delta', delta: audio });
    await waitFor(() => h.messages.filter((message) => message.type === 'audio_delta').length === 1);
    upstream.emitProvider({ type: 'input_audio_buffer.speech_started' });
    upstream.emitProvider({ type: 'response.output_audio.delta', delta: audio });
    await waitFor(() => h.messages.filter((message) => message.type === 'audio_delta').length === 2);
    assert.equal(h.messages.some((message) => message.type === 'listening' && message.active === true), false);
    upstream.emitProvider({ type: 'input_audio_buffer.speech_stopped' });
    upstream.emitProvider({ type: 'response.done' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.messages.filter((message) => message.type === 'audio_delta').length, 2);
    upstream.emitProvider({ type: 'response.created' });
    upstream.emitProvider({ type: 'response.output_audio.delta', delta: audio });
    await waitFor(() => h.messages.filter((message) => message.type === 'audio_delta').length === 3);
  } finally {
    await h.close();
  }
});

test('a duplicate late session.updated is never ignored or applied twice', async () => {
  const h = await setup();
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    const upstream = FakeUpstream.instances[0];
    const update = upstream.sent.find((event) => event.type === 'session.update');
    upstream.emitProvider({
      type: 'session.updated',
      session: {
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 }, transport: 'json' },
          output: { format: { type: 'audio/pcm', rate: 24000 }, transport: 'json' },
        },
        enable_noise_suppression: true,
        enable_phonetic_spelling: false,
        input_audio_format: 'not specified',
        input_audio_transcription: null,
        instructions: update.session.instructions,
        keep_context: false,
        max_response_output_tokens: 'inf',
        modalities: ['audio'],
        model: 'grok-voice-think-fast-2.0',
        output_audio_format: 'not specified',
        temperature: -1,
        tool_choice: 'auto',
        turn_detection: { prefix_padding_ms: 300, silence_duration_ms: 800, threshold: 0.85, type: 'server_vad' },
      },
    });
    await waitFor(() => h.messages.some((message) => message.type === 'error'));
    assert.equal(upstream.sent.filter((event) => event.type === 'conversation.item.create').length, 1);
  } finally {
    await h.close();
  }
});

test('audio ingress burst and stalled bridge in-flight overflow both finalize safely', async () => {
  for (const options of [{}, { stallAudioCallbacks: true }]) {
    const h = await setup(options);
    try {
      await waitFor(() => h.messages.some((message) => message.type === 'ready'));
      const audio = Buffer.from([0, 0]).toString('base64');
      const count = options.stallAudioCallbacks ? 13 : 60;
      for (let index = 0; index < count; index += 1) {
        if (h.socket.readyState === WebSocket.OPEN) h.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
      }
      await waitFor(() => h.messages.some((message) => message.type === 'error'));
      assert.equal(h.gateway._state.sessions.size, 0);
    } finally {
      await h.close();
    }
  }
});

test('heartbeat keeps a responsive browser alive and closes a browser that does not pong', async () => {
  const responsive = await setup({ heartbeatIntervalMs: 20, heartbeatGraceMs: 20, idleMs: 500 });
  try {
    await waitFor(() => responsive.messages.some((message) => message.type === 'ready'));
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(responsive.messages.some((message) => message.type === 'error'), false);
    assert.equal(responsive.socket.readyState, WebSocket.OPEN);
  } finally {
    await responsive.close();
  }
  const unresponsive = await setup({ autoPong: false, heartbeatIntervalMs: 20, heartbeatGraceMs: 20, idleMs: 500 });
  try {
    await waitFor(() => unresponsive.messages.some((message) => message.type === 'ready'));
    await waitFor(() => unresponsive.messages.some((message) => message.type === 'error'), 300);
  } finally {
    await unresponsive.close();
  }
});

test('idle timeout ignores silent PCM and begins only after estimated audible answer playback', async () => {
  const silent = await setup({ idleMs: 35, heartbeatIntervalMs: 500, maxSessionMs: 500 });
  try {
    await waitFor(() => silent.messages.some((message) => message.type === 'ready'));
    const audio = Buffer.from([0, 0]).toString('base64');
    for (let index = 0; index < 3; index += 1) {
      silent.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await waitFor(() => silent.messages.some((message) => message.type === 'ended' && message.reason === 'idle_timeout'), 300);
  } finally {
    await silent.close();
  }
  const answering = await setup({ idleMs: 25, heartbeatIntervalMs: 500, maxSessionMs: 500 });
  try {
    await waitFor(() => answering.messages.some((message) => message.type === 'ready'));
    const upstream = FakeUpstream.instances[0];
    upstream.emitProvider({ type: 'response.created' });
    upstream.emitProvider({ type: 'response.output_audio.delta', delta: Buffer.alloc(4_800).toString('base64') });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(answering.messages.some((message) => message.type === 'ended'), false);
    upstream.emitProvider({ type: 'response.done' });
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(answering.messages.some((message) => message.type === 'ended'), false);
    await waitFor(() => answering.messages.some((message) => message.type === 'ended' && message.reason === 'idle_timeout'));
  } finally {
    await answering.close();
  }
});

test('any client frame after credential authentication but before provider ready is rejected without buffering', async () => {
  const h = await setup({ sessionUpdatedDelayMs: 80 });
  try {
    await waitFor(() => FakeUpstream.instances.length === 1);
    const upstream = FakeUpstream.instances[0];
    h.socket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
    await waitFor(() => h.messages.some((message) => message.type === 'error'));
    assert.equal(upstream.sent.some((event) => event.type === 'input_audio_buffer.clear'), false);
  } finally {
    await h.close();
  }
});

test('terminal cleanup retries the idempotent durable close until it succeeds', async () => {
  const h = await setup({ closeFailures: 2, closeRetryBaseMs: 5 });
  try {
    await waitFor(() => h.messages.some((message) => message.type === 'ready'));
    h.socket.close(1000, 'user_end');
    await waitFor(() => h.sessionStore.calls.filter((call) => call.operation === 'close').length >= 3);
    await waitFor(() => h.gateway._state.durableClosures.size === 0);
    const closeCalls = h.sessionStore.calls.filter((call) => call.operation === 'close');
    assert.equal(closeCalls.length, 3);
    assert.ok(closeCalls.every((call) => call.reason === 'ended'));
  } finally {
    await h.close();
  }
});
