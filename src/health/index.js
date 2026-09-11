'use strict';

const { buildAwsS3Health } = require('./awsS3Health');
const { buildOpenAIHealth } = require('./openaiHealth');
const { buildRenderHealth } = require('./renderHealth');
const { buildSendGridHealth } = require('./sendgridHealth');
const { buildSentryHealth } = require('./sentryHealth');
const { buildStripeHealth } = require('./stripeHealth');
const { buildSupabaseHealth } = require('./supabaseHealth');
const { buildTavusHealth } = require('./tavusHealth');
const {
  buildAlphaScreenSignals,
  normalizeService,
  serviceFailure,
} = require('./normalizePlatformHealth');

const ADAPTERS = [
  { key: 'openai', name: 'OpenAI', build: buildOpenAIHealth },
  { key: 'tavus', name: 'Tavus', build: buildTavusHealth },
  { key: 'supabase', name: 'Supabase', build: buildSupabaseHealth },
  { key: 'sendgrid', name: 'SendGrid', build: buildSendGridHealth },
  { key: 'render', name: 'Render', build: buildRenderHealth },
  { key: 'sentry', name: 'Sentry', build: buildSentryHealth },
  { key: 'aws_s3', name: 'AWS/S3', build: buildAwsS3Health },
  { key: 'stripe', name: 'Stripe', build: buildStripeHealth },
];

function readinessFromService(service) {
  return {
    service: service.name,
    configured: service.configured,
    live_usage_connected: service.live_api_connected === true,
    event_source: service.source_label,
    notes: service.troubleshooting_note || service.health_summary,
    items: service.readiness_items,
  };
}

async function buildPlatformHealthServices(context) {
  const rows = {
    clients: context.clients,
    clientsBilling: context.clientsBilling,
    roles: context.roles,
    candidates: context.candidates,
    interviews: context.interviews,
    reports: context.reports,
    perceptionEvents: context.perceptionEvents,
    emailEvents: context.emailEvents,
    cancellationRuns: context.cancellationRuns,
  };
  const adapterContext = {
    ...context,
    rows,
    warnings: context.warnings || [],
    signals: buildAlphaScreenSignals({ rows, now: context.now }),
  };
  const services = await Promise.all(ADAPTERS.map(async (adapter) => {
    try {
      return normalizeService(await adapter.build(adapterContext));
    } catch (error) {
      return serviceFailure(adapter.key, adapter.name, error, adapterContext.now);
    }
  }));

  return {
    services,
    readiness: services.map(readinessFromService),
  };
}

module.exports = {
  ADAPTERS,
  buildPlatformHealthServices,
};
