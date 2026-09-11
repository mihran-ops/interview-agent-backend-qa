const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BROWSER_MAX_PAYLOAD,
  UPSTREAM_MAX_PAYLOAD,
  attestSessionUpdated,
  buildAuthoritativeSessionUpdate,
  classifyProviderEvent,
  decodeCanonicalAudio,
  validateBrowserEvent,
  validatePreAttestationProviderEvent,
  validateSessionUpdated,
} = require('../src/services/supportVoiceProtocol');

const prompt = 'static support prompt';

function acceptedSession() {
  return {
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
  };
}

test('authoritative update pins audio-only, transcription off, no tools, and resumption off', () => {
  const update = buildAuthoritativeSessionUpdate({ prompt, voice: 'carina' });
  assert.deepEqual(update.session.modalities, ['audio']);
  assert.equal(update.session.input_audio_transcription, null);
  assert.equal(update.session.resumption.enabled, false);
  assert.equal(Object.hasOwn(update.session, 'tools'), false);
  assert.equal(update.session.instructions, prompt);
  assert.equal(update.session.voice, 'carina');
});

test('closed session.updated attestation accepts the sanitized live provider shape', () => {
  assert.equal(validateSessionUpdated(acceptedSession(), { prompt, voice: 'carina' }), true);
});

test('provider-managed noise suppression echo accepts either bounded boolean and nothing else', () => {
  const providerNormalized = acceptedSession();
  providerNormalized.session.enable_noise_suppression = false;
  assert.equal(validateSessionUpdated(providerNormalized, { prompt, voice: 'carina' }), true);
  providerNormalized.session.enable_noise_suppression = 'false';
  assert.equal(validateSessionUpdated(providerNormalized, { prompt, voice: 'carina' }), false);
});

test('missing required provider fields retain a bounded field-specific diagnostic', () => {
  const event = acceptedSession();
  delete event.session.input_audio_transcription;
  assert.deepEqual(attestSessionUpdated(event, { prompt, voice: 'carina' }), {
    ok: false,
    failure_category: 'missing_field',
    field: 'input_audio_transcription',
  });
});

test('closed session.updated attestation accepts current bounded provider envelope metadata', () => {
  const event = acceptedSession();
  event.event_id = '00000000-0000-4000-8000-000000000000';
  event.previous_item_id = null;
  assert.equal(validateSessionUpdated(event, { prompt, voice: 'carina' }), true);
});

