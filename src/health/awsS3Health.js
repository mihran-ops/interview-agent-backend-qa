'use strict';

let HeadBucketCommand = null;
let S3Client = null;
let s3SdkLoadError = null;
try {
  ({ HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3'));
} catch (error) {
  s3SdkLoadError = error;
}

const {
  cachedLiveCall,
  costSummary,
  envConfigured,
  envValue,
  metric,
  readiness,
  shouldRunLiveCheck,
  statusWithProblems,
  withTimeout,
} = require('./normalizePlatformHealth');

const RECORDING_BUCKET_ENV_NAMES = ['TAVUS_RECORDING_S3_BUCKET_NAME'];
const RECORDING_REGION_ENV_NAMES = ['AWS_REGION', 'TAVUS_RECORDING_S3_BUCKET_REGION'];

function selectedEnv(env, names) {
  for (const name of names || []) {
    const value = envValue(env, [name]);
    if (value) return { name, value };
  }
  return { name: null, value: '' };
}

function bucketEnv(env) {
  return selectedEnv(env, RECORDING_BUCKET_ENV_NAMES);
}

function regionEnv(env) {
  return selectedEnv(env, RECORDING_REGION_ENV_NAMES);
}

function keySource(env) {
  const hasAccessKey = envConfigured(env, ['AWS_ACCESS_KEY_ID']);
  const hasSecretKey = envConfigured(env, ['AWS_SECRET_ACCESS_KEY']);
  if (hasAccessKey && hasSecretKey) return 'explicit_credentials';
  if (hasAccessKey || hasSecretKey) return 'unknown';
  if (envConfigured(env, ['AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_PROFILE', 'AWS_ROLE_ARN'])) {
    return 'iam_role';
  }
  return 'missing';
}

function awsHttpStatus(error) {
  return Number(
    error?.$metadata?.httpStatusCode ||
    error?.$response?.statusCode ||
    error?.statusCode ||
    error?.status ||
    0
  ) || null;
}

function awsErrorText(error) {
  return `${error?.name || ''} ${error?.Code || ''} ${error?.code || ''} ${error?.message || ''}`.toLowerCase();
}

function awsErrorKind(error) {
  if (s3SdkLoadError || error?.code === 'sdk_missing') return 'sdk_missing';
  if (error?.code === 'live_api_timeout') return 'timeout';
  const status = awsHttpStatus(error);
  const text = awsErrorText(error);
  if (
    status === 301 ||
    text.includes('permanentredirect') ||
    text.includes('authorizationheadermalformed') ||
    text.includes('illegallocationconstraint') ||
    text.includes('wrong region')
  ) return 'region_mismatch';
  if (status === 403 || text.includes('accessdenied') || text.includes('forbidden')) return 'permission';
  if (status === 404 || text.includes('nosuchbucket') || text.includes('notfound')) return 'not_found';
  if (
    text.includes('credential') ||
    text.includes('invalidaccesskeyid') ||
    text.includes('signaturedoesnotmatch') ||
    text.includes('security token') ||
    text.includes('could not load credentials')
  ) return 'credentials';
  return 'unknown';
}

function awsDiagnostics(env, overrides = {}) {
  return {
    aws_key_source: keySource(env),
    aws_bucket_source: bucketEnv(env).name,
    aws_region_source: regionEnv(env).name,
    aws_health_check: 'skipped',
    aws_health_status: 'skipped',
    aws_error_kind: null,
    aws_error_http_status: null,
    ...overrides,
  };
}

function awsTroubleshootingNote(kind) {
  if (!kind) return null;
  if (kind === 'permission') return 'S3 HeadBucket failed because the configured identity does not have bucket access.';
  if (kind === 'not_found') return 'S3 HeadBucket failed because the configured bucket was not found.';
  if (kind === 'region_mismatch') return 'S3 HeadBucket failed because the configured region does not match the bucket region.';
  if (kind === 'credentials') return 'S3 HeadBucket failed because AWS credentials could not be used.';
  if (kind === 'timeout') return 'S3 HeadBucket timed out.';
  if (kind === 'sdk_missing') return 'S3 HeadBucket was skipped because the AWS S3 SDK is unavailable.';
  return 'S3 HeadBucket failed. Check bucket, region, and permissions.';
}

async function headBucket(context) {
  if (!S3Client || !HeadBucketCommand) {
    const error = new Error('AWS S3 SDK is not available.');
    error.code = 'sdk_missing';
    throw error;
  }
  const region = regionEnv(context.env).value;
  const bucket = bucketEnv(context.env).value;
  const client = typeof context.awsS3ClientFactory === 'function'
    ? context.awsS3ClientFactory({ region })
    : new S3Client({ region });
  await withTimeout(
    client.send(new HeadBucketCommand({ Bucket: bucket })),
    Number(context.timeoutMs || 4000)
  );
  return { reachable: true };
}

async function buildAwsS3Health(context) {
  const { env, now, signals } = context;
  const selectedBucket = bucketEnv(env);
  const selectedRegion = regionEnv(env);
  const bucketConfigured = Boolean(selectedBucket.value);
  const regionConfigured = Boolean(selectedRegion.value);
  const credentialConfigured = envConfigured(env, ['AWS_ACCESS_KEY_ID']) && envConfigured(env, ['AWS_SECRET_ACCESS_KEY']);
  const configured = bucketConfigured && regionConfigured;
  let live = null;
  let liveError = null;
  let diagnostics = awsDiagnostics(env);

  if (configured && shouldRunLiveCheck(context, 'AWS_S3_HEALTH_ENABLED')) {
    diagnostics.aws_health_check = 'head_bucket';
    try {
      live = await cachedLiveCall(
        context,
        `aws-s3:${selectedBucket.name}:${selectedRegion.name}:${selectedRegion.value}`,
        () => headBucket(context)
      );
      diagnostics.aws_health_status = 'connected';
    } catch (error) {
      liveError = error;
      diagnostics.aws_health_status = 'failed';
      diagnostics.aws_error_kind = awsErrorKind(error);
      diagnostics.aws_error_http_status = awsHttpStatus(error);
    }
  }

  const liveConnected = Boolean(live?.reachable);
  const problem = signals.recordingDeleteErrors >= 5;
  const warning = Boolean(liveError || signals.recordingDeleteErrors || signals.recordingProblems || (configured && !liveConnected));

  return {
    key: 'aws_s3',
    name: 'AWS/S3',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: liveConnected ? 'Live vendor API and estimated from recording records' : 'Estimated from recording records',
    source_code: liveConnected ? 'live_vendor_api' : 'estimated_from_records',
    meaning: 'Shows recording storage reachability and storage-related problems.',
    health_summary: liveConnected
      ? 'Recording storage bucket is reachable.'
      : configured
        ? 'Recording storage configuration exists; bucket reachability is not connected or did not complete.'
        : 'Recording storage bucket or region is not configured.',
    usage_summary: [
      metric('Bucket configured', bucketConfigured ? 'Yes' : 'No', 'Whether a recording bucket name is configured.'),
      metric('Region configured', regionConfigured ? 'Yes' : 'No', 'Whether an AWS region is configured.'),
      metric('Credentials configured', credentialConfigured ? 'Yes' : 'Default/IAM or not configured', 'Whether explicit AWS credentials are present.'),
      metric('Recording ready proxy', signals.recordingReady, 'Ready recordings from alphaScreen interview records.'),
    ],
    problem_summary: [
      metric('Recording pending/problem', signals.recordingPending + signals.recordingProblems, 'Recordings not ready or marked problem in alphaScreen records.'),
      metric('Storage/delete errors', signals.recordingDeleteErrors, 'Storage cleanup errors stored on interview rows.'),
      metric('Bucket reachability', liveConnected ? 'Reachable' : liveError ? 'Check failed' : 'Not connected', 'HeadBucket result when safe AWS access is available.'),
    ],
    cost_summary: costSummary({ help: 'S3 object count, size, and cost are not checked here to avoid expensive or broad bucket scans.' }),
    diagnostics,
    readiness_items: [
      readiness('Bucket', bucketConfigured ? 'Configured' : 'Missing', 'Required to store Tavus recordings.'),
      readiness('Region', regionConfigured ? 'Configured' : 'Missing', 'Required for S3 operations.'),
      readiness('Bucket reachability', liveConnected ? 'Connected' : 'Not connected', 'Uses a bounded HeadBucket check when configured.'),
    ],
    troubleshooting_note: liveError ? awsTroubleshootingNote(diagnostics.aws_error_kind) : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['S3 bucket reachability could not be confirmed; recording records are still shown.'] : [],
  };
}

module.exports = { buildAwsS3Health };
