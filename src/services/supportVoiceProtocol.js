const MODEL = 'grok-voice-think-fast-2.0';
const UPSTREAM_URL = `wss://api.x.ai/v1/realtime?model=${MODEL}`;
const DEFAULT_VOICE = 'carina';
const BROWSER_MAX_PAYLOAD = 48 * 1024;
const UPSTREAM_MAX_PAYLOAD = 512 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024;
const MAX_OUTBOUND_AUDIO_BYTES = 256 * 1024;

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    Object.keys(value).sort().join('\u001f') === [...expected].sort().join('\u001f');
}

function boundedProviderIdentifier(value, { nullable = false } = {}) {
  if (value === null) return nullable;
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function buildAuthoritativeSessionUpdate({ prompt, voice = DEFAULT_VOICE }) {
  return {
    type: 'session.update',
    session: {
      voice,
      instructions: prompt,
      modalities: ['audio'],
      input_audio_transcription: null,
      turn_detection: {
        type: 'server_vad',
        threshold: 0.85,
        silence_duration_ms: 800,
        prefix_padding_ms: 300,
        idle_timeout_ms: null,
      },
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 } },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
      resumption: { enabled: false },
    },
  };
}

function validateAudioEndpoint(value) {
  return exactKeys(value, ['format', 'transport']) &&
    exactKeys(value.format, ['type', 'rate']) &&
    value.format.type === 'audio/pcm' && value.format.rate === 24000 && value.transport === 'json';
}

function validatePreAttestationProviderEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (event.type === 'session.created') {
    if (!exactKeys(event, ['type', 'event_id', 'session']) || !boundedProviderIdentifier(event.event_id)) return false;
    const session = event.session;
    if (!exactKeys(session, ['id', 'instructions', 'modalities', 'model', 'object', 'tools', 'turn_detection', 'voice'])) return false;
    if (!boundedProviderIdentifier(session.id) || !boundedProviderIdentifier(session.voice)) return false;
    if (session.instructions !== '' || session.model !== MODEL || session.object !== 'realtime.session') return false;
    if (!Array.isArray(session.modalities) || session.modalities.length !== 1 || session.modalities[0] !== 'audio') return false;
    if (!Array.isArray(session.tools) || session.tools.length !== 0) return false;
    return session.turn_detection === null ||
      (exactKeys(session.turn_detection, ['type']) &&
        (session.turn_detection.type === null || session.turn_detection.type === 'server_vad'));
  }
  if (event.type === 'conversation.created') {
    if (!exactKeys(event, ['type', 'event_id', 'previous_item_id', 'conversation']) ||
        !boundedProviderIdentifier(event.event_id) ||
        !boundedProviderIdentifier(event.previous_item_id, { nullable: true })) return false;
    return exactKeys(event.conversation, ['id', 'object']) &&
      boundedProviderIdentifier(event.conversation.id) && event.conversation.object === 'realtime.conversation';
  }
  if (event.type === 'ping') {
    return exactKeys(event, ['type', 'event_id', 'previous_item_id', 'timestamp']) &&
      boundedProviderIdentifier(event.event_id) &&
      boundedProviderIdentifier(event.previous_item_id, { nullable: true }) &&
      Number.isSafeInteger(event.timestamp) && event.timestamp >= 0;
  }
  return false;
}

function sessionAttestationFailure(failureCategory, field) {
  return { ok: false, failure_category: failureCategory, field };
}

