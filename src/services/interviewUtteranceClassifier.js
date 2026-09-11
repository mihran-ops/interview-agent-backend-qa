'use strict';

const { excludeWarmupFromTranscript } = require('./warmupExclusion');

// Deliberately deterministic.  This is an access-control gate, not a model
// judgement: only a candidate answer with concrete answer-shaped content can
// make an attempt eligible for downstream scoring.
const NON_SUBSTANTIVE_PATTERNS = [
  [/^(?:yes|no|ok(?:ay)?|sure|thanks?|thank you|hello|hi|got it|sounds good|maybe|pass|skip|n\/?a|none)[.!?\s]*$/i, 'acknowledgment'],
  [/^(?:can you|could you|would you|please)?\s*(?:repeat|say that again|ask that again|rephrase|clarify)(?:\s+please)?[!?\s]*$/i, 'repeat_request'],
  [/(?:can'?t|cannot|couldn'?t)\s+(?:hear|understand)|(?:audio|sound|mic|microphone|connection)\s+(?:is|was|seems)?\s*(?:bad|cutting|broken|out)?/i, 'hearing_or_audio_issue'],
  [/^(?:what|which|how)\s+(?:did|do)\s+you\s+(?:ask|mean|say)[?!.\s]*$/i, 'clarification_request'],
  [/^(?:um+|uh+|erm+|hmm+|well+|like)[,.!\s]*$/i, 'filler'],
];

const ANSWER_SIGNALS = /\b(?:i\s+(?:led|built|designed|implemented|managed|owned|created|improved|reduced|increased|worked|used|learned|delivered|solved|was|am|have|had)|my\s+(?:role|team|experience|approach)|because|for example|for instance|when i|in my|the result|we\s+(?:built|delivered|improved|reduced)|python|javascript|typescript|sql|aws|react|postgres|customer|project|migration|system|incident)\b/i;
const QUESTION_ONLY = /\?\s*$/;

function normalizeUtterance(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`\-–—\s]+|["'`\-–—\s]+$/g, '')
    .trim();
}

function wordCount(value) {
  return normalizeUtterance(value).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length || 0;
}

function classifyCandidateUtterance(value) {
  const text = normalizeUtterance(value);
  const words = wordCount(text);
  if (!text) return { classification: 'silence_or_empty', substantive: false, wordCount: 0, text: '' };

  for (const [pattern, classification] of NON_SUBSTANTIVE_PATTERNS) {
    if (pattern.test(text)) return { classification, substantive: false, wordCount: words, text };
  }
  // A short question or request for clarification is never evidence of an
  // answer, even when it happens to contain several words.
  if (QUESTION_ONLY.test(text) && words <= 18) {
    return { classification: 'clarification_request', substantive: false, wordCount: words, text };
  }
  if (words < 5) return { classification: 'unknown_non_substantive', substantive: false, wordCount: words, text };

  // A compact but legitimate technical answer ("I used Python to automate
  // reporting") has a concrete answer signal. Longer passages must still be
  // answer-shaped; word count alone is intentionally insufficient.
  if (ANSWER_SIGNALS.test(text) && (!QUESTION_ONLY.test(text) || words > 18)) {
    return { classification: 'substantive_answer', substantive: true, wordCount: words, text };
  }
  return { classification: 'unknown_non_substantive', substantive: false, wordCount: words, text };
}

function transcriptCandidateUtterances(transcript) {
  const text = String(transcript || '');
  const labelled = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:CANDIDATE|USER)\s*:/i.test(line))
    .map((line) => line.replace(/^(?:CANDIDATE|USER)\s*:/i, '').trim());
  return labelled;
}

function classifyTranscriptCandidateEvidence(transcript) {
  const evaluativeTranscript = excludeWarmupFromTranscript(transcript);
  const utterances = transcriptCandidateUtterances(evaluativeTranscript).map(classifyCandidateUtterance);
  const counts = {};
  for (const item of utterances) counts[item.classification] = (counts[item.classification] || 0) + 1;
  const substantive = utterances.filter((item) => item.substantive);
  if (!utterances.length) {
    return { ok: false, reason: 'no_candidate_response', utterances, counts, candidateUtteranceCount: 0, substantiveResponseCount: 0 };
  }
  if (!substantive.length) {
    return { ok: false, reason: 'no_substantive_candidate_response', utterances, counts, candidateUtteranceCount: utterances.length, substantiveResponseCount: 0 };
  }
  return { ok: true, reason: null, utterances, counts, candidateUtteranceCount: utterances.length, substantiveResponseCount: substantive.length };
}

module.exports = {
  normalizeUtterance,
  wordCount,
  classifyCandidateUtterance,
  transcriptCandidateUtterances,
  classifyTranscriptCandidateEvidence,
};
