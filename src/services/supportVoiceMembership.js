const COLUMN_ABSENT = '42703';

function classifyCountResult(result) {
  if (!result || typeof result !== 'object') return { kind: 'fail' };
  if (result.error) {
    return result.error.code === COLUMN_ABSENT ? { kind: 'column_absent' } : { kind: 'fail' };
  }
  if (result.data !== null) return { kind: 'fail' };
  if (!Number.isInteger(result.count) || result.count < 0) return { kind: 'fail' };
  return { kind: 'present', count: result.count };
}

async function countMembership(serviceDb, column, userId) {
  return serviceDb
    .from('client_members')
    .select('clients!inner(id)', { count: 'exact', head: true })
    .eq(column, userId)
    .is('clients.archived_at', null);
}

async function hasAnyActiveClientMembership({ serviceDb, userId }) {
  if (!serviceDb || typeof serviceDb.from !== 'function') throw new Error('SUPPORT_VOICE_SERVICE_DB_REQUIRED');
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('SUPPORT_VOICE_USER_ID_REQUIRED');

  let modernRaw;
  let legacyRaw;
  try {
    modernRaw = await countMembership(serviceDb, 'user_id_uuid', userId);
    legacyRaw = await countMembership(serviceDb, 'user_id', userId);
    const modern = classifyCountResult(modernRaw);
    const legacy = classifyCountResult(legacyRaw);
    modernRaw = undefined;
    legacyRaw = undefined;

    if (modern.kind === 'fail' || legacy.kind === 'fail') return false;
    if (modern.kind === 'column_absent' && legacy.kind === 'column_absent') return false;
    const modernCount = modern.kind === 'present' ? modern.count : 0;
    const legacyCount = legacy.kind === 'present' ? legacy.count : 0;
    return modernCount > 0 || legacyCount > 0;
  } catch (_error) {
    modernRaw = undefined;
    legacyRaw = undefined;
    return false;
  }
}

module.exports = {
  COLUMN_ABSENT,
  classifyCountResult,
  hasAnyActiveClientMembership,
};
