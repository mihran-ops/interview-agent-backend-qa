'use strict';

const SUPPORTED_CANDIDATE_PHONE_COUNTRIES = new Set(['US', 'PH']);
const PHONE_ALLOWED_CHARS_RE = /^[+\d\s().-]+$/;

function normalizeCandidatePhoneCountry(value = '') {
  const country = String(value || '').trim().toUpperCase();
  return SUPPORTED_CANDIDATE_PHONE_COUNTRIES.has(country) ? country : 'US';
}

function digitsOnly(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function hasValidPlusPlacement(value = '') {
  const trimmed = String(value || '').trim();
  const plusCount = (trimmed.match(/\+/g) || []).length;
  return plusCount <= 1 && (!trimmed.includes('+') || trimmed.startsWith('+'));
}

function normalizeCandidatePhone(value = '', countryInput = 'US') {
  const country = normalizeCandidatePhoneCountry(countryInput);
  const trimmed = String(value || '').trim();
  if (!trimmed || !PHONE_ALLOWED_CHARS_RE.test(trimmed) || !hasValidPlusPlacement(trimmed)) {
    return null;
  }

  const digits = digitsOnly(trimmed);
  if (country === 'PH') {
    let national = '';
    if (digits.length === 12 && digits.startsWith('63')) {
      national = digits.slice(2);
    } else if (digits.length === 11 && digits.startsWith('0')) {
      national = digits.slice(1);
    } else if (digits.length === 10) {
      national = digits;
    }
    return /^9\d{9}$/.test(national) ? `63${national}` : null;
  }

  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return national.length === 10 ? national : null;
}

function normalizeCandidatePhoneIdentity(value = '', countryInput = 'US') {
  const country = normalizeCandidatePhoneCountry(countryInput);
  const phone = normalizeCandidatePhone(value, country);
  if (!phone) return null;
  return Object.freeze({
    phone,
    phone_e164: country === 'PH' ? `+${phone}` : `+1${phone}`,
    phone_country_code: country,
  });
}

function normalizeCandidatePhoneE164(value = '', countryInput = 'US') {
  return normalizeCandidatePhoneIdentity(value, countryInput)?.phone_e164 || null;
}

function isValidCandidatePhone(value = '', countryInput = 'US') {
  return normalizeCandidatePhone(value, countryInput) !== null;
}

function getCandidatePhoneValidationMessage(countryInput = 'US') {
  return normalizeCandidatePhoneCountry(countryInput) === 'PH'
    ? 'Enter a valid Philippine phone number.'
    : 'Enter a valid US phone number.';
}

module.exports = {
  normalizeCandidatePhoneCountry,
  normalizeCandidatePhone,
  normalizeCandidatePhoneIdentity,
  normalizeCandidatePhoneE164,
  isValidCandidatePhone,
  getCandidatePhoneValidationMessage
};
