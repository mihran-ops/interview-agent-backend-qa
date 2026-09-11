'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CONVERSATION_ID_PATHS,
  MAX_CONVERSATION_ID_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  buildTavusWebhookValidationTelemetry,
  extractCanonicalTavusConversationId,
  getOwnPath,
  validateTavusWebhookPayload,
} = require('../src/services/tavusWebhookPayload');

const CONVERSATION_ID = 'c-synthetic_valid-123';

function envelope(overrides = {}) {
  return {
    event_type: 'synthetic.unknown',
    conversation_id: CONVERSATION_ID,
    ...overrides,
  };
}

function expectInvalid(payload, category) {
  const result = validateTavusWebhookPayload(payload);
  assert.equal(result.ok, false);
  assert.equal(result.category, category);
  return result;
}

test('root validation rejects null, arrays, strings, numbers, and empty objects', () => {
  for (const payload of [null, [], 'payload', 7]) {
    expectInvalid(payload, 'invalid_root');
  }
  expectInvalid({}, 'missing_event_type');
});

test('event type validation rejects missing, non-string, blank, over-bound, and control-character values', () => {
  expectInvalid({ conversation_id: CONVERSATION_ID }, 'missing_event_type');
  for (const event_type of [7, {}, [], '', '   ', 'event\nname', 'x'.repeat(MAX_EVENT_TYPE_LENGTH + 1)]) {
    expectInvalid({ event_type, conversation_id: CONVERSATION_ID }, 'invalid_event_type');
  }
});

test('event matching is exact and the documented PAL join alias normalizes intentionally', () => {
  const exact = validateTavusWebhookPayload(envelope({
    event_type: 'system.replica_joined',
    properties: {},
  }));
  assert.equal(exact.ok, true);
  assert.equal(exact.eventType, 'system.replica_joined');
  assert.equal(exact.eventAliased, false);
  assert.equal(exact.supported, true);

  const alias = validateTavusWebhookPayload(envelope({
    event_type: 'system.pal_joined',
    properties: {},
  }));
  assert.equal(alias.ok, true);
  assert.equal(alias.eventType, 'system.replica_joined');
  assert.equal(alias.eventAliased, true);

  const caseChanged = validateTavusWebhookPayload(envelope({ event_type: 'System.Shutdown' }));
  assert.equal(caseChanged.ok, true);
  assert.equal(caseChanged.supported, false);
  assert.equal(caseChanged.eventType, 'System.Shutdown');
});

