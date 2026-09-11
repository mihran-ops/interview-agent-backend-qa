'use strict';

const crypto = require('crypto');
const { cleanLower, cleanText, validateClientEntityImportRows } = require('./clientEntityImport');

function generateTemporaryPassword() {
  return `${crypto.randomBytes(24).toString('base64url')}Aa1!`;
}

function isDuplicateMembershipError(error) {
  return error?.code === '23505' || error?.code === 'PGRST116';
}

function isAlreadyExistsAuthError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('already') || message.includes('exists') || error?.status === 422;
}

function formatImportedMember(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    client_id: row.client_id || null,
    user_id: row.user_id || null,
    email: row.email || null,
    name: row.name || null,
    role: row.role || null,
    created_at: row.created_at || null,
    id: row.user_id || row.email || null,
  };
}

async function findAuthUserByEmail(authAdmin, email) {
  if (!authAdmin || typeof authAdmin.listUsers !== 'function') {
    const err = new Error('Supabase auth admin listUsers is not available.');
    err.code = 'AUTH_ADMIN_UNAVAILABLE';
    throw err;
  }

  const normalizedEmail = cleanLower(email);
  const { data, error } = await authAdmin.listUsers({ email: normalizedEmail });
  if (error) throw error;
  return (data?.users || []).find((user) => cleanLower(user?.email) === normalizedEmail) || null;
}

async function ensureImportAuthUser({ authAdmin, email, name }) {
  const normalizedEmail = cleanLower(email);
  const existing = await findAuthUserByEmail(authAdmin, normalizedEmail);
  if (existing?.id) {
    return {
      user_id: existing.id,
      auth_user_created: false,
      temporary_password: null,
      force_reset_supported: false,
      force_reset_metadata_set: false,
      emails_sent: 0,
    };
  }

  if (!authAdmin || typeof authAdmin.createUser !== 'function') {
    const err = new Error('Supabase auth admin createUser is not available.');
    err.code = 'AUTH_ADMIN_UNAVAILABLE';
    throw err;
  }

  const temporaryPassword = generateTemporaryPassword();
  try {
    const created = await authAdmin.createUser({
      email: normalizedEmail,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: {
        name: cleanText(name),
        full_name: cleanText(name),
        alphascreen_imported_member: true,
        password_reset_required: true,
        force_password_reset_requested: true,
      },
    });
    const userId = created?.data?.user?.id || null;
    if (!userId) {
      const err = new Error('Auth user was created without a returned user id.');
      err.code = 'AUTH_USER_ID_MISSING';
      throw err;
    }
    return {
      user_id: userId,
      auth_user_created: true,
      temporary_password: temporaryPassword,
      force_reset_supported: false,
      force_reset_metadata_set: true,
      emails_sent: 0,
    };
  } catch (error) {
    if (!isAlreadyExistsAuthError(error)) throw error;
    const racedExisting = await findAuthUserByEmail(authAdmin, normalizedEmail);
    if (racedExisting?.id) {
      return {
        user_id: racedExisting.id,
        auth_user_created: false,
        temporary_password: null,
        force_reset_supported: false,
        force_reset_metadata_set: false,
        emails_sent: 0,
      };
    }
    throw error;
  }
}

