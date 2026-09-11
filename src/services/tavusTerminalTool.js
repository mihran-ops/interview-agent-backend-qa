'use strict';

const TERMINAL_INTERVIEW_TOOL_NAMES = new Set(['end_call', 'end_interview']);

function isTerminalInterviewToolName(value) {
  return TERMINAL_INTERVIEW_TOOL_NAMES.has(String(value || '').trim().toLowerCase());
}

module.exports = {
  isTerminalInterviewToolName,
};
