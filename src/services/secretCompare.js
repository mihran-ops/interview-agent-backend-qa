'use strict';

// Constant-time comparison for shared secrets presented in request headers.
//
// The comparison is done over SHA-256 digests rather than the raw values, so the inputs
// handed to timingSafeEqual are always the same length and the length of the presented
// secret is not itself revealed by an early return. An empty expected or provided value
// always fails: an unconfigured secret must never match.

const crypto = require('crypto');

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function secretsMatch(provided, expected) {
  const providedText = String(provided ?? '');
  const expectedText = String(expected ?? '');
  if (!providedText || !expectedText) return false;
  return crypto.timingSafeEqual(digest(providedText), digest(expectedText));
}

module.exports = { secretsMatch };
