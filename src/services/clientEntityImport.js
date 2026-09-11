'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanLower(value) {
  return cleanText(value).toLowerCase();
}

function readField(row, keys) {
  if (!row || typeof row !== 'object') return '';
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return '';
}

function normalizeImportRole(value) {
  const normalized = cleanLower(value).replace(/[\s-]+/g, '_');
  if (!normalized) return '';
  if (normalized === 'manager') return 'manager';
  if (normalized === 'member') return 'member';
  return normalized;
}

function isEmptyImportRow(row) {
  if (!row || typeof row !== 'object') return true;
  return [
    readField(row, ['name', 'Name']),
    readField(row, ['location_type', 'Location type', 'Location Type']),
    readField(row, ['location_user_name', 'Location user name', 'Location User Name']),
    readField(row, ['location_user_email', 'Location user email', 'Location User Email']),
    readField(row, ['member_role', 'Manager/Member designation', 'Manager/Member Designation']),
  ].every((value) => !cleanText(value));
}

function normalizeImportRow(row, index) {
  const name = cleanText(readField(row, ['name', 'Name']));
  const locationType = cleanLower(readField(row, ['location_type', 'Location type', 'Location Type']));
  const locationUserName = cleanText(readField(row, ['location_user_name', 'Location user name', 'Location User Name']));
  const locationUserEmail = cleanLower(readField(row, ['location_user_email', 'Location user email', 'Location User Email']));
  const memberRole = normalizeImportRole(readField(row, ['member_role', 'Manager/Member designation', 'Manager/Member Designation']));
  const suppliedRowNumber = Number(readField(row, ['row_number', 'rowNumber', 'Row']));

  return {
    row_number: Number.isFinite(suppliedRowNumber) && suppliedRowNumber > 0 ? suppliedRowNumber : index + 1,
    name,
    location_type: locationType,
    location_user_name: locationUserName,
    location_user_email: locationUserEmail,
    member_role: memberRole,
    errors: [],
    warnings: [],
    skip_reason: null,
  };
}

function validateClientEntityImportRows(rows, options = {}) {
  const existingNames = new Set((options.existingNames || []).map(cleanLower).filter(Boolean));
  const normalizedRows = [];

  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    if (isEmptyImportRow(row)) continue;
    normalizedRows.push(normalizeImportRow(row, index));
  }

  const nameCounts = new Map();
  for (const row of normalizedRows) {
    const key = cleanLower(row.name);
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

  for (const row of normalizedRows) {
    const nameKey = cleanLower(row.name);
    const hasMemberName = Boolean(row.location_user_name);
    const hasMemberEmail = Boolean(row.location_user_email);
    const hasMemberRole = Boolean(row.member_role);
    if (!row.name) row.errors.push('Name is required.');
    if (nameKey && nameCounts.get(nameKey) > 1) row.errors.push('Duplicate entity name in this CSV.');
    if (nameKey && existingNames.has(nameKey)) row.skip_reason = 'duplicate_existing_entity';
    if (row.location_user_email && !EMAIL_RE.test(row.location_user_email)) {
      row.errors.push('Location user email must be a valid email address.');
    }
    if (row.member_role && !['manager', 'member'].includes(row.member_role)) {
      row.errors.push('Manager/Member designation must be blank, Manager, or Member.');
    }
    if ((hasMemberEmail || hasMemberRole) && !hasMemberName) {
      row.errors.push('Location user name is required when Location user email or Manager/Member designation is supplied.');
    }
    if ((hasMemberName || hasMemberRole) && !hasMemberEmail) {
      row.errors.push('Location user email is required when Location user name or Manager/Member designation is supplied.');
    }
    if ((hasMemberName || hasMemberEmail) && !hasMemberRole) {
      row.errors.push('Manager/Member designation is required when Location user name or Location user email is supplied.');
    }
    if (hasMemberName || hasMemberEmail || hasMemberRole) {
      row.warnings.push('No automatic emails will be sent for imported member assignments.');
    }
  }

  return normalizedRows;
}

module.exports = {
  cleanText,
  cleanLower,
  normalizeImportRole,
  validateClientEntityImportRows,
};
