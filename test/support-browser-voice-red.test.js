const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('backend mounts an authenticated support voice REST and WebSocket gateway', () => {
  const app = read('app.js');
  assert.match(app, /createSupportVoiceGateway/);
  assert.match(app, /\/api\/support\/voice/);
});

test('backend has one server-owned support prompt and knowledge snapshot', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src/services/supportVoiceKnowledge.js')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/content/support-voice-knowledge.json')), true);
});

test('backend declares a bounded WebSocket transport dependency', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(typeof packageJson.dependencies?.ws, 'string');
});
