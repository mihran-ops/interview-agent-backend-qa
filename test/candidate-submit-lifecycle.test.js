'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createCandidateSubmitLifecycle,
  createCandidateUploadMiddleware,
  markCandidateSubmitStage,
} = require('../src/services/candidateSubmitLifecycle');

function request(headers = {}) {
  const req = new EventEmitter();
  req.request_id = 'request-id';
  req.get = (name) => headers[String(name || '').toLowerCase()] || null;
  return req;
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = false;
  return res;
}

test('candidate submission lifecycle records bounded transport identity and final stage', () => {
  const events = [];
  let now = 1000;
  const middleware = createCandidateSubmitLifecycle({
    now: () => now,
    logger: { info: (message, metadata) => events.push({ message, metadata }) },
  });
  const req = request({
    'rndr-id': 'render-request-id',
    'cf-ray': 'cloudflare-ray-id',
    'content-length': '1200',
    'content-type': 'multipart/form-data; boundary=private-boundary',
  });
  const res = response();

  middleware(req, res, () => {});
  now = 1030;
  markCandidateSubmitStage(req, 'reservation_acquired', { channel: 'email' });
  now = 1080;
  res.writableEnded = true;
  res.emit('finish');

  assert.deepEqual(events.map((event) => event.message), [
    '[candidate-submit] lifecycle_received',
    '[candidate-submit] lifecycle_stage',
    '[candidate-submit] lifecycle_response_finished',
  ]);
  assert.equal(events[0].metadata.content_type, 'multipart');
  assert.equal(events[0].metadata.content_length_bytes, 1200);
  assert.equal(events[1].metadata.stage, 'reservation_acquired');
  assert.equal(events[2].metadata.elapsed_ms, 80);
  assert.equal(JSON.stringify(events).includes('private-boundary'), false);
});

test('candidate submission lifecycle reports an aborted upload exactly once', () => {
  const events = [];
  const middleware = createCandidateSubmitLifecycle({
    now: () => 1000,
    logger: { info: (message, metadata) => events.push({ message, metadata }) },
  });
  const req = request();
  const res = response();
  middleware(req, res, () => {});
  req.emit('aborted');
  res.emit('close');

  assert.equal(events.filter((event) => event.message.includes('aborted')).length, 1);
  assert.equal(events.filter((event) => event.message.includes('connection_closed')).length, 0);
});

test('candidate upload middleware marks multipart completion without file content', async () => {
  const events = [];
  const req = request();
  const res = response();
  createCandidateSubmitLifecycle({
    now: () => 1000,
    logger: { info: (message, metadata) => events.push({ message, metadata }) },
  })(req, res, () => {});

  const upload = createCandidateUploadMiddleware((incoming, _response, callback) => {
    incoming.files = [{ size: 512, buffer: Buffer.from('private resume content') }];
    callback();
  });
  await new Promise((resolve, reject) => upload(req, res, (error) => error ? reject(error) : resolve()));

  const stage = events.find((event) => event.metadata.stage === 'multipart_complete');
  assert.equal(stage.metadata.file_count, 1);
  assert.equal(stage.metadata.file_size_bytes, 512);
  assert.equal(JSON.stringify(events).includes('private resume content'), false);
});
