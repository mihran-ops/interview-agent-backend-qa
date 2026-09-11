'use strict';

const MAX_CONTENT_LENGTH_BYTES = 20 * 1024 * 1024;

function safeHeader(req, name) {
  const value = String(req?.get?.(name) || '').trim();
  return value ? value.slice(0, 128) : null;
}

function boundedContentLength(req) {
  const parsed = Number(req?.get?.('content-length'));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(Math.trunc(parsed), MAX_CONTENT_LENGTH_BYTES);
}

function contentTypeCategory(req) {
  const value = String(req?.get?.('content-type') || '').toLowerCase();
  if (value.startsWith('multipart/form-data')) return 'multipart';
  if (value.startsWith('application/json')) return 'json';
  return value ? 'other' : 'unknown';
}

function lifecycleFields(req) {
  const context = req?.candidate_submit_lifecycle || {};
  return {
    request_id: req?.request_id || null,
    render_request_id: context.render_request_id || null,
    cf_ray: context.cf_ray || null,
  };
}

function markCandidateSubmitStage(req, stage, metadata = {}) {
  const context = req?.candidate_submit_lifecycle;
  if (!context || context.completed) return;
  context.stage = String(stage || 'unknown').slice(0, 64);
  context.logger.info('[candidate-submit] lifecycle_stage', {
    ...lifecycleFields(req),
    stage: context.stage,
    elapsed_ms: Math.max(0, context.now() - context.started_at_ms),
    ...metadata,
  });
}

function createCandidateSubmitLifecycle({ logger = console, now = Date.now } = {}) {
  return function candidateSubmitLifecycle(req, res, next) {
    const context = {
      started_at_ms: now(),
      stage: 'received',
      completed: false,
      render_request_id: safeHeader(req, 'rndr-id'),
      cf_ray: safeHeader(req, 'cf-ray'),
      logger,
      now,
    };
    req.candidate_submit_lifecycle = context;

    logger.info('[candidate-submit] lifecycle_received', {
      ...lifecycleFields(req),
      stage: context.stage,
      content_length_bytes: boundedContentLength(req),
      content_type: contentTypeCategory(req),
    });

    const complete = (event, metadata = {}) => {
      if (context.completed) return;
      context.completed = true;
      logger.info(`[candidate-submit] lifecycle_${event}`, {
        ...lifecycleFields(req),
        stage: context.stage,
        elapsed_ms: Math.max(0, now() - context.started_at_ms),
        ...metadata,
      });
    };

    req.once?.('aborted', () => complete('request_aborted'));
    res.once?.('finish', () => complete('response_finished', { status: Number(res.statusCode) || null }));
    res.once?.('close', () => {
      if (!res.writableEnded) complete('connection_closed', { status: Number(res.statusCode) || null });
    });
    next();
  };
}

function createCandidateUploadMiddleware(uploadMiddleware) {
  return function candidateUploadMiddleware(req, res, next) {
    uploadMiddleware(req, res, (error) => {
      if (error) {
        markCandidateSubmitStage(req, 'upload_failed', {
          error_code: String(error?.code || 'upload_error').slice(0, 64),
        });
        return next(error);
      }
      const files = Array.isArray(req.files) ? req.files : [];
      const totalBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file?.size) || 0), 0);
      markCandidateSubmitStage(req, 'multipart_complete', {
        file_count: files.length,
        file_size_bytes: Math.min(totalBytes, MAX_CONTENT_LENGTH_BYTES),
      });
      return next();
    });
  };
}

module.exports = {
  createCandidateSubmitLifecycle,
  createCandidateUploadMiddleware,
  markCandidateSubmitStage,
};