async function findDirectMemberByEmail({ db, clientId, email }) {
  const { data, error } = await db
    .from('client_members')
    .select('client_id,user_id,email,name,role,created_at')
    .eq('client_id', clientId)
    .eq('email', cleanLower(email))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findDirectMemberByUserId({ db, clientId, userId }) {
  if (!userId) return null;
  const { data, error } = await db
    .from('client_members')
    .select('client_id,user_id,email,name,role,created_at')
    .eq('client_id', clientId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function assignImportedEntityMember({ db, authAdmin, clientId, email, name, role }) {
  const normalizedEmail = cleanLower(email);
  const normalizedName = cleanText(name);
  const normalizedRole = cleanLower(role).replace(/[\s-]+/g, '_');

  const existingByEmail = await findDirectMemberByEmail({ db, clientId, email: normalizedEmail });
  if (existingByEmail) {
    return {
      status: 'skipped',
      code: 'MEMBER_ALREADY_ASSIGNED',
      detail: 'A direct member row for this email already exists on the imported entity.',
      item: formatImportedMember(existingByEmail),
      auth_user_created: false,
      temporary_password: null,
      force_reset_supported: false,
      force_reset_metadata_set: false,
      emails_sent: 0,
    };
  }

  const ensured = await ensureImportAuthUser({
    authAdmin,
    email: normalizedEmail,
    name: normalizedName,
  });

  const existingByUserId = await findDirectMemberByUserId({
    db,
    clientId,
    userId: ensured.user_id,
  });
  if (existingByUserId) {
    return {
      status: 'skipped',
      code: 'MEMBER_ALREADY_ASSIGNED',
      detail: 'A direct member row for this auth user already exists on the imported entity.',
      item: formatImportedMember(existingByUserId),
      auth_user_created: ensured.auth_user_created,
      temporary_password: ensured.temporary_password,
      temporary_password_sensitive: Boolean(ensured.temporary_password),
      force_reset_supported: ensured.force_reset_supported,
      force_reset_metadata_set: ensured.force_reset_metadata_set,
      emails_sent: 0,
    };
  }

  const payload = {
    client_id: clientId,
    email: normalizedEmail,
    name: normalizedName,
    role: normalizedRole,
    user_id: ensured.user_id,
  };
  const { data, error } = await db
    .from('client_members')
    .insert(payload)
    .select('client_id,user_id,email,name,role,created_at')
    .single();

  if (error) {
    if (isDuplicateMembershipError(error)) {
      return {
        status: 'skipped',
        code: 'MEMBER_ALREADY_ASSIGNED',
        detail: 'A direct member row already exists on the imported entity.',
        item: null,
        auth_user_created: ensured.auth_user_created,
        temporary_password: ensured.temporary_password,
        temporary_password_sensitive: Boolean(ensured.temporary_password),
        force_reset_supported: ensured.force_reset_supported,
        force_reset_metadata_set: ensured.force_reset_metadata_set,
        emails_sent: 0,
      };
    }
    throw error;
  }

  return {
    status: 'created',
    code: 'MEMBER_ASSIGNED',
    detail: 'Imported user was assigned directly to the created entity. No automatic email was sent.',
    item: formatImportedMember(data),
    auth_user_created: ensured.auth_user_created,
    temporary_password: ensured.temporary_password,
    temporary_password_sensitive: Boolean(ensured.temporary_password),
    force_reset_supported: ensured.force_reset_supported,
    force_reset_metadata_set: ensured.force_reset_metadata_set,
    emails_sent: 0,
  };
}

function hasCompleteMemberFields(row) {
  return Boolean(row?.location_user_name && row?.location_user_email && row?.member_role);
}

function redactAssignmentForRowResult(assignment) {
  if (!assignment) return null;
  const safeAssignment = { ...assignment };
  if (safeAssignment.temporary_password) {
    delete safeAssignment.temporary_password;
    safeAssignment.temporary_password_available = true;
  }
  return safeAssignment;
}

function defaultFormatEntity(client) {
  const parentClientId = cleanText(client?.parent_client_id) || null;
  return {
    id: client?.id || null,
    name: client?.name || null,
    parent_client_id: parentClientId,
    entity_label: cleanText(client?.entity_label) || null,
    billing_client_id: parentClientId || client?.id || null,
    is_parent_client: !parentClientId,
    is_child_client: Boolean(parentClientId),
  };
}

async function processClientEntityImport({
  db,
  authAdmin,
  parent,
  rawRows,
  existingChildren = [],
  formatEntity = defaultFormatEntity,
}) {
  const validatedRows = validateClientEntityImportRows(rawRows, {
    existingNames: (existingChildren || []).map((item) => item?.name),
  });

  const results = [];
  const temporaryCredentials = [];
  const counts = {
    total: validatedRows.length,
    valid: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    members_created: 0,
    members_skipped: 0,
    member_assignment_failed: 0,
    auth_users_created: 0,
    temporary_passwords_generated: 0,
    emails_sent: 0,
  };

  for (const row of validatedRows) {
    if (row.errors.length > 0) {
      counts.failed += 1;
      results.push({
        ...row,
        status: 'failed',
        assignment: null,
      });
      continue;
    }

    counts.valid += 1;

    if (row.skip_reason === 'duplicate_existing_entity') {
      counts.skipped += 1;
      results.push({
        ...row,
        status: 'skipped',
        detail: 'An entity with this name already exists under the selected parent client.',
        assignment: null,
      });
      continue;
    }

    const { data: created, error: createError } = await db
      .from('clients')
      .insert({
        name: row.name,
        email: parent.email,
        parent_client_id: parent.id,
        entity_label: row.location_type || parent.entity_label || null,
        candidate_assistance_contact: parent.candidate_assistance_contact || null,
      })
      .select('id,name,parent_client_id,entity_label')
      .single();

    if (createError) {
      counts.failed += 1;
      results.push({
        ...row,
        status: 'failed',
        errors: [createError.message || 'Entity could not be created.'],
        code: createError.code || 'CREATE_CLIENT_ENTITY_FAILED',
        hint: createError.hint || null,
        assignment: null,
      });
      continue;
    }

    counts.created += 1;
    let assignment = null;

    if (hasCompleteMemberFields(row)) {
      try {
        assignment = await assignImportedEntityMember({
          db,
          authAdmin,
          clientId: created.id,
          email: row.location_user_email,
          name: row.location_user_name,
          role: row.member_role,
        });

        if (assignment.status === 'created') counts.members_created += 1;
        if (assignment.status === 'skipped') counts.members_skipped += 1;
        if (assignment.auth_user_created) counts.auth_users_created += 1;
        if (assignment.temporary_password) {
          counts.temporary_passwords_generated += 1;
          temporaryCredentials.push({
            row_number: row.row_number,
            entity_id: created.id,
            entity_name: row.name,
            name: row.location_user_name,
            email: row.location_user_email,
            role: row.member_role,
            temporary_password: assignment.temporary_password,
            sensitive: true,
            force_reset_supported: assignment.force_reset_supported === true,
            force_reset_metadata_set: assignment.force_reset_metadata_set === true,
          });
        }
      } catch (assignmentError) {
        counts.member_assignment_failed += 1;
        assignment = {
          status: 'failed',
          code: assignmentError?.code || 'MEMBER_ASSIGNMENT_FAILED',
          detail: assignmentError?.message || 'Imported member could not be assigned to the created entity.',
          emails_sent: 0,
        };
      }
    }

    results.push({
      ...row,
      status: 'created',
      item: formatEntity(created),
      assignment: redactAssignmentForRowResult(assignment),
    });
  }

  return {
    counts,
    results,
    temporary_credentials: temporaryCredentials,
    created: results.filter((row) => row.status === 'created').map((row) => row.item).filter(Boolean),
  };
}

module.exports = {
  assignImportedEntityMember,
  ensureImportAuthUser,
  generateTemporaryPassword,
  processClientEntityImport,
};
