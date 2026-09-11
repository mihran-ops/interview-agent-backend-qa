function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeName(value) {
  return String(value || '').trim();
}

async function checkDuplicateCandidate({
  supabase,
  roleId,
  email,
  fullName,
  phone,
  excludeCandidateId = null,
  allowPhoneEnrich = true,
}) {
  if (!supabase || !roleId) {
    return {
      duplicate: false,
      reason: null,
      candidateId: null,
      email: normalizeEmail(email),
      phone: normalizePhone(phone),
      name: normalizeName(fullName),
    };
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const nameForMatch = normalizeName(fullName);

  if (normalizedEmail) {
    const { data } = await supabase
      .from('candidates')
      .select('id, phone')
      .eq('role_id', roleId)
      .eq('email', normalizedEmail)
      .limit(1)
      .maybeSingle();

    if (data && data.id && data.id !== excludeCandidateId) {
      if (allowPhoneEnrich && normalizedPhone && !data.phone) {
        await supabase.from('candidates').update({ phone: normalizedPhone }).eq('id', data.id);
      }
      return {
        duplicate: true,
        reason: 'email',
        candidateId: data.id,
        email: normalizedEmail,
        phone: normalizedPhone,
        name: nameForMatch,
      };
    }
  }

  if (nameForMatch && normalizedPhone) {
    const { data } = await supabase
      .from('candidates')
      .select('id, phone')
      .eq('role_id', roleId)
      .eq('phone', normalizedPhone)
      .ilike('name', nameForMatch)
      .limit(1)
      .maybeSingle();

    if (data && data.id && data.id !== excludeCandidateId) {
      if (allowPhoneEnrich && normalizedPhone && !data.phone) {
        await supabase.from('candidates').update({ phone: normalizedPhone }).eq('id', data.id);
      }
      return {
        duplicate: true,
        reason: 'name_phone',
        candidateId: data.id,
        email: normalizedEmail,
        phone: normalizedPhone,
        name: nameForMatch,
      };
    }
  }

  return {
    duplicate: false,
    reason: null,
    candidateId: null,
    email: normalizedEmail,
    phone: normalizedPhone,
    name: nameForMatch,
  };
}

module.exports = {
  checkDuplicateCandidate,
  normalizeEmail,
  normalizePhone,
  normalizeName,
};
