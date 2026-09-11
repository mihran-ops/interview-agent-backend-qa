'use strict';

const Stripe = require('stripe');
const {
  cachedLiveCall,
  costSummary,
  envConfigured,
  envValue,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
  unixSeconds,
  withTimeout,
} = require('./normalizePlatformHealth');

function stripeClient(context) {
  if (typeof context.stripeClientFactory === 'function') return context.stripeClientFactory(envValue(context.env, ['STRIPE_SECRET_KEY']));
  return new Stripe(envValue(context.env, ['STRIPE_SECRET_KEY']), { apiVersion: '2023-10-16' });
}

async function fetchStripeStats(context) {
  const stripe = stripeClient(context);
  const created = {
    gte: unixSeconds(context.dateRange.from),
    lte: unixSeconds(context.dateRange.to),
  };
  const [subscriptions, paymentIntents, balanceTransactions] = await Promise.all([
    withTimeout(stripe.subscriptions.list({ status: 'all', limit: 100, created }), Number(context.timeoutMs || 4000)),
    withTimeout(stripe.paymentIntents.list({ limit: 100, created }), Number(context.timeoutMs || 4000)),
    withTimeout(stripe.balanceTransactions.list({ limit: 100, created }), Number(context.timeoutMs || 4000)).catch(() => null),
  ]);
  const subscriptionRows = Array.isArray(subscriptions?.data) ? subscriptions.data : [];
  const paymentRows = Array.isArray(paymentIntents?.data) ? paymentIntents.data : [];
  const balanceRows = Array.isArray(balanceTransactions?.data) ? balanceTransactions.data : [];
  const successfulPayments = paymentRows.filter((row) => row.status === 'succeeded');
  const failedPayments = paymentRows.filter((row) => /fail|cancel/i.test(String(row.status || '')));
  const grossCents = successfulPayments.reduce((sum, row) => sum + Number(row.amount_received || 0), 0);
  const feeCents = balanceRows.reduce((sum, row) => sum + Number(row.fee || 0), 0);
  return {
    activeSubscriptions: subscriptionRows.filter((row) => row.status === 'active').length,
    trialingSubscriptions: subscriptionRows.filter((row) => row.status === 'trialing').length,
    subscriptionsReturned: subscriptionRows.length,
    successfulPayments: successfulPayments.length,
    failedPayments: failedPayments.length,
    gross: grossCents / 100,
    fees: feeCents / 100,
    currency: (successfulPayments[0]?.currency || balanceRows[0]?.currency || 'usd').toUpperCase(),
  };
}

async function buildStripeHealth(context) {
  const { env, now, signals } = context;
  const configured = envConfigured(env, ['STRIPE_SECRET_KEY']);
  const webhookConfigured = envConfigured(env, ['STRIPE_WEBHOOK_SECRET']);
  let live = null;
  let liveError = null;

  if (configured && shouldRunLiveCheck(context, 'STRIPE_METRICS_ENABLED')) {
    try {
      live = await cachedLiveCall(
        context,
        `stripe:${context.dateRange.date_from}:${context.dateRange.date_to}`,
        () => fetchStripeStats(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  const liveConnected = Boolean(live);
  const failedPayments = Number(live?.failedPayments || 0);
  const problem = failedPayments >= 5 || signals.failedCancellations >= 5;
  const warning = Boolean(liveError || failedPayments || signals.failedCancellations || (configured && !liveConnected));

  return {
    key: 'stripe',
    name: 'Stripe',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: liveConnected ? 'Live vendor API and alphaScreen records' : 'alphaScreen billing records',
    source_code: liveConnected ? 'live_vendor_api' : 'alphascreen_records',
    meaning: 'Shows billing, subscription, checkout, and webhook health.',
    health_summary: liveConnected
      ? 'Using Stripe API for selected-period billing signals.'
      : configured
        ? 'Using internal billing records because live Stripe metrics are not connected.'
        : 'Stripe credentials are not configured for this environment.',
    usage_summary: liveConnected ? [
      metric('Active subscriptions', live.activeSubscriptions, 'Subscriptions returned by Stripe with active status in the selected range.'),
      metric('Trialing subscriptions', live.trialingSubscriptions, 'Subscriptions returned by Stripe with trialing status in the selected range.'),
      metric('Successful payments', live.successfulPayments, 'Succeeded PaymentIntents returned by Stripe.'),
      metric('Gross payment amount', live.gross ? `${live.currency} ${live.gross.toLocaleString()}` : 'Not available', 'Gross successful payment amount from Stripe PaymentIntents.'),
    ] : [
      metric('Stripe customers', signals.stripeCustomers, 'Client records with Stripe customer identifiers.'),
      metric('Stripe subscriptions', signals.stripeSubscriptions, 'Client records with Stripe subscription identifiers.'),
      metric('Active/trial subscriptions', signals.activeStripeClients, 'Client records marked active or trialing.'),
      metric('Cancellation runs', signals.cancellationRuns.length, 'Contract cancellation workflow runs in alphaScreen records.'),
    ],
    problem_summary: [
      metric('Failed payments', liveConnected ? failedPayments : 'Not available', 'Failed/canceled payment intents returned by Stripe.'),
      metric('Failed cancellation runs', signals.failedCancellations, 'Failed cancellation workflow rows stored by alphaScreen.'),
      metric('Webhook receiving', webhookConfigured ? 'Configured' : 'Not configured', 'Whether Stripe webhook verification configuration is present.'),
    ],
    cost_summary: liveConnected && live.fees
      ? costSummary({ value: live.fees, currency: live.currency, sourceLabel: 'Live vendor API', help: 'Stripe processing fees returned by balance transactions for the selected range.' })
      : costSummary({ help: 'Stripe fees are unavailable unless balance transaction access is available.' }),
    readiness_items: [
      readiness('Credentials', configured ? 'Configured' : 'Missing', 'Required before alphaScreen can call Stripe.'),
      readiness('Webhook receiver', webhookConfigured ? 'Configured' : 'Not configured', 'Required for trusted Stripe event processing.'),
      readiness('Billing API', liveConnected ? 'Connected' : 'Not connected', 'Reads subscriptions, payments, and balance transactions when available.'),
      readiness('Record fallback', 'Available', 'Internal billing records remain available without live Stripe metrics.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'Stripe live billing check failed.') : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['Stripe live metrics could not be read; internal billing records are still shown.'] : [],
  };
}

module.exports = { buildStripeHealth };
