'use strict';

const SIMPLE_INTERVIEW_STATES = Object.freeze({
  not_started: 'Not started',
  no_response: 'No response',
  tech_issue: 'Tech issue',
  processing: 'Processing',
  incomplete: 'Incomplete',
  scored: 'Scored',
});

const PROCESSING_INTERVIEW_STATUSES = new Set([
  'created',
  'authorized',
  'starting',
  'started',
  'pending',
  'connected',
  'in_progress',
  'ending_requested',
  'ended',
  'transcribed',
  'transcribing',
  'transcriptionreceived',
  'transcriptionready',
  'transcriptready',
  'readyforanalysis',
  'ready for analysis',
  'video ready',
  'analyzing',
  'analyzed',
  'completed',
  'complete',
  'processing',
]);

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function classifyInterviewDisplayState(interviewRow, { hasScore = false } = {}) {
  if (!interviewRow) return { state: 'not_started', label: SIMPLE_INTERVIEW_STATES.not_started };

  const failureCode = upper(interviewRow.failure_code);
  const failureStage = lower(interviewRow.failure_stage);
  const status = lower(interviewRow.status);
  const progress = lower(interviewRow.conversation_progress_state);
  const endReason = lower(interviewRow.client_end_reason);

  if (
    failureCode === 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE' ||
    progress === 'nosubstantivecandidateresponse' ||
    /no[_ -]?substantive|no[_ -]?response/.test(`${status} ${endReason}`)
  ) {
    return { state: 'no_response', label: SIMPLE_INTERVIEW_STATES.no_response };
  }

  const technicalText = `${failureCode} ${failureStage} ${progress} ${endReason}`;
  if (
    /(DISCONNECT|RECONNECT|MEDIA|MIC|AUDIO|VIDEO|NETWORK|PROVIDER|TAVUS|DAILY|START_FAILED|WATCHDOG|TRANSPORT|TECHNICAL)/i.test(technicalText) ||
    /^(failed|error|disconnected)$/.test(status)
  ) {
    return { state: 'tech_issue', label: SIMPLE_INTERVIEW_STATES.tech_issue };
  }

  if (hasScore) return { state: 'scored', label: SIMPLE_INTERVIEW_STATES.scored };

  if (PROCESSING_INTERVIEW_STATUSES.has(status)) {
    return { state: 'processing', label: SIMPLE_INTERVIEW_STATES.processing };
  }

  return { state: 'incomplete', label: SIMPLE_INTERVIEW_STATES.incomplete };
}

module.exports = {
  SIMPLE_INTERVIEW_STATES,
  classifyInterviewDisplayState,
};
