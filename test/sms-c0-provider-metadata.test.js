'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { recordOtpSmsDeliveryMetadata } = require('../src/services/otpChallenge');

test('trusted wrapper records accepted provider-neutral metadata without a private-table write', async () => {
  let invocation = null;
  const db = {
    rpc: async (name, args) => {
      invocation = { name, args };
      return {
        data: [{
          challenge_id: '81000000-0000-4000-8000-000000000001',
          provider: 'provider_a',
          provider_message_id: 'message-1',
          provider_delivery_status: 'queued',
          send_requested_at: '2026-08-12T12:00:00.000Z',
          provider_accepted_at: '2026-08-12T12:00:01.000Z',
          failed_at: null,
          failure_category: null,
        }],
        error: null,
      };
    },
  };

  await recordOtpSmsDeliveryMetadata(db, {
    challengeId: '81000000-0000-4000-8000-000000000001',
    event: 'provider_accepted',
    provider: 'provider_a',
    providerMessageId: 'message-1',
    deliveryStatus: 'queued',
  });

  assert.equal(invocation.name, 'service_record_otp_sms_delivery_metadata');
  assert.equal(invocation.args.p_provider_message_id, 'message-1');
  assert.equal(invocation.args.p_delivery_status, 'queued');
});
