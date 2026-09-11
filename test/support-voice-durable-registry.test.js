const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const gatewaySource = () => fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'supportVoiceGateway.js'),
  'utf8',
);

test('support voice credential authority is durable rather than process-local', () => {
  const source = gatewaySource();
  assert.match(source, /supportVoiceSessionStore/);
  assert.doesNotMatch(source, /const userSessions = new Map\(\)/);
  assert.doesNotMatch(source, /for \(const entry of sessions\.values\(\)\)[\s\S]*credentialDigest/);
});

test('support voice origin is environment-owned and the external scale monitor is gone', () => {
  const source = gatewaySource();
  assert.match(source, /SUPPORT_VOICE_ALLOWED_ORIGIN/);
  assert.doesNotMatch(source, /QA_ORIGIN/);
  assert.doesNotMatch(source, /monitorRouter/);
  assert.doesNotMatch(source, /scaleLease/);
});
