'use strict';

const crypto = require('node:crypto');

const METHODS = new Set(['alias', 'ipa']);
const SCOPES = new Set(['global', 'industry', 'client']);
const STATUSES = new Set(['suggested', 'verified', 'rejected', 'deprecated']);
const SOURCES = new Set(['manual', 'industry_seed', 'client_admin', 'role_discovery', 'qa_observed_failure', 'ai_suggestion']);
const SCOPE_RANK = Object.freeze({ global: 1, industry: 2, client: 3 });

function normalizePronunciationTerm(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function validatePronunciationTerm(term) {
  if (!term || typeof term !== 'object') throw new Error('pronunciation_term_required');
  const canonicalTerm = String(term.canonical_term || term.canonicalTerm || '').normalize('NFKC').trim();
  const normalizedTerm = normalizePronunciationTerm(term.normalized_term || term.normalizedTerm || canonicalTerm);
  const method = String(term.pronunciation_method || term.pronunciationMethod || '').toLowerCase();
  const pronunciation = String(term.pronunciation_value || term.pronunciationValue || '').normalize('NFKC').trim();
  const scope = String(term.scope_type || term.scopeType || '').toLowerCase();
  const status = String(term.verification_status || term.verificationStatus || '').toLowerCase();
  const source = String(term.source || '').toLowerCase();
  if (!canonicalTerm || canonicalTerm.length > 200) throw new Error('canonical_term_invalid');
  if (!normalizedTerm || normalizedTerm.length > 200) throw new Error('normalized_term_invalid');
  if (normalizedTerm !== normalizePronunciationTerm(canonicalTerm)) throw new Error('normalized_term_mismatch');
  if (!METHODS.has(method)) throw new Error('pronunciation_method_invalid');
  if (!pronunciation || pronunciation.length > 500) throw new Error('pronunciation_value_invalid');
  if (!SCOPES.has(scope)) throw new Error('scope_type_invalid');
  if (!STATUSES.has(status)) throw new Error('verification_status_invalid');
  if (!SOURCES.has(source)) throw new Error('pronunciation_source_invalid');
  const industryKey = term.industry_key || term.industryKey || null;
  const clientId = term.client_id || term.clientId || null;
  if (scope === 'global' && (industryKey || clientId)) throw new Error('global_scope_binding_invalid');
  if (scope === 'industry' && (!industryKey || clientId)) throw new Error('industry_scope_binding_invalid');
  if (industryKey && !/^[a-z][a-z0-9_-]{0,63}$/.test(String(industryKey))) throw new Error('industry_key_invalid');
  if (scope === 'client' && (!clientId || industryKey)) throw new Error('client_scope_binding_invalid');
  return Object.freeze({
    ...term,
    canonical_term: canonicalTerm,
    normalized_term: normalizedTerm,
    pronunciation_method: method,
    pronunciation_value: pronunciation,
    scope_type: scope,
    industry_key: industryKey,
    client_id: clientId,
    source,
    verification_status: status,
    is_active: term.is_active !== false && term.isActive !== false,
    version: Number.isInteger(Number(term.version)) && Number(term.version) > 0 ? Number(term.version) : 1,
  });
}

function isRuntimeEligible(term) {
  const value = validatePronunciationTerm(term);
  return value.is_active && value.verification_status === 'verified';
}

function appliesToContext(term, context) {
  if (term.scope_type === 'global') return true;
  if (term.scope_type === 'industry') return Boolean(context.industryKey) && String(term.industry_key) === String(context.industryKey);
  return Boolean(context.clientId) && String(term.client_id) === String(context.clientId);
}

function compareCandidates(a, b) {
  const scope = SCOPE_RANK[b.scope_type] - SCOPE_RANK[a.scope_type];
  if (scope) return scope;
  const version = b.version - a.version;
  if (version) return version;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function resolvePronunciationTerms(terms, context = {}) {
  const grouped = new Map();
  for (const raw of terms || []) {
    const term = validatePronunciationTerm(raw);
    if (!term.is_active || term.verification_status !== 'verified' || !appliesToContext(term, context)) continue;
    const current = grouped.get(term.normalized_term) || [];
    current.push(term);
    grouped.set(term.normalized_term, current);
  }
  return [...grouped.values()]
    .map((candidates) => candidates.sort(compareCandidates)[0])
    .sort((a, b) => a.normalized_term.localeCompare(b.normalized_term));
}

function compileTavusPronunciationRules(terms) {
  return [...terms]
    .map(validatePronunciationTerm)
    .filter((term) => term.is_active && term.verification_status === 'verified')
    .map((term) => ({
      text: term.canonical_term,
      pronunciation: term.pronunciation_value,
      type: term.pronunciation_method,
      ...(term.pronunciation_method === 'ipa' ? { alphabet: 'ipa' } : {}),
      case_sensitive: Boolean(term.case_sensitive),
      word_boundaries: term.word_boundaries !== false,
    }))
    .sort((a, b) => a.text.localeCompare(b.text));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function nonPronunciationPalConfig(pal) {
  const copy = JSON.parse(JSON.stringify(pal || {}));
  if (copy.layers?.tts) delete copy.layers.tts.pronunciation_dictionary_id;
  for (const key of ['created_at', 'updated_at', 'is_draft_view', 'has_unpublished_changes', 'live_pal_id', 'draft_pal_id', 'published_view_url', 'publish_url', 'routing_message']) delete copy[key];
  return copy;
}

module.exports = {
  METHODS,
  SCOPES,
  SOURCES,
  STATUSES,
  compileTavusPronunciationRules,
  isRuntimeEligible,
  nonPronunciationPalConfig,
  normalizePronunciationTerm,
  resolvePronunciationTerms,
  stableHash,
  validatePronunciationTerm,
};
