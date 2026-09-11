'use strict';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isPrimitiveString(value) {
  return typeof value === 'string';
}

function normalizePrimitiveString(value, {
  required = true,
  trim = true,
  lowercase = false,
  maxCodePoints = 500,
  maxBytes = 2000,
  allowEmpty = false,
} = {}) {
  if (value === undefined) return required ? null : undefined;
  if (value === null || !isPrimitiveString(value)) return null;
  if (UNSAFE_CONTROL_PATTERN.test(value)) return null;
  let normalized = trim ? value.trim() : value;
  if (lowercase) normalized = normalized.toLowerCase();
  if (!allowEmpty && !normalized) return required ? null : undefined;
  if ([...normalized].length > maxCodePoints || Buffer.byteLength(normalized, 'utf8') > maxBytes) return null;
  return normalized;
}

function normalizeUuid(value, { required = true } = {}) {
  const normalized = normalizePrimitiveString(value, {
    required,
    maxCodePoints: 36,
    maxBytes: 36,
  });
  if (normalized === undefined) return undefined;
  return normalized && UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeEnum(value, allowed, {
  required = true,
  maxCodePoints = 80,
  maxBytes = 320,
} = {}) {
  const normalized = normalizePrimitiveString(value, {
    required,
    lowercase: true,
    maxCodePoints,
    maxBytes,
  });
  if (normalized === undefined) return undefined;
  return normalized && allowed.has(normalized) ? normalized : null;
}

function isUuid(value) {
  return normalizeUuid(value) !== null;
}

module.exports = {
  UUID_PATTERN,
  UNSAFE_CONTROL_PATTERN,
  isPrimitiveString,
  isUuid,
  normalizeEnum,
  normalizePrimitiveString,
  normalizeUuid,
};