function attestSessionUpdated(event, { prompt, voice = DEFAULT_VOICE }) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.type !== 'session.updated' || !own(event, 'session')) {
    return sessionAttestationFailure('invalid_envelope', 'event');
  }
  const eventKeys = Object.keys(event);
  if (eventKeys.some((key) => !['type', 'session', 'event_id', 'previous_item_id'].includes(key))) return sessionAttestationFailure('unexpected_field', 'event');
  if (own(event, 'event_id') && !boundedProviderIdentifier(event.event_id)) return sessionAttestationFailure('invalid_identifier', 'event_id');
  if (own(event, 'previous_item_id') && !boundedProviderIdentifier(event.previous_item_id, { nullable: true })) return sessionAttestationFailure('invalid_identifier', 'previous_item_id');
  const session = event.session;
  const required = [
    'audio', 'enable_noise_suppression', 'enable_phonetic_spelling', 'input_audio_format',
    'input_audio_transcription', 'instructions', 'keep_context', 'max_response_output_tokens',
    'modalities', 'model', 'output_audio_format', 'temperature', 'tool_choice', 'turn_detection',
  ];
  const optional = ['resumption'];
  if (!session || typeof session !== 'object' || Array.isArray(session)) return sessionAttestationFailure('invalid_session', 'session');
  const keys = Object.keys(session);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) return sessionAttestationFailure('unexpected_field', 'session');
  const missingRequiredKey = required.find((key) => !own(session, key));
  if (missingRequiredKey) return sessionAttestationFailure('missing_field', missingRequiredKey);
  if (own(session, 'tools')) return sessionAttestationFailure('capability_drift', 'tools');
  if (session.instructions !== prompt) return sessionAttestationFailure('authority_drift', 'instructions');
  if (session.model !== MODEL) return sessionAttestationFailure('model_drift', 'model');
  if (!Array.isArray(session.modalities) || session.modalities.length !== 1 || session.modalities[0] !== 'audio') return sessionAttestationFailure('capability_drift', 'modalities');
  if (session.input_audio_transcription !== null) return sessionAttestationFailure('capability_drift', 'input_audio_transcription');
  if (session.keep_context !== false) return sessionAttestationFailure('retention_drift', 'keep_context');
  // xAI currently echoes this provider-managed compatibility preference as false
  // even when true is requested. It is not an authorization or data-retention
  // boundary, so accept either bounded boolean while retaining all critical checks.
  if (typeof session.enable_noise_suppression !== 'boolean') return sessionAttestationFailure('invalid_value', 'enable_noise_suppression');
  if (session.enable_phonetic_spelling !== false) return sessionAttestationFailure('capability_drift', 'enable_phonetic_spelling');
  if (session.input_audio_format !== 'not specified') return sessionAttestationFailure('transport_drift', 'input_audio_format');
  if (session.output_audio_format !== 'not specified') return sessionAttestationFailure('transport_drift', 'output_audio_format');
  if (session.max_response_output_tokens !== 'inf') return sessionAttestationFailure('limit_drift', 'max_response_output_tokens');
  if (session.temperature !== -1) return sessionAttestationFailure('generation_drift', 'temperature');
  if (session.tool_choice !== 'auto') return sessionAttestationFailure('capability_drift', 'tool_choice');
  if (!exactKeys(session.audio, ['input', 'output']) || !validateAudioEndpoint(session.audio.input) || !validateAudioEndpoint(session.audio.output)) return sessionAttestationFailure('transport_drift', 'audio');
  if (own(session.audio.input, 'transcription')) return sessionAttestationFailure('capability_drift', 'audio.input.transcription');
  const turn = session.turn_detection;
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return sessionAttestationFailure('invalid_value', 'turn_detection');
  const turnKeys = Object.keys(turn);
  if (turnKeys.some((key) => !['type', 'threshold', 'silence_duration_ms', 'prefix_padding_ms', 'idle_timeout_ms'].includes(key))) return sessionAttestationFailure('unexpected_field', 'turn_detection');
  if (turn.type !== 'server_vad' || turn.threshold !== 0.85 || turn.silence_duration_ms !== 800 || turn.prefix_padding_ms !== 300) return sessionAttestationFailure('vad_drift', 'turn_detection');
  if (own(turn, 'idle_timeout_ms') && turn.idle_timeout_ms !== null) return sessionAttestationFailure('vad_drift', 'turn_detection.idle_timeout_ms');
  if (own(session, 'resumption') && (!exactKeys(session.resumption, ['enabled']) || session.resumption.enabled !== false)) return sessionAttestationFailure('retention_drift', 'resumption');
  return { ok: true, failure_category: null, field: null };
}

function validateSessionUpdated(event, options) {
  return attestSessionUpdated(event, options).ok;
}

function decodeCanonicalAudio(value, maxBytes = MAX_AUDIO_BYTES) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.length % 2 !== 0 || decoded.length > maxBytes || decoded.toString('base64') !== value) return null;
  return decoded;
}

function validateBrowserEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return null;
  if (event.type === 'input_audio_buffer.clear') return exactKeys(event, ['type']) ? { type: event.type } : null;
  if (event.type === 'input_audio_buffer.append' && exactKeys(event, ['type', 'audio'])) {
    const audio = decodeCanonicalAudio(event.audio);
    if (!audio) return null;
    audio.fill(0);
    return { type: event.type, audio: event.audio };
  }
  return null;
}

function providerCapabilityEvent(type) {
  const segments = String(type || '').toLowerCase().split(/[._-]+/).filter(Boolean);
  const joined = segments.join('_');
  return ['function_call', 'tool', 'mcp', 'web_search', 'x_search', 'file_search'].some((marker) => joined.includes(marker));
}

function classifyProviderEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || event.type.length > 160) return { action: 'finalize' };
  const type = event.type;
  if (providerCapabilityEvent(type) || type === 'error') return { action: 'finalize' };
  if (type === 'response.created') return { action: 'forward', message: { type: 'speaking', active: true } };
  if (type === 'response.done') return { action: 'forward', message: { type: 'speaking', active: false } };
  if (type === 'input_audio_buffer.speech_started') return { action: 'forward_many', messages: [{ type: 'listening', active: true }, { type: 'speaking', active: false }] };
  if (type === 'input_audio_buffer.speech_stopped') return { action: 'forward', message: { type: 'listening', active: false } };
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    const decoded = decodeCanonicalAudio(event.delta, MAX_OUTBOUND_AUDIO_BYTES);
    if (!decoded) return { action: 'finalize' };
    const audioBytes = decoded.byteLength;
    decoded.fill(0);
    return { action: 'forward', message: { type: 'audio_delta', audio: event.delta }, audioBytes };
  }
  if (/transcript|output_text|input_text|conversation\.item|content_part/i.test(type)) return { action: 'drop' };
  return { action: 'drop' };
}

module.exports = {
  BROWSER_MAX_PAYLOAD,
  DEFAULT_VOICE,
  MAX_AUDIO_BYTES,
  MAX_OUTBOUND_AUDIO_BYTES,
  MODEL,
  UPSTREAM_MAX_PAYLOAD,
  UPSTREAM_URL,
  attestSessionUpdated,
  buildAuthoritativeSessionUpdate,
  boundedProviderIdentifier,
  classifyProviderEvent,
  decodeCanonicalAudio,
  exactKeys,
  providerCapabilityEvent,
  validateBrowserEvent,
  validatePreAttestationProviderEvent,
  validateSessionUpdated,
};