test('unknown well-formed event is classified as unsupported without rejecting harmless extra fields', () => {
  const result = validateTavusWebhookPayload(envelope({
    harmless_future_field: { arbitrary: ['data'] },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.supported, false);
  assert.equal(result.eventType, 'synthetic.unknown');
  assert.equal(result.conversationId, CONVERSATION_ID);
});

test('conversation identifier rejects missing, wrong-type, blank, over-bound, and control-character values', () => {
  expectInvalid({ event_type: 'synthetic.unknown' }, 'missing_conversation_id');
  for (const conversation_id of [7, [], {}, '', '   ', `conv\ninvalid`, 'x'.repeat(MAX_CONVERSATION_ID_LENGTH + 1)]) {
    expectInvalid({ event_type: 'synthetic.unknown', conversation_id }, 'invalid_conversation_id');
  }
});

test('valid Tavus-style identifier remains a string without UUID assumptions', () => {
  const result = validateTavusWebhookPayload(envelope());
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, CONVERSATION_ID);
});

test('all four final identifier aliases are explicit and identical populated aliases are accepted', () => {
  assert.deepEqual(
    CONVERSATION_ID_PATHS.map(({ path }) => path),
    [
      'conversation_id',
      'properties.conversation_id',
      'payload.conversation_id',
      'payload.properties.conversation_id',
    ],
  );
  const result = validateTavusWebhookPayload({
    event_type: 'synthetic.unknown',
    conversation_id: ` ${CONVERSATION_ID} `,
    properties: { conversation_id: CONVERSATION_ID },
    payload: {
      conversation_id: CONVERSATION_ID,
      properties: { conversation_id: CONVERSATION_ID },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, CONVERSATION_ID);
  assert.equal(result.identifierAliases.length, 4);
});

test('conflicting supported aliases are rejected and no identifier is selected', () => {
  const result = expectInvalid({
    event_type: 'synthetic.unknown',
    conversation_id: 'conversation-a',
    properties: { conversation_id: 'conversation-b' },
  }, 'conflicting_conversation_ids');
  assert.equal(result.identifierConflict, true);
  assert.equal(result.conversationId, undefined);
});

test('obsolete aliases are not accepted as canonical conversation identifiers', () => {
  for (const payload of [
    { event_type: 'synthetic.unknown', conversationId: CONVERSATION_ID },
    { event_type: 'synthetic.unknown', metadata: { conversation_id: CONVERSATION_ID } },
    { event_type: 'synthetic.unknown', conversation: { id: CONVERSATION_ID } },
    { event_type: 'synthetic.unknown', application_id: CONVERSATION_ID },
  ]) {
    expectInvalid(payload, 'missing_conversation_id');
  }
});

test('own-property traversal ignores inherited event and identifier properties', () => {
  const inherited = Object.create({
    event_type: 'system.shutdown',
    conversation_id: CONVERSATION_ID,
  });
  expectInvalid(inherited, 'invalid_root');

  const payload = { event_type: 'synthetic.unknown' };
  payload.properties = Object.create({ conversation_id: CONVERSATION_ID });
  expectInvalid(payload, 'missing_conversation_id');
  assert.deepEqual(getOwnPath(payload, 'properties.conversation_id'), { found: false, value: undefined });
});

test('transcription-ready accepts the documented transcript and rejects malformed snapshots before use', () => {
  const valid = validateTavusWebhookPayload(envelope({
    event_type: 'application.transcription_ready',
    properties: {
      transcript: [
        { role: 'assistant', content: 'Synthetic question.' },
        { role: 'user', content: 'Synthetic answer.' },
      ],
    },
  }));
  assert.equal(valid.ok, true);
  assert.equal(valid.supported, true);

  for (const properties of [
    {},
    { transcript: 'not-an-array' },
    { transcript: [null] },
    { transcript: [{ role: 7, content: 'text' }] },
    { transcript: [{ role: 'user', content: { unsafe: true } }] },
  ]) {
    expectInvalid(envelope({ event_type: 'application.transcription_ready', properties }), 'invalid_event_payload');
  }
});

test('recording-ready accepts current storage metadata and rejects unsafe URL or metadata shapes', () => {
  const valid = validateTavusWebhookPayload(envelope({
    event_type: 'application.recording_ready',
    properties: {
      storage_provider: 's3',
      storage_uri: 's3://synthetic-bucket/synthetic-key',
      bucket_name: 'synthetic-bucket',
      s3_key: 'synthetic-key',
      duration: 14,
    },
  }));
  assert.equal(valid.ok, true);

  expectInvalid(envelope({ event_type: 'application.recording_ready', properties: {} }), 'invalid_event_payload');
  expectInvalid(envelope({
    event_type: 'application.recording_ready',
    properties: { recording_url: { href: 'https://example.invalid/recording' } },
  }), 'invalid_event_payload');
  expectInvalid(envelope({
    event_type: 'application.recording_ready',
    properties: { recording_url: 'javascript:alert(1)' },
  }), 'invalid_event_payload');
  expectInvalid(envelope({
    event_type: 'application.recording_ready',
    properties: { duration: -1 },
  }), 'invalid_event_payload');
});

test('perception analysis validates only the consumed analysis shape', () => {
  for (const event_type of ['application.perception_analysis', 'conversation.perception_analysis']) {
    assert.equal(validateTavusWebhookPayload(envelope({
      event_type,
      properties: { analysis: 'Synthetic bounded analysis.' },
    })).ok, true);
    assert.equal(validateTavusWebhookPayload(envelope({
      event_type,
      properties: { analysis: { overall: 80 } },
    })).ok, true);
    expectInvalid(envelope({ event_type, properties: { analysis: [] } }), 'invalid_event_payload');
    expectInvalid(envelope({ event_type, properties: {} }), 'invalid_event_payload');
  }
});

test('tool and perception-tool events require a bounded string name and safe argument shape', () => {
  for (const event_type of ['conversation.tool_call', 'conversation.perception_tool_call']) {
    assert.equal(validateTavusWebhookPayload(envelope({
      event_type,
      properties: { name: 'end_call', arguments: '{"reason":"synthetic"}' },
    })).ok, true);
    expectInvalid(envelope({ event_type, properties: {} }), 'invalid_event_payload');
    expectInvalid(envelope({ event_type, properties: { name: 7 } }), 'invalid_event_payload');
    expectInvalid(envelope({ event_type, properties: { name: 'end_call', arguments: [] } }), 'invalid_event_payload');
  }
});

test('replica-joined, shutdown, utterance, speaking, and connection lifecycle shapes remain valid', () => {
  const payloads = [
    envelope({ event_type: 'system.replica_joined', properties: { face_id: 'face-synthetic' } }),
    envelope({ event_type: 'system.shutdown', properties: { shutdown_reason: 'end_conversation_endpoint_hit' } }),
    envelope({ event_type: 'conversation.utterance', properties: { role: 'user', speech: 'Synthetic speech.' } }),
    envelope({ event_type: 'conversation.started_speaking', properties: { role: 'replica' } }),
    envelope({ event_type: 'conversation.stopped_speaking', properties: { role: 'user', interrupted: false, duration: 1.25 } }),
    envelope({ event_type: 'conversation.connected' }),
    envelope({ event_type: 'conversation.disconnected' }),
  ];
  for (const payload of payloads) assert.equal(validateTavusWebhookPayload(payload).ok, true);

  expectInvalid(envelope({
    event_type: 'conversation.utterance',
    properties: { role: 'user', speech: { raw: true } },
  }), 'invalid_event_payload');
  expectInvalid(envelope({
    event_type: 'conversation.stopped_speaking',
    properties: { role: 'user', interrupted: 'false', duration: -1 },
  }), 'invalid_event_payload');
});

test('validation telemetry is bounded and never contains the raw payload or identifier', () => {
  const secret = 'synthetic-webhook-secret-never-log';
  const transcript = 'candidate transcript never log';
  const signedUrl = 'https://example.invalid/recording?signature=never-log';
  const result = validateTavusWebhookPayload({
    event_type: 'application.recording_ready',
    conversation_id: 'conversation-a',
    properties: {
      conversation_id: 'conversation-b',
      recording_url: signedUrl,
      transcript,
      secret,
    },
  });
  const telemetry = buildTavusWebhookValidationTelemetry(result);
  assert.deepEqual(telemetry, {
    validation_category: 'conflicting_conversation_ids',
    identifier_present: true,
    identifier_conflict: true,
    event_type: 'application.recording_ready',
  });
  const serialized = JSON.stringify(telemetry);
  for (const sentinel of [secret, transcript, signedUrl, 'conversation-a', 'conversation-b']) {
    assert.doesNotMatch(serialized, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('canonical extractor returns the same normalized value independently', () => {
  const result = extractCanonicalTavusConversationId({
    conversation_id: `  ${CONVERSATION_ID}  `,
    payload: { conversation_id: CONVERSATION_ID },
  }, 'synthetic.unknown');
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, CONVERSATION_ID);
});
