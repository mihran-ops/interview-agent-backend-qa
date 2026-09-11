'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'normal-closing-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'normal-closing-anon-key';

const {
  NORMAL_COMPLETION_FAREWELL_TEXT,
  buildConversationalContext,
} = require('../src/services/tavusInterview');
const { isTerminalInterviewToolName } = require('../src/services/tavusTerminalTool');

const ROOT = path.join(__dirname, '..');
const personaScript = fs.readFileSync(path.join(ROOT, 'scripts', 'patchTavusQaP1Persona.js'), 'utf8');
const webhookSource = fs.readFileSync(path.join(ROOT, 'src', 'services', 'tavusEvents', 'index.js'), 'utf8');

function occurrences(value, search) {
  return String(value).split(search).length - 1;
}

function escapedRegex(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

test('normal completion contract is exact, singular, and uses Tavus end_call', () => {
  const context = buildConversationalContext(
    'Avery',
    'Customer Service Representative',
    'Synthetic Company',
    ['Describe a customer issue you resolved.'],
    '',
    10,
  );

  assert.equal(NORMAL_COMPLETION_FAREWELL_TEXT, 'Thank you for your time. I am ending the session now.');
  assert.equal(occurrences(context, 'Do you have any questions before we wrap up?'), 1);
  assert.match(context, /call the built-in end_call tool with reason "natural_conclusion"/);
  assert.match(context, /response_to_user exactly: "Thank you for your time\. I am ending the session now\."/);
  assert.match(context, /Never repeat this closing question/);
  assert.match(context, /Never say or imply "we'll be in touch"/);
  assert.doesNotMatch(context, /call(?:\/use)? the existing end_interview tool/i);
});

test('closing denials are explicitly answers and cannot use the unavailable-information fallback', () => {
  const context = buildConversationalContext(
    'Avery',
    'Customer Service Representative',
    '',
    ['Describe a customer issue you resolved.'],
  );
  for (const phrase of ['no', 'none', "I don't have any", 'no questions', 'nothing else', 'none that I can think of']) {
    assert.match(context, escapedRegex(phrase));
    assert.match(personaScript, escapedRegex(phrase));
  }
  assert.match(context, /closing answer, not a candidate question/i);
  assert.match(context, /Never use the unavailable-information fallback for a closing answer/i);
  assert.match(personaScript, /They are not live candidate questions and must never trigger the unavailable-information response/i);
});

test('refusal or inability exhausts the one allowed follow-up', () => {
  const context = buildConversationalContext(
    'Avery',
    'Customer Service Representative',
    '',
    ['Describe a customer issue you resolved.'],
  );
  assert.match(context, /A refusal, inability to answer, or statement that the candidate cannot think of an example completes the permitted follow-up/);
  assert.match(context, /Never ask a second follow-up, hypothetical, rephrased question, alternate question, or another request for an example/);
  assert.match(personaScript, /Never ask a second follow-up, hypothetical, rephrased question, alternate question, or another request for an example/);
});

test('backend terminal tool contract supports current and legacy names', () => {
  assert.equal(isTerminalInterviewToolName('end_call'), true);
  assert.equal(isTerminalInterviewToolName(' END_CALL '), true);
  assert.equal(isTerminalInterviewToolName('end_interview'), true);
  assert.equal(isTerminalInterviewToolName('unknown_tool'), false);
  assert.match(webhookSource, /isTerminalInterviewToolName\(toolName\)/);
  assert.doesNotMatch(webhookSource, /toolName === 'end_interview'/);
});
