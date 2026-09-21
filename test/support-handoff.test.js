const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createSupportHandoff, createPhoneHandoffRouter, validateHandoff, SUPPORT_TOOL } = require('../src/services/supportHandoff');
const { classifyProviderEvent } = require('../src/services/supportVoiceProtocol');

const input = { summary: 'Please help with the role setup workflow', contact_name: 'Alex Rivera', contact_email: 'client@example.com', confirmed: true };
const env = { SUPPORT_HANDOFF_ENABLED: 'true', SENDGRID_API_KEY: 'not-a-real-key-xxxxxxxxxxxxxxxx', SUPPORT_PHONE_HANDOFF_TOKEN: 'not-a-real-phone-token-xxxxxxxxxxxxxxxx' };
function harness(fetchImpl = async () => ({ status: 202 })) {
  const calls = [], counts = new Map();
  const service = createSupportHandoff({ env, fetch: async (...args) => { calls.push(args); return fetchImpl(...args); }, rateLimit: async ({ routeName, subjectKey, maxCount }) => {
    assert.doesNotMatch(subjectKey, /client@|Please help/);
    const key = `${routeName}:${subjectKey}`; const count = (counts.get(key) || 0) + 1; counts.set(key, count);
    return { allowed: count <= maxCount };
  } });
  return { service, calls };
}
test('only explicit confirmed bounded inputs can be sent; recipients cannot be overridden', () => {
  for (const bad of [null, { ...input, contact_name: undefined }, { ...input, contact_name: '' }, { ...input, contact_name: 'a'.repeat(121) }, { ...input, contact_name: 'Alex\r\nBcc:other@example.com' }, { ...input, confirmed: false }, { ...input, confirmed: 'true' }, { ...input, to: 'other@example.com' }, { ...input, summary: 'code 123456' }, { ...input, summary: 'open https://private.example/link' }, { ...input, contact_email: 'a@example.com\r\nBcc:b@example.com' }, { ...input, summary: 'a'.repeat(1001) }]) assert.equal(validateHandoff(bad), null);
  assert.deepEqual(validateHandoff(input), input);
  for (const contact_name of ['李', 'Élodie O’Connor', 'Jean-Luc']) assert.equal(validateHandoff({ ...input, contact_name }).contact_name, contact_name);
});
test('one fixed team message is submitted and duplicate requests cannot resend', async () => {
  const { service, calls } = harness();
  assert.equal((await service.send(input, { channel: 'dashboard', requestKey: 'session-1' })).status, 'accepted');
  assert.equal((await service.send(input, { channel: 'dashboard', requestKey: 'session-1' })).status, 'already_attempted');
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0][1].body);
  assert.deepEqual(body.personalizations, [{ to: [{ email: 'support@alphasourceai.com' }] }]);
  assert.equal(body.from.email, 'support-agent@alphasourceai.com');
  assert.equal(body.reply_to.email, input.contact_email);
  assert.equal(body.reply_to.name, input.contact_name);
  assert.match(body.content[0].value, /Alex Rivera used Talk with Support/);
  assert.doesNotMatch(body.content[0].value, /Someone used|Someone called/);
  assert.equal(Object.hasOwn(body, 'attachments'), false);
});
test('uncertain sends cannot retry; rate backend failure fails closed', async () => {
  const { service, calls } = harness(async () => { throw new Error('timeout'); });
  assert.equal((await service.send(input, { channel: 'phone', requestKey: 'call-1' })).status, 'unknown');
  assert.equal((await service.send(input, { channel: 'phone', requestKey: 'call-1' })).status, 'already_attempted');
  assert.equal(calls.length, 1);
  const blocked = createSupportHandoff({ env, rateLimit: async () => { throw new Error('db unavailable'); }, fetch: () => assert.fail('must not send') });
  assert.equal((await blocked.send(input, { channel: 'phone', requestKey: 'call-2' })).status, 'unavailable');
});
test('only the named tool is accepted when explicitly enabled', () => {
  const event = { type: 'response.function_call_arguments.done', name: SUPPORT_TOOL.name, call_id: 'call-1', arguments: JSON.stringify(input) };
  assert.equal(classifyProviderEvent(event).action, 'finalize');
  assert.equal(classifyProviderEvent(event, { handoff: true }).action, 'support_handoff');
  assert.equal(classifyProviderEvent({ ...event, name: 'send_arbitrary_email' }, { handoff: true }).action, 'finalize');
  assert.equal(classifyProviderEvent({ ...event, arguments: 'x'.repeat(4097) }, { handoff: true }).action, 'finalize');
});
test('phone endpoint rejects missing credentials, browser origins and invalid consent', async () => {
  const { service, calls } = harness();
  const app = express(); app.use('/handoff', createPhoneHandoffRouter({ env, service }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/handoff`;
    const send = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const authorization = `Bearer ${env.SUPPORT_PHONE_HANDOFF_TOKEN}`;
    assert.equal((await send(input)).status, 401);
    assert.equal((await send(input, { Authorization: authorization, Origin: 'https://evil.example' })).status, 401);
    assert.equal((await send({ ...input, confirmed: false }, { Authorization: authorization })).status, 400);
    assert.equal((await send(input, { Authorization: authorization })).status, 200);
    assert.equal((await send(input, { Authorization: authorization })).status, 503);
    assert.equal(calls.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
