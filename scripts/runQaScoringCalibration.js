'use strict';

const { createClient } = require('@supabase/supabase-js');
const { scoreInterview } = require('../src/services/interviewScoring');

const QA_PROJECT_REF = 'yjjxzxoghlpguquknyso';
const CALIBRATION_SET = process.env.QA_SCORING_CALIBRATION_SET || 'high_velocity_sales_closer_2026_09_03';

function assertQaOnly() {
  if (process.env.ALLOW_QA_SCORING_CALIBRATION !== 'true') {
    throw new Error('qa_calibration_explicit_opt_in_required');
  }
  const url = new URL(String(process.env.SUPABASE_URL || ''));
  if (url.hostname !== `${QA_PROJECT_REF}.supabase.co`) {
    throw new Error(`qa_calibration_wrong_project:${url.hostname || 'missing'}`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('qa_calibration_service_key_missing');
  if (!process.env.OPENAI_API_KEY) throw new Error('qa_calibration_openai_key_missing');
}

function jdText(roleContext) {
  const direct = String(roleContext?.job_description_text || '').trim();
  if (direct) return direct;
  return String(roleContext?.description || roleContext?.job_description_url || '').trim();
}

async function main() {
  assertQaOnly();
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: cases, error } = await supabase
    .from('scoring_calibration_cases')
    .select('id,case_label,role_context,transcript,prior_scores,perception_scores')
    .eq('calibration_set', CALIBRATION_SET)
    .order('case_label', { ascending: true });
  if (error) throw error;
  if (!Array.isArray(cases) || cases.length !== 6) {
    throw new Error(`qa_calibration_expected_6_cases:${Array.isArray(cases) ? cases.length : 'invalid'}`);
  }

  const results = [];
  for (const calibrationCase of cases) {
    const scored = await scoreInterview({
      transcriptText: calibrationCase.transcript,
      jdText: jdText(calibrationCase.role_context),
      roleContext: calibrationCase.role_context,
      perceptionScores: calibrationCase.perception_scores || {},
      mode: 'qa_calibration',
      request_id: null,
    });
    const { error: updateError } = await supabase
      .from('scoring_calibration_cases')
      .update({
        new_scores: scored.transcript_scores,
        new_summary: scored.summary,
        question_evaluations: scored.question_evaluations,
        scorer_version: scored.scoring_version,
        updated_at: new Date().toISOString(),
      })
      .eq('id', calibrationCase.id);
    if (updateError) throw updateError;
    results.push({
      case_label: calibrationCase.case_label,
      prior: Number(calibrationCase.prior_scores?.overall),
      rescored: Number(scored.transcript_scores?.overall),
      scorable_questions: scored.question_evaluations.filter((item) => item.scorable).length,
      unscored_questions: scored.question_evaluations.filter((item) => !item.scorable).length,
    });
  }

  const priorAverage = Math.round(results.reduce((sum, row) => sum + row.prior, 0) / results.length);
  const rescoredAverage = Math.round(results.reduce((sum, row) => sum + row.rescored, 0) / results.length);
  console.table(results);
  console.log(JSON.stringify({ calibration_set: CALIBRATION_SET, cases: results.length, prior_average: priorAverage, rescored_average: rescoredAverage }));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
