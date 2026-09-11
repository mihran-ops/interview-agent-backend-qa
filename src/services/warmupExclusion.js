'use strict';

const WARMUP_QUESTION = 'What’s your favorite season, and what do you like about it?';
const WARMUP_TRANSITION = 'Thanks for sharing. Let’s begin.';
const INTRODUCTION_BODY = 'Speaking with an AI can feel a little different at first, so take a breath, relax, and speak naturally. Before we begin the screening, let’s warm up with something simple.';

const WARMUP_QUESTION_PATTERN = /what(?:[’']s| is) your favorite season,?\s+and what do you like about it[?.!]?/i;
const WARMUP_TRANSITION_PATTERN = /thanks for sharing[.!?]?\s*(?:[-–—]\s*)?let(?:[’']?s| us) begin[.!?]?/i;
const SPEAKER_LINE_PATTERN = /^\s*(CANDIDATE|USER|INTERVIEWER|ASSISTANT|AGENT|REPLICA)\s*:\s*/i;

function stripTransitionAndKeepRemainder(line) {
  const match = WARMUP_TRANSITION_PATTERN.exec(line);
  if (!match) return '';
  const prefix = line.slice(0, match.index);
  const remainder = line.slice(match.index + match[0].length).trim();
  if (!remainder) return '';
  const speaker = SPEAKER_LINE_PATTERN.exec(prefix)?.[1];
  return speaker ? `${speaker.toUpperCase()}: ${remainder}` : remainder;
}

function prepareEvaluativeTranscript(value) {
  const raw = String(value || '');
  if (!raw || !WARMUP_QUESTION_PATTERN.test(raw)) {
    return { transcript: raw.trim(), warmup_detected: false, warmup_excluded: false };
  }

  // Unlabelled transcripts can still be safely bounded when the exact neutral
  // transition is present: everything through that transition is non-evaluative.
  if (!raw.includes('\n')) {
    const transition = WARMUP_TRANSITION_PATTERN.exec(raw);
    return {
      transcript: transition ? raw.slice(transition.index + transition[0].length).trim() : '',
      warmup_detected: true,
      warmup_excluded: true,
    };
  }

  const kept = [];
  let state = 'before_warmup';
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trimEnd();
    if (state === 'before_warmup') {
      if (WARMUP_QUESTION_PATTERN.test(line)) {
        state = 'awaiting_warmup_response';
      }
      continue;
    }

    if (state === 'awaiting_warmup_response') {
      if (/^\s*(CANDIDATE|USER)\s*:/i.test(line)) {
        state = 'awaiting_transition';
        continue;
      }
      if (WARMUP_TRANSITION_PATTERN.test(line)) {
        const remainder = stripTransitionAndKeepRemainder(line);
        if (remainder) kept.push(remainder);
        state = 'scored_interview';
      }
      continue;
    }

    if (state === 'awaiting_transition') {
      if (WARMUP_TRANSITION_PATTERN.test(line)) {
        const remainder = stripTransitionAndKeepRemainder(line);
        if (remainder) kept.push(remainder);
        state = 'scored_interview';
        continue;
      }
      if (/^\s*(CANDIDATE|USER)\s*:/i.test(line) || !line.trim()) continue;
      // Fail closed if the provider omitted the neutral transition: the first
      // subsequent interviewer turn is the beginning of scored interviewing.
      if (/^\s*(INTERVIEWER|ASSISTANT|AGENT|REPLICA)\s*:/i.test(line)) {
        kept.push(line);
        state = 'scored_interview';
      }
      continue;
    }

    kept.push(line);
  }

  return {
    transcript: kept.join('\n').trim(),
    warmup_detected: true,
    warmup_excluded: true,
  };
}

function excludeWarmupFromTranscript(value) {
  return prepareEvaluativeTranscript(value).transcript;
}

function transcriptItemText(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { field: null, text: '' };
  for (const field of ['content', 'text', 'message', 'value']) {
    if (typeof item[field] === 'string') return { field, text: item[field] };
  }
  return { field: null, text: '' };
}

function isCandidateTranscriptItem(item) {
  return /^(candidate|user)$/i.test(String(item?.role || '').trim());
}

function isInterviewerTranscriptItem(item) {
  return /^(agent|assistant|interviewer|replica)$/i.test(String(item?.role || '').trim());
}

function excludeWarmupFromTranscriptItems(items) {
  if (!Array.isArray(items)) return [];
  const warmupIndex = items.findIndex((item) => WARMUP_QUESTION_PATTERN.test(transcriptItemText(item).text));
  if (warmupIndex < 0) return items.slice();

  let sawCandidateResponse = false;
  for (let index = warmupIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    const { field, text } = transcriptItemText(item);
    if (isCandidateTranscriptItem(item)) sawCandidateResponse = true;
    const transition = WARMUP_TRANSITION_PATTERN.exec(text);
    if (transition) {
      const remainder = text.slice(transition.index + transition[0].length).trim();
      const suffix = remainder && field ? [{ ...item, [field]: remainder }] : [];
      return suffix.concat(items.slice(index + 1));
    }
    if (sawCandidateResponse && isInterviewerTranscriptItem(item)) {
      return items.slice(index);
    }
  }
  return [];
}

module.exports = {
  INTRODUCTION_BODY,
  WARMUP_QUESTION,
  WARMUP_TRANSITION,
  excludeWarmupFromTranscript,
  excludeWarmupFromTranscriptItems,
  prepareEvaluativeTranscript,
};
