const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSupportVoiceProviderCanary } = require('../src/services/supportVoiceProviderCanary');

function providerSession(prompt, overrides = {}) {
  return {
    type: 'session.updated',
    session: {
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 }, transport: 'json' },
        output: { format: { type: 'audio/pcm', rate: 24000 }, transport: 'json' },
      },
      enable_noise_suppression: false,
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
      ...overrides,
    },
  };
}

function socketClass(transform = (event) => event) {
  return class FakeProviderSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      assert.match(options.headers.Authorization, /^Bearer /);
      queueMicrotask(() => this.emit('open'));
    }

    send(encoded, callback) {
      const update = JSON.parse(encoded);
      callback?.();
      const event = transform(providerSession(update.session.instructions));
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(event)), false));
    }

    close() {}
  };
}

test('no-audio provider canary accepts the current normalized contract and publishes bounded readiness', async () => {
  const logs = [];
  const canary = createSupportVoiceProviderCanary({
    env: { SUPPORT_VOICE_ENABLED: 'true', XAI_API_KEY: 'xai-test-key-not-a-real-secret' },
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    WebSocketClient: socketClass(),
    timeoutMs: 100,
  });
  assert.equal(await canary.probe(), true);
  const health = canary.snapshot();
  assert.equal(health.provider_contract_ok, true);
  assert.equal(health.provider_last_failure_category, null);
  assert.equal(health.provider_consecutive_failures, 0);
  assert.match(health.provider_last_success_at, /^\d{4}-/);
  assert.deepEqual(logs[0], ['[support-voice] provider_contract_probe_ok']);
});

test('provider canary fails closed with field-only diagnostics after critical drift', async () => {
  const warnings = [];
  const alerts = [];
  const canary = createSupportVoiceProviderCanary({
    env: { SUPPORT_VOICE_ENABLED: 'true', XAI_API_KEY: 'xai-test-key-not-a-real-secret' },
    logger: { info() {}, warn: (...args) => warnings.push(args) },
    WebSocketClient: socketClass((event) => ({ ...event, session: { ...event.session, modalities: ['audio', 'text'] } })),
    alert: (metadata) => alerts.push(metadata),
    timeoutMs: 100,
  });
  assert.equal(await canary.probe(), false);
  assert.equal(canary.snapshot().provider_contract_ok, false);
  assert.equal(canary.snapshot().provider_last_failure_category, 'provider_attestation');
  assert.equal(warnings[0][1].field, 'modalities');
  assert.equal(JSON.stringify(warnings).includes('instructions'), false);
  assert.equal(await canary.probe(), false);
  assert.deepEqual(alerts, [{ failure_category: 'provider_attestation', field: 'modalities', consecutive_failures: 2 }]);
  assert.equal(await canary.probe(), false);
  assert.equal(alerts.length, 1);
});

test('throwing diagnostic and alert sinks cannot stall or disable later probes', async () => {
  let alertCalls = 0;
  const canary = createSupportVoiceProviderCanary({
    env: { SUPPORT_VOICE_ENABLED: 'true', XAI_API_KEY: 'xai-test-key-not-a-real-secret' },
    logger: {
      info() { throw new Error('diagnostic_sink_failed'); },
      warn() { throw new Error('diagnostic_sink_failed'); },
    },
    WebSocketClient: socketClass((event) => ({ ...event, session: { ...event.session, modalities: ['audio', 'text'] } })),
    alert: () => {
      alertCalls += 1;
      throw new Error('alert_sink_failed');
    },
    timeoutMs: 100,
  });
  assert.equal(await canary.probe(), false);
  assert.equal(await canary.probe(), false);
  assert.equal(canary._state.running, false);
  assert.equal(canary.snapshot().provider_consecutive_failures, 2);
  assert.equal(alertCalls, 1);
  assert.equal(await canary.probe(), false);
  assert.equal(canary._state.running, false);
  assert.equal(canary.snapshot().provider_consecutive_failures, 3);
  assert.equal(alertCalls, 1);
});

test('provider readiness becomes stale without creating a false success', async () => {
  let clock = Date.parse('2026-08-27T12:00:00.000Z');
  const canary = createSupportVoiceProviderCanary({
    env: { SUPPORT_VOICE_ENABLED: 'true', XAI_API_KEY: 'xai-test-key-not-a-real-secret' },
    logger: { info() {}, warn() {} },
    WebSocketClient: socketClass(),
    now: () => clock,
    intervalMs: 100,
    staleMs: 250,
    timeoutMs: 100,
  });
  assert.equal(await canary.probe(), true);
  assert.equal(canary.ready(), true);
  clock += 251;
  assert.equal(canary.ready(), false);
  assert.equal(canary.snapshot().provider_contract_ok, false);
});

test('disabled or unconfigured voice never probes, fails, logs, or alerts', async () => {
  for (const env of [
    { SUPPORT_VOICE_ENABLED: 'false', XAI_API_KEY: 'xai-test-key-not-a-real-secret' },
    { SUPPORT_VOICE_ENABLED: 'true', XAI_API_KEY: '' },
  ]) {
    const warnings = [];
    const alerts = [];
    const canary = createSupportVoiceProviderCanary({
      env,
      logger: { info() {}, warn: (...args) => warnings.push(args) },
      WebSocketClient: class UnexpectedSocket { constructor() { throw new Error('must_not_connect'); } },
      alert: (metadata) => alerts.push(metadata),
      timeoutMs: 100,
    });
    canary.start();
    assert.equal(canary._state.started, false);
    assert.equal(await canary.probe(), false);
    assert.equal(canary.snapshot().provider_consecutive_failures, 0);
    assert.equal(canary.snapshot().provider_last_failure_category, null);
    assert.deepEqual(warnings, []);
    assert.deepEqual(alerts, []);
  }
});

test('shutdown aborts an in-flight authenticated probe without recording a late result', async () => {
  let socketClosed = false;
  class HangingSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    send(_encoded, callback) { callback?.(); }
    close() { socketClosed = true; }
    terminate() { socketClosed = true; }
  }
  const warnings = [];
  const canary = createSupportVoiceProviderCanary({
    env: { SUPPORT_VOICE_ENABLED: 'true', XAI_API_KEY: 'xai-test-key-not-a-real-secret' },
    logger: { info() {}, warn: (...args) => warnings.push(args) },
    WebSocketClient: HangingSocket,
    timeoutMs: 1_000,
  });
  const probe = canary.probe();
  await new Promise((resolve) => setImmediate(resolve));
  canary.stop();
  assert.equal(await probe, false);
  assert.equal(socketClosed, true);
  assert.equal(canary._state.running, false);
  assert.equal(canary.snapshot().provider_consecutive_failures, 0);
  assert.equal(canary.snapshot().provider_last_failure_category, null);
  assert.deepEqual(warnings, []);
});
