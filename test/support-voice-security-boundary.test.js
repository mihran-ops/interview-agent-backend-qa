const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSupportVoicePrompt, MAX_PROMPT_BYTES, SUPPORT_GREETING, SUPPORT_POLICY } = require('../src/services/supportVoiceKnowledge');
const { buildAuthoritativeSessionUpdate } = require('../src/services/supportVoiceProtocol');

const root = path.resolve(__dirname, '..');
const voiceFiles = [
  'src/services/supportVoiceGateway.js',
  'src/services/supportVoiceKnowledge.js',
  'src/services/supportVoiceMembership.js',
  'src/services/supportVoiceProtocol.js',
  'src/services/supportVoiceSessionStore.js',
].map((relative) => ({ relative, source: fs.readFileSync(path.join(root, relative), 'utf8') }));

test('voice call graph has no tenant, candidate, billing, transcript, account-action, tool, or selected-scope path', () => {
  const combined = voiceFiles.map((file) => file.source).join('\n');
  for (const forbidden of [
    /withClientScope/,
    /req\.client/i,
    /selected[_-]?client/i,
    /routes\/(?:candidate|interview|report|billing|role)/i,
    /\.from\(['"](?:clients|roles|candidates|interviews|reports|otp_tokens|billing_events|conversations)['"]\)/i,
    /function_call_output|tools\s*:/i,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.match(combined, /\.from\('client_members'\)/);
  assert.match(combined, /rpc\('service_reserve_support_voice_session'/);
  assert.doesNotMatch(combined, /\.from\('support_voice_sessions'\)/);
});

test('authoritative support prompt is bounded, informational-only, and produces an audio-only no-tool session', () => {
  const built = buildSupportVoicePrompt();
  assert.ok(built.promptBytes > 40_000);
  assert.ok(built.promptBytes <= MAX_PROMPT_BYTES);
  assert.match(SUPPORT_POLICY, /slightly concise by default unless the caller asks for more detail/i);
  assert.match(SUPPORT_POLICY, /cannot access or inspect the caller's account/i);
  assert.match(SUPPORT_POLICY, /Do not use tools, functions, MCP, web search, files, databases, APIs/i);
  assert.doesNotMatch(SUPPORT_GREETING, /account|candidate|billing|transcript|follow.?up/i);
  const update = buildAuthoritativeSessionUpdate({ prompt: built.prompt });
  assert.deepEqual(update.session.modalities, ['audio']);
  assert.equal(update.session.input_audio_transcription, null);
  assert.deepEqual(update.session.resumption, { enabled: false });
  assert.equal(Object.hasOwn(update.session, 'tools'), false);
  assert.equal(Object.hasOwn(update.session, 'tool_choice'), false);
});

test('gateway target is compile-time xAI only and sensitive state is never written to durable storage', () => {
  const protocol = voiceFiles.find((file) => file.relative.endsWith('supportVoiceProtocol.js')).source;
  const combined = voiceFiles.map((file) => file.source).join('\n');
  assert.match(protocol, /wss:\/\/api\.x\.ai\/v1\/realtime\?model=/);
  assert.doesNotMatch(protocol, /process\.env\.(?:XAI_URL|XAI_HOST|XAI_MODEL)/);
  assert.doesNotMatch(combined, /writeFile|appendFile|createWriteStream|localStorage|sessionStorage|indexedDB|analytics\.|captureMessage|captureException/);
  assert.doesNotMatch(combined, /console\.(?:log|error|warn|debug)/);
});

test('feature-specific routes mount before broad CORS and JSON middleware', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const voiceMount = app.indexOf("app.use('/api/support/voice'");
  const broadCors = app.indexOf('app.use(cors({');
  const broadJson = app.indexOf("app.use(express.json({ limit: '10mb' }))");
  assert.ok(voiceMount > 0 && voiceMount < broadCors && voiceMount < broadJson);
});
