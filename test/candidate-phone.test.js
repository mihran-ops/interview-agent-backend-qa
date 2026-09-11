'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  normalizeCandidatePhoneCountry,
  normalizeCandidatePhone,
  normalizeCandidatePhoneIdentity,
  normalizeCandidatePhoneE164,
  isValidCandidatePhone,
  getCandidatePhoneValidationMessage
} = require('../src/services/candidatePhone');

test('candidate phone validation accepts supported US formats', () => {
  for (const value of [
    '(555) 123-4567',
    '555-123-4567',
    '5551234567',
    '+1 555 123 4567',
    '+15551234567'
  ]) {
    assert.equal(normalizeCandidatePhone(value, 'US'), '5551234567', value);
  }
});

test('candidate phone validation rejects invalid US formats', () => {
  for (const value of ['0917 123 4567', 'abc123', '555-12']) {
    assert.equal(isValidCandidatePhone(value, 'US'), false, value);
  }
  assert.equal(getCandidatePhoneValidationMessage('US'), 'Enter a valid US phone number.');
});

test('candidate phone validation accepts supported Philippine formats without losing country code', () => {
  for (const value of [
    '+63 917 123 4567',
    '+639171234567',
    '0917 123 4567',
    '09171234567',
    '9171234567'
  ]) {
    assert.equal(normalizeCandidatePhone(value, 'PH'), '639171234567', value);
  }
});

test('candidate phone validation rejects invalid Philippine formats', () => {
  for (const value of ['555-123-4567', 'abc123', '91712']) {
    assert.equal(isValidCandidatePhone(value, 'PH'), false, value);
  }
  assert.equal(getCandidatePhoneValidationMessage('PH'), 'Enter a valid Philippine phone number.');
});

test('candidate phone country defaults to United States when missing or unsupported', () => {
  assert.equal(normalizeCandidatePhoneCountry(), 'US');
  assert.equal(normalizeCandidatePhoneCountry('CA'), 'US');
  assert.equal(normalizeCandidatePhone('555-123-4567'), '5551234567');
});

test('candidate phone identity preserves legacy storage while adding canonical US E.164 and country provenance', () => {
  assert.deepEqual(normalizeCandidatePhoneIdentity('(555) 123-4567', 'US'), {
    phone: '5551234567',
    phone_e164: '+15551234567',
    phone_country_code: 'US',
  });
  assert.equal(normalizeCandidatePhoneE164('+1 555 123 4567', 'US'), '+15551234567');
});

test('candidate phone identity canonicalizes accepted Philippine input without making it SMS eligible', () => {
  assert.deepEqual(normalizeCandidatePhoneIdentity('0917 123 4567', 'PH'), {
    phone: '639171234567',
    phone_e164: '+639171234567',
    phone_country_code: 'PH',
  });
});

test('candidate phone identity rejects malformed values rather than manufacturing E.164', () => {
  assert.equal(normalizeCandidatePhoneIdentity('555-12', 'US'), null);
  assert.equal(normalizeCandidatePhoneIdentity('abc123', 'PH'), null);
});
