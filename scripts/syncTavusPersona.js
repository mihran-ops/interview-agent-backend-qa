// Safely sync behavior-relevant Tavus persona settings between separate QA/prod personas.
// Dry-run initial QA setup:
//   TAVUS_SOURCE_PERSONA_ID=p75bb8779b7d TAVUS_TARGET_PERSONA_ID=p7cb30e9c407 node scripts/syncTavusPersona.js
// Apply initial QA setup:
//   TAVUS_SOURCE_PERSONA_ID=p75bb8779b7d TAVUS_TARGET_PERSONA_ID=p7cb30e9c407 node scripts/syncTavusPersona.js --apply
// Dry-run future prod promotion:
//   TAVUS_SOURCE_PERSONA_ID=p7cb30e9c407 TAVUS_TARGET_PERSONA_ID=p75bb8779b7d node scripts/syncTavusPersona.js
// Apply future prod promotion:
//   TAVUS_SOURCE_PERSONA_ID=p7cb30e9c407 TAVUS_TARGET_PERSONA_ID=p75bb8779b7d node scripts/syncTavusPersona.js --apply
'use strict';

const { createTavusHttpClient } = require('../src/clients/tavus');

try {
  require('dotenv').config();
} catch (error) {
  const isMissingDotenv = error?.code === 'MODULE_NOT_FOUND' && String(error?.message || '').includes("'dotenv'");
  if (!isMissingDotenv) throw error;
}

const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
const API_BASE = String(process.env.TAVUS_API_BASE_URL || '').trim().replace(/\/+$/, '') || undefined;
const tavusHttpClient = createTavusHttpClient({ apiKey: API_KEY, baseUrl: API_BASE });
const APPLY = process.argv.includes('--apply');

const COPY_PATHS = [
  { name: 'system_prompt', path: ['system_prompt'] },
  { name: 'layers.tts', path: ['layers', 'tts'] },
  { name: 'layers.stt', path: ['layers', 'stt'] },
  { name: 'layers.conversational_flow', path: ['layers', 'conversational_flow'] },
  { name: 'layers.perception', path: ['layers', 'perception'] }
];

