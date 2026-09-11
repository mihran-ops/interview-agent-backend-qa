'use strict';

const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY environment variable.');
}

const { TIMEOUT_PROFILES } = require('./http');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
  // Same bound the shared HTTP client puts on any other vendor mutation.
  timeout: TIMEOUT_PROFILES.mutation.requestMs,
  maxNetworkRetries: 1,
});

module.exports = stripe;
