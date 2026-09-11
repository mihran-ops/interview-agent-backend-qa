'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('candidate OTP issuance does not use Math.random or persist plaintext codes', () => {
  const source = read('src/routes/public/candidateSubmit.js');
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /\.from\(['"]otp_tokens['"]\)\.insert/);
});

test('OTP verification is challenge-addressed and never compares a stored plaintext code', () => {
  const source = read('src/routes/public/verifyOtp.js');
  assert.match(source, /challenge_id/);
  assert.doesNotMatch(source, /token\.code/);
  assert.doesNotMatch(source, /select\(['"][^'"]*\bcode\b/);
});

test('interview launch is protected by an HttpOnly launch capability', () => {
  const source = read('src/routes/public/createTavusInterview.js');
  assert.match(source, /requireOtpLaunchCapability/);
  assert.match(source, /clearOtpLaunchCapability/);
});
