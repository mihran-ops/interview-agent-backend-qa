'use strict';

const MAX_EVENT_TYPE_LENGTH = 120;
const MAX_CONVERSATION_ID_LENGTH = 200;
const MAX_TOOL_NAME_LENGTH = 120;
const MAX_TRANSCRIPT_ITEMS = 10_000;
const MAX_URL_LENGTH = 4_096;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/;

const CONVERSATION_ID_PATHS = Object.freeze([
  Object.freeze({ path: 'conversation_id', classification: 'CURRENT_TAVUS_CONTRACT' }),
  Object.freeze({ path: 'properties.conversation_id', classification: 'REQUIRED_LEGACY_COMPATIBILITY' }),
  Object.freeze({ path: 'payload.conversation_id', classification: 'REQUIRED_LEGACY_COMPATIBILITY' }),
  Object.freeze({ path: 'payload.properties.conversation_id', classification: 'REQUIRED_LEGACY_COMPATIBILITY' }),
]);

const EVENT_TYPE_ALIASES = Object.freeze({
  // Tavus documents these as identical callbacks. Keep alphaScreen's existing
  // internal event name so replica-join lifecycle behavior does not change.
  'system.pal_joined': 'system.replica_joined',
});

const SUPPORTED_EVENT_TYPES = new Set([
  'system.replica_joined',
  'system.shutdown',
  'application.transcription_ready',
  'application.recording_ready',
  'application.perception_analysis',
  'conversation.perception_analysis',
  'conversation.utterance',
  'conversation.perception_tool_call',
  'conversation.tool_call',
  'conversation.started_speaking',
  'conversation.stopped_speaking',
  // Retained application lifecycle compatibility. These are not fuzzy aliases.
  'conversation.connected',
  'conversation.disconnected',
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getOwnPath(root, path) {
  let current = root;
  for (const part of String(path).split('.')) {
    if (!isPlainObject(current) || !hasOwn(current, part)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function invalid(category, details = {}) {
  return {
    ok: false,
    category,
    eventType: details.eventType || null,
    identifierPresent: details.identifierPresent === true,
    identifierConflict: category === 'conflicting_conversation_ids',
  };
}

function normalizeEventType(payload) {
  const event = getOwnPath(payload, 'event_type');
  if (!event.found) return invalid('missing_event_type');
  if (typeof event.value !== 'string') return invalid('invalid_event_type');
  if (CONTROL_CHARACTER_RE.test(event.value)) return invalid('invalid_event_type');
  const normalized = event.value.trim();
  if (!normalized || normalized.length > MAX_EVENT_TYPE_LENGTH) {
    return invalid('invalid_event_type');
  }
  const eventType = EVENT_TYPE_ALIASES[normalized] || normalized;
  return {
    ok: true,
    eventType,
    originalEventType: normalized,
    aliased: eventType !== normalized,
  };
}

function extractCanonicalTavusConversationId(payload, eventType = null) {
  const populated = [];
  let identifierPresent = false;

  for (const definition of CONVERSATION_ID_PATHS) {
    const candidate = getOwnPath(payload, definition.path);
    if (!candidate.found) continue;
    identifierPresent = true;
    if (typeof candidate.value !== 'string' || CONTROL_CHARACTER_RE.test(candidate.value)) {
      return invalid('invalid_conversation_id', { eventType, identifierPresent });
    }
    const normalized = candidate.value.trim();
    if (!normalized || normalized.length > MAX_CONVERSATION_ID_LENGTH) {
      return invalid('invalid_conversation_id', { eventType, identifierPresent });
    }
    populated.push({ ...definition, value: normalized });
  }

  if (!populated.length) {
    return invalid('missing_conversation_id', { eventType, identifierPresent });
  }
  const canonicalValue = populated[0].value;
  if (populated.some((candidate) => candidate.value !== canonicalValue)) {
    return invalid('conflicting_conversation_ids', { eventType, identifierPresent: true });
  }
  return {
    ok: true,
    conversationId: canonicalValue,
    aliases: populated.map(({ path, classification }) => ({ path, classification })),
    identifierPresent: true,
  };
}

function validatePlainProperties(payload, eventType) {
  const properties = getOwnPath(payload, 'properties');
  if (properties.found && !isPlainObject(properties.value)) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  return { ok: true };
}

function firstOwnValue(payload, paths) {
  for (const path of paths) {
    const candidate = getOwnPath(payload, path);
    if (candidate.found) return candidate;
  }
  return { found: false, value: undefined };
}

function validateTranscriptEvent(payload, eventType) {
  const transcript = firstOwnValue(payload, [
    'properties.transcript',
    'transcript',
    'payload.transcript',
    'messages',
  ]);
  if (!transcript.found) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  const items = Array.isArray(transcript.value)
    ? transcript.value
    : isPlainObject(transcript.value) && Array.isArray(transcript.value.messages)
      ? transcript.value.messages
      : null;
  if (!items || items.length > MAX_TRANSCRIPT_ITEMS) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  for (const item of items) {
    if (!isPlainObject(item)) {
      return invalid('invalid_event_payload', { eventType, identifierPresent: true });
    }
    if (hasOwn(item, 'role') && typeof item.role !== 'string') {
      return invalid('invalid_event_payload', { eventType, identifierPresent: true });
    }
    for (const contentKey of ['content', 'text', 'message', 'value']) {
      if (hasOwn(item, contentKey) && typeof item[contentKey] !== 'string') {
        return invalid('invalid_event_payload', { eventType, identifierPresent: true });
      }
    }
  }
  return { ok: true };
}

function validateOptionalStrings(payload, paths, eventType, options = {}) {
  let present = false;
  for (const path of paths) {
    const candidate = getOwnPath(payload, path);
    if (!candidate.found || candidate.value === null) continue;
    present = true;
    if (typeof candidate.value !== 'string' || candidate.value.length > (options.maxLength || MAX_URL_LENGTH)) {
      return invalid('invalid_event_payload', { eventType, identifierPresent: true });
    }
    if (options.nonEmpty && !candidate.value.trim()) {
      return invalid('invalid_event_payload', { eventType, identifierPresent: true });
    }
    if (options.url) {
      try {
        const parsed = new URL(candidate.value);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
      } catch {
        return invalid('invalid_event_payload', { eventType, identifierPresent: true });
      }
    }
  }
  return { ok: true, present };
}

function validateRecordingEvent(payload, eventType) {
  const propertiesResult = validatePlainProperties(payload, eventType);
  if (!propertiesResult.ok) return propertiesResult;

  const urlResult = validateOptionalStrings(payload, [
    'properties.recording_url',
    'properties.video_url',
    'recording_url',
    'video_url',
    'payload.recording_url',
    'payload.video_url',
    'output.video_url',
  ], eventType, { url: true, nonEmpty: true });
  if (!urlResult.ok) return urlResult;

  const storageResult = validateOptionalStrings(payload, [
    'properties.storage_provider',
    'properties.storage_uri',
    'properties.bucket_name',
    'properties.s3_key',
    'storage_provider',
    'storage_uri',
    'bucket_name',
    's3_key',
    'payload.bucket_name',
    'payload.s3_key',
    'output.bucket_name',
    'output.s3_key',
  ], eventType, { nonEmpty: true });
  if (!storageResult.ok) return storageResult;

  let durationPresent = false;
  for (const path of ['properties.duration', 'duration', 'payload.duration', 'output.duration']) {
    const duration = getOwnPath(payload, path);
    if (!duration.found || duration.value === null) continue;
    durationPresent = true;
    const numeric = typeof duration.value === 'number'
      ? duration.value
      : (typeof duration.value === 'string' && duration.value.trim() ? Number(duration.value) : NaN);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return invalid('invalid_event_payload', { eventType, identifierPresent: true });
    }
  }

  if (!urlResult.present && !storageResult.present && !durationPresent) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  return { ok: true };
}

function validatePerceptionAnalysisEvent(payload, eventType) {
  const propertiesResult = validatePlainProperties(payload, eventType);
  if (!propertiesResult.ok) return propertiesResult;
  const analysis = firstOwnValue(payload, [
    'properties.analysis',
    'analysis',
    'payload.analysis',
    'properties.perception_analysis',
    'perception_analysis',
    'payload.perception_analysis',
  ]);
  if (!analysis.found) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  if (typeof analysis.value === 'string') {
    return analysis.value.trim()
      ? { ok: true }
      : invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  return isPlainObject(analysis.value)
    ? { ok: true }
    : invalid('invalid_event_payload', { eventType, identifierPresent: true });
}

function validateToolEvent(payload, eventType) {
  const propertiesResult = validatePlainProperties(payload, eventType);
  if (!propertiesResult.ok) return propertiesResult;
  const name = firstOwnValue(payload, [
    'properties.name',
    'properties.tool_name',
    'tool_name',
    'tool.name',
    'name',
    'payload.tool_name',
    'payload.tool.name',
  ]);
  if (
    !name.found ||
    typeof name.value !== 'string' ||
    !name.value.trim() ||
    name.value.trim().length > MAX_TOOL_NAME_LENGTH ||
    CONTROL_CHARACTER_RE.test(name.value)
  ) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  const args = firstOwnValue(payload, [
    'properties.arguments',
    'properties.tool_arguments',
    'tool_arguments',
    'tool.arguments',
    'arguments',
    'payload.tool_arguments',
    'payload.tool.arguments',
  ]);
  if (
    args.found &&
    args.value !== null &&
    typeof args.value !== 'string' &&
    !isPlainObject(args.value)
  ) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  return { ok: true };
}

function validateLifecycleEvent(payload, eventType) {
  const propertiesResult = validatePlainProperties(payload, eventType);
  if (!propertiesResult.ok) return propertiesResult;
  const role = firstOwnValue(payload, ['properties.role', 'role', 'payload.properties.role', 'payload.role']);
  if (role.found && role.value !== null && (typeof role.value !== 'string' || role.value.length > 32)) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  const speech = firstOwnValue(payload, [
    'properties.speech',
    'properties.text',
    'speech',
    'text',
    'payload.properties.speech',
    'payload.properties.text',
  ]);
  if (speech.found && speech.value !== null && typeof speech.value !== 'string') {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  return { ok: true };
}

function validateSpeakingEvent(payload, eventType) {
  const lifecycle = validateLifecycleEvent(payload, eventType);
  if (!lifecycle.ok) return lifecycle;
  const interrupted = getOwnPath(payload, 'properties.interrupted');
  if (interrupted.found && interrupted.value !== null && typeof interrupted.value !== 'boolean') {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  const duration = getOwnPath(payload, 'properties.duration');
  if (duration.found && duration.value !== null && (!Number.isFinite(duration.value) || duration.value < 0)) {
    return invalid('invalid_event_payload', { eventType, identifierPresent: true });
  }
  return { ok: true };
}

function validateEventPayload(payload, eventType) {
  if (eventType === 'application.transcription_ready') return validateTranscriptEvent(payload, eventType);
  if (eventType === 'application.recording_ready') return validateRecordingEvent(payload, eventType);
  if (eventType === 'application.perception_analysis' || eventType === 'conversation.perception_analysis') {
    return validatePerceptionAnalysisEvent(payload, eventType);
  }
  if (eventType === 'conversation.tool_call' || eventType === 'conversation.perception_tool_call') {
    return validateToolEvent(payload, eventType);
  }
  if (eventType === 'conversation.utterance') return validateLifecycleEvent(payload, eventType);
  if (eventType === 'conversation.started_speaking' || eventType === 'conversation.stopped_speaking') {
    return validateSpeakingEvent(payload, eventType);
  }
  if (eventType === 'system.replica_joined' || eventType === 'system.shutdown') {
    return validatePlainProperties(payload, eventType);
  }
  return { ok: true };
}

function validateTavusWebhookPayload(payload) {
  if (!isPlainObject(payload)) return invalid('invalid_root');

  const eventResult = normalizeEventType(payload);
  if (!eventResult.ok) return eventResult;

  const idResult = extractCanonicalTavusConversationId(payload, eventResult.eventType);
  if (!idResult.ok) return idResult;

  const supported = SUPPORTED_EVENT_TYPES.has(eventResult.eventType);
  if (supported) {
    const eventPayloadResult = validateEventPayload(payload, eventResult.eventType);
    if (!eventPayloadResult.ok) return eventPayloadResult;
  }

  return {
    ok: true,
    eventType: eventResult.eventType,
    originalEventType: eventResult.originalEventType,
    eventAliased: eventResult.aliased,
    supported,
    conversationId: idResult.conversationId,
    identifierAliases: idResult.aliases,
  };
}

function buildTavusWebhookValidationTelemetry(result) {
  return {
    validation_category: result?.ok ? (result.supported ? 'supported_event' : 'unsupported_event') : (result?.category || 'invalid_root'),
    identifier_present: result?.ok ? true : result?.identifierPresent === true,
    identifier_conflict: result?.identifierConflict === true,
    event_type: typeof result?.eventType === 'string' ? result.eventType : null,
  };
}

module.exports = {
  CONVERSATION_ID_PATHS,
  EVENT_TYPE_ALIASES,
  MAX_CONVERSATION_ID_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  SUPPORTED_EVENT_TYPES,
  buildTavusWebhookValidationTelemetry,
  extractCanonicalTavusConversationId,
  getOwnPath,
  isPlainObject,
  normalizeEventType,
  validateTavusWebhookPayload,
};