test('only the exact current bounded pre-attestation provider controls are accepted', () => {
  const controls = [
    {
      type: 'session.created',
      event_id: '00000000-0000-4000-8000-000000000001',
      session: { id: 'session-1', instructions: '', modalities: ['audio'], model: 'grok-voice-think-fast-2.0', object: 'realtime.session', tools: [], turn_detection: { type: 'server_vad' }, voice: 'xai_ara' },
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
  ];
  for (const event of controls) assert.equal(validatePreAttestationProviderEvent(event), true);
  for (const event of [
    { ...controls[0], event_id: '' },
    { ...controls[0], session: { ...controls[0].session, tools: [{}] } },
    { ...controls[0], session: { ...controls[0].session, instructions: 'provider default instruction' } },
    { ...controls[0], session: { ...controls[0].session, turn_detection: { type: 'server_vad', threshold: 0.5 } } },
    { ...controls[1], previous_item_id: {} },
    { ...controls[1], conversation: { ...controls[1].conversation, metadata: {} } },
    { ...controls[2], timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { ...controls[2], provider_metadata: true },
    { type: 'rate_limits.updated', event_id: controls[0].event_id },
  ]) assert.equal(validatePreAttestationProviderEvent(event), false);
  assert.equal(validatePreAttestationProviderEvent({ ...controls[2], previous_item_id: 'item-1' }), true);
});

test('pre-attestation session.created accepts the current content-free null turn detection default', () => {
  const event = {
    type: 'session.created',
    event_id: '00000000-0000-4000-8000-000000000004',
    session: {
      id: 'session-1',
      instructions: '',
      modalities: ['audio'],
      model: 'grok-voice-think-fast-2.0',
      object: 'realtime.session',
      tools: [],
      turn_detection: null,
      voice: 'xai_ara',
    },
  };
  assert.equal(validatePreAttestationProviderEvent(event), true);
});

test('pre-attestation session.created accepts the current exact one-key null turn detection default', () => {
  const event = {
    type: 'session.created',
    event_id: '00000000-0000-4000-8000-000000000005',
    session: {
      id: 'session-1',
      instructions: '',
      modalities: ['audio'],
      model: 'grok-voice-think-fast-2.0',
      object: 'realtime.session',
      tools: [],
      turn_detection: { type: null },
      voice: 'xai_ara',
    },
  };
  assert.equal(validatePreAttestationProviderEvent(event), true);
});

for (const mutation of [
  (event) => { event.event_id = ''; },
  (event) => { event.event_id = `event-${'x'.repeat(195)}`; },
  (event) => { event.event_id = 'event\ncontrol'; },
  (event) => { event.previous_item_id = {}; },
  (event) => { event.previous_item_id = 'item\u0000control'; },
  (event) => { event.provider_metadata = true; },
]) {
  test('closed session.updated attestation rejects unsafe provider envelope metadata', () => {
    const event = acceptedSession();
    event.event_id = '00000000-0000-4000-8000-000000000000';
    event.previous_item_id = null;
    mutation(event);
    assert.equal(validateSessionUpdated(event, { prompt, voice: 'carina' }), false);
  });
}

for (const mutation of [
  (event) => { event.session.tools = []; },
  (event) => { event.session.modalities = ['audio', 'text']; },
  (event) => { event.session.instructions = 'changed'; },
  (event) => { event.session.input_audio_transcription = { model: 'unexpected' }; },
  (event) => { event.session.audio.input.transcription = null; },
  (event) => { event.session.resumption = { enabled: true }; },
  (event) => { event.session.unknown = true; },
  (event) => { event.session.tool_choice = 'required'; },
]) {
  test('closed session.updated attestation rejects capability or metadata drift', () => {
    const event = acceptedSession();
    mutation(event);
    assert.equal(validateSessionUpdated(event, { prompt, voice: 'carina' }), false);
  });
}

test('canonical PCM base64 accepts standard padding and rejects alternate encodings', () => {
  const encoded = Buffer.from([0, 0, 1, 0]).toString('base64');
  assert.equal(decodeCanonicalAudio(encoded)?.length, 4);
  assert.equal(decodeCanonicalAudio(encoded.replace(/=/g, '')), null);
  assert.equal(decodeCanonicalAudio('AA-_'), null);
  assert.equal(validateBrowserEvent({ type: 'input_audio_buffer.append', audio: encoded })?.type, 'input_audio_buffer.append');
  assert.equal(validateBrowserEvent({ type: 'input_audio_buffer.append', audio: encoded, instructions: 'inject' }), null);
});

test('browser protocol permits only append and clear schemas', () => {
  assert.deepEqual(validateBrowserEvent({ type: 'input_audio_buffer.clear' }), { type: 'input_audio_buffer.clear' });
  assert.equal(validateBrowserEvent({ type: 'response.create' }), null);
  assert.equal(validateBrowserEvent({ type: 'session.update', session: {} }), null);
});

test('provider protocol forwards selected audio/status fields and drops transcript text', () => {
  const encoded = Buffer.from([0, 0]).toString('base64');
  assert.deepEqual(classifyProviderEvent({ type: 'response.output_audio.delta', delta: encoded, response_id: 'ignored', transcript: 'also ignored' }), { action: 'forward', message: { type: 'audio_delta', audio: encoded }, audioBytes: 2 });
  assert.equal(classifyProviderEvent({ type: 'response.output_audio_transcript.delta', delta: 'secret' }).action, 'drop');
  assert.equal(classifyProviderEvent({ type: 'response.function_call_arguments.done' }).action, 'finalize');
  assert.equal(classifyProviderEvent({ type: 'mcp.tool_call' }).action, 'finalize');
});

test('transport payload ceilings match the reviewed contract', () => {
  assert.equal(BROWSER_MAX_PAYLOAD, 48 * 1024);
  assert.equal(UPSTREAM_MAX_PAYLOAD, 512 * 1024);
});
