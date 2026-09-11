'use strict';

const { DENTAL_PRONUNCIATION_SEED } = require('../data/pronunciation/dentalSeed');
const { normalizePronunciationTerm } = require('./pronunciationRegistry');

const ORDINARY_ACRONYMS = new Set(['AND', 'THE', 'WITH']);
const DENTAL_DISCOVERY_FORMS = Object.freeze({
  endodontics: ['endodontic'],
  orthodontics: ['orthodontic'],
  periodontics: ['periodontic'],
  prosthodontics: ['prosthodontic'],
});

function containsBoundedTerm(text, value) {
  const escaped = normalizePronunciationTerm(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function sourceDocuments(input = {}) {
  return [
    ['role_title', input.roleTitle],
    ['job_description', input.jobDescription],
    ['rubric', Array.isArray(input.rubricQuestions) ? input.rubricQuestions.join(' ') : input.rubricQuestions],
    ['approved_client_terminology', Array.isArray(input.approvedClientTerminology) ? input.approvedClientTerminology.join(' ') : input.approvedClientTerminology],
  ].filter(([, value]) => typeof value === 'string' && value.trim());
}

function discoverPronunciationCandidates(input = {}, options = {}) {
  const known = new Set((options.knownTerms || []).map((term) => normalizePronunciationTerm(term.normalized_term || term.canonical_term || term)));
  const industryTerms = options.industryKey === 'dental' || input.industryKey === 'dental' ? DENTAL_PRONUNCIATION_SEED : [];
  const results = new Map();
  for (const [sourceContext, rawText] of sourceDocuments(input)) {
    const normalizedText = normalizePronunciationTerm(rawText);
    for (const term of industryTerms) {
      if (term.discovery_requires_approved_terminology && sourceContext !== 'approved_client_terminology') continue;
      const forms = [term.normalized_term, ...(DENTAL_DISCOVERY_FORMS[term.normalized_term] || [])];
      if (!forms.some((form) => containsBoundedTerm(normalizedText, form)) || known.has(term.normalized_term)) continue;
      results.set(term.normalized_term, {
        term: term.canonical_term,
        normalized_term: term.normalized_term,
        source_context: sourceContext,
        reason: 'known_industry_technical_term',
        suggested_scope: 'industry',
        industry_key: 'dental',
        suggested_pronunciation: term.verification_status === 'verified' ? term.pronunciation_value : null,
        confidence: term.verification_status === 'verified' ? 'high' : 'medium',
        source: 'role_discovery',
        verification_status: 'suggested',
        auto_publish: false,
      });
    }
    for (const match of rawText.matchAll(/\b[A-Z]{2,}(?:\/[A-Z]{2,})?\b/g)) {
      const term = match[0];
      const normalized = normalizePronunciationTerm(term);
      if (ORDINARY_ACRONYMS.has(term) || known.has(normalized) || results.has(normalized)) continue;
      results.set(normalized, {
        term,
        normalized_term: normalized,
        source_context: sourceContext,
        reason: 'acronym_requires_explicit_reading',
        suggested_scope: input.clientId ? 'client' : (input.industryKey ? 'industry' : 'global'),
        industry_key: input.industryKey || null,
        client_id: input.clientId || null,
        suggested_pronunciation: null,
        confidence: 'unverified',
        source: 'role_discovery',
        verification_status: 'suggested',
        auto_publish: false,
      });
    }
  }
  return [...results.values()].sort((a, b) => a.normalized_term.localeCompare(b.normalized_term));
}

module.exports = { containsBoundedTerm, discoverPronunciationCandidates };