function getArgValue(name) {
  const exact = `--${name}`;
  const prefixed = `${exact}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === exact) return String(process.argv[i + 1] || '').trim();
    if (arg.startsWith(prefixed)) return arg.slice(prefixed.length).trim();
  }
  return '';
}

const SOURCE_PERSONA_ID = getArgValue('source') || String(process.env.TAVUS_SOURCE_PERSONA_ID || '').trim();
const TARGET_PERSONA_ID = getArgValue('target') || String(process.env.TAVUS_TARGET_PERSONA_ID || '').trim();

function usage() {
  return [
    'Usage:',
    '  TAVUS_SOURCE_PERSONA_ID=<source> TAVUS_TARGET_PERSONA_ID=<target> node scripts/syncTavusPersona.js [--apply]',
    '  node scripts/syncTavusPersona.js --source <source> --target <target> [--apply]',
    '',
    'Examples:',
    '  TAVUS_SOURCE_PERSONA_ID=p75bb8779b7d TAVUS_TARGET_PERSONA_ID=p7cb30e9c407 node scripts/syncTavusPersona.js',
    '  TAVUS_SOURCE_PERSONA_ID=p75bb8779b7d TAVUS_TARGET_PERSONA_ID=p7cb30e9c407 node scripts/syncTavusPersona.js --apply',
    '  TAVUS_SOURCE_PERSONA_ID=p7cb30e9c407 TAVUS_TARGET_PERSONA_ID=p75bb8779b7d node scripts/syncTavusPersona.js',
    '  TAVUS_SOURCE_PERSONA_ID=p7cb30e9c407 TAVUS_TARGET_PERSONA_ID=p75bb8779b7d node scripts/syncTavusPersona.js --apply'
  ].join('\n');
}

function requireValue(name, value) {
  if (!value) {
    console.error(`${name} is required.`);
    console.error(usage());
    process.exit(1);
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getPath(obj, path) {
  return path.reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), obj);
}

function hasPath(obj, path) {
  let cursor = obj;
  for (const key of path) {
    if (!cursor || !Object.prototype.hasOwnProperty.call(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}

function setPath(obj, path, value) {
  let cursor = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = clone(value);
}

function jsonPatchPath(path) {
  return `/${path.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function textCorpus(persona) {
  return JSON.stringify({
    system_prompt: persona?.system_prompt || '',
    perception: persona?.layers?.perception || {}
  });
}

function verificationSummary(persona) {
  const text = textCorpus(persona);
  const speed = persona?.layers?.tts?.voice_settings?.speed;
  return {
    has_anti_coaching_guard: /sample answers|model answers|ideal answers|coaching/i.test(text),
    has_reported_speech_not_live_question_guard: /reported speech|past-tense narration|not-live|not live/i.test(text),
    has_one_follow_up_rule: /one targeted follow-up|one brief follow-up|at most one/i.test(text),
    has_internal_evaluation_rubric_refusal: /internal evaluation|rubric|evaluation criteria/i.test(text) && /can't share|cannot share|never disclose/i.test(text),
    has_hidden_marker_prohibition: /hidden markers|marker names/i.test(text),
    does_not_contain_unanswered_question_marker: !/UNANSWERED_QUESTION/i.test(text),
    tts_voice_settings_speed: typeof speed === 'number' ? speed : null
  };
}

function buildPatchAndProposedPersona(source, target) {
  const patch = [];
  const proposed = clone(target || {});
  const changed = [];
  const needsLayersParent = COPY_PATHS.some(({ path }) => path[0] === 'layers' && getPath(source, path) !== undefined);

  if (needsLayersParent && (!proposed.layers || typeof proposed.layers !== 'object')) {
    patch.push({ op: hasPath(target, ['layers']) ? 'replace' : 'add', path: '/layers', value: {} });
    proposed.layers = {};
  }

  for (const item of COPY_PATHS) {
    const sourceValue = getPath(source, item.path);
    if (sourceValue === undefined) continue;
    const targetValue = getPath(target, item.path);
    setPath(proposed, item.path, sourceValue);
    if (!sameJson(sourceValue, targetValue)) {
      patch.push({
        op: hasPath(target, item.path) ? 'replace' : 'add',
        path: jsonPatchPath(item.path),
        value: clone(sourceValue)
      });
      changed.push(item.name);
    }
  }

  return { patch, proposed, changed };
}

async function fetchPersona(personaId) {
  return await tavusHttpClient.getPersona(personaId) || {};
}

async function patchPersona(personaId, patch) {
  return tavusHttpClient.patchPersona(personaId, patch, {
    contentType: 'application/json-patch+json',
  });
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }

  requireValue('TAVUS_API_KEY', API_KEY);
  requireValue('TAVUS_SOURCE_PERSONA_ID or --source', SOURCE_PERSONA_ID);
  requireValue('TAVUS_TARGET_PERSONA_ID or --target', TARGET_PERSONA_ID);
  if (SOURCE_PERSONA_ID === TARGET_PERSONA_ID) {
    console.error('Source and target persona IDs must be different.');
    process.exit(1);
  }
  console.log('Tavus persona sync');
  console.log('Source persona id:', SOURCE_PERSONA_ID);
  console.log('Target persona id:', TARGET_PERSONA_ID);
  console.log('Mode:', APPLY ? 'apply' : 'dry-run');
  console.log('Tavus API base:', API_BASE || 'shared-client-default');

  const source = await fetchPersona(SOURCE_PERSONA_ID);
  const target = await fetchPersona(TARGET_PERSONA_ID);
  const { patch, proposed, changed } = buildPatchAndProposedPersona(source, target);

  console.log('Fields/layers to change:', changed.length ? changed.join(', ') : 'none');
  console.log('Target default replica preserved:', true);
  console.log('Target default replica note: default_replica_id is not copied by this script.');

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to update the target persona.');
    console.log('Patch preview:', JSON.stringify(patch, null, 2));
    console.log('Dry-run verification:', JSON.stringify(verificationSummary(proposed), null, 2));
    return;
  }

  if (patch.length) {
    await patchPersona(TARGET_PERSONA_ID, patch);
  }
  const verifiedTarget = await fetchPersona(TARGET_PERSONA_ID);
  console.log('Apply complete.');
  console.log('Verification summary:', JSON.stringify(verificationSummary(verifiedTarget), null, 2));
}

main().catch((error) => {
  console.error('Tavus persona sync failed:', error?.message || error);
  process.exit(1);
});
