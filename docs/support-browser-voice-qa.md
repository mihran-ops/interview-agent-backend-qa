# QA dashboard browser voice support

## September 11 email escalation update

The optional, caller-approved support email action is documented in [support-agent-email-escalation.md](./support-agent-email-escalation.md). When `SUPPORT_HANDOFF_ENABLED` is on and configured, it adds exactly one attested tool; the earlier no-tool behavior below remains the disabled-mode baseline. The browser still cannot inspect accounts or transfer calls, and it does not store recordings or transcripts.

# Historical QA dashboard browser voice baseline

The QA dashboard voice surface is a separate, informational-only support channel. It does not replace or modify the public alphaSource Support phone agent.

## Knowledge contract

- Version: `2026-08-26.1`
- Source snapshot: `src/content/support-voice-knowledge.json`
- Integrity file: `src/content/support-voice-knowledge.sha256`
- Enumerated sources: dashboard Help Center FAQ, rubric FAQ, dashboard and public product updates, public FAQ, public support topics, and public support questions.
- The backend validates the snapshot hash and prompt size before issuing a voice-session credential.

The agent has no tools, no customer/tenant context, and no product-data access. It must not request candidate data, credentials, payment data, interview content, transcripts, or other sensitive information. Account-specific and action requests are redirected to the Help Center or normal support process.

## Agent boundary

The browser support agent is separate from the public phone agent through its dedicated QA gateway, server-owned support prompt, static Help Center knowledge, Carina voice configuration, and audio-only Realtime session. The documented xAI Realtime browser path is configured per session and does not consume a Console Voice Agent entity ID. The existing Console phone agent is therefore unchanged. Do not add a Console agent ID as a readiness gate unless xAI documents and the runtime actually uses that identifier.

## Privacy contract

Conversation audio exists only in bounded process/browser memory while the live QA session is connected. alphaScreen does not persist recordings or transcripts in this phase. Text/transcript provider events are not forwarded or stored. Provider-side processing remains governed by xAI's API terms.

## Transport and authorization contract

- The dashboard uses only `https://ia-backend-qa.onrender.com`; it never receives an xAI credential or chooses the provider prompt, model, voice, tools, or target.
- Session creation requires the existing Supabase bearer authentication plus a service-role, count-only active-membership check. No client ID, membership record, role, email, raw user ID, or account context reaches xAI.
- The browser WebSocket accepts only `alphascreen-support-v1`, a one-time body-frame credential, bounded 24 kHz PCM16 audio, and clear-buffer control. It does not accept text, tools, functions, session overrides, or response instructions.
- The server sends one audio-only xAI session configuration with transcription and resumption disabled. Provider transcripts, text, conversation items, tools, searches, MCP, and function events are never forwarded.
- The `session.updated` attestation permits only xAI's bounded `event_id` and nullable `previous_item_id` envelope metadata in addition to the exact server-owned session contract. Unknown metadata and any capability, prompt, model, voice, modality, transcription, resumption, tool, or transport drift remain fail-closed.
- Before that attestation, only the exact bounded xAI `session.created`, `conversation.created`, and `ping` control envelopes are ignored. The pre-update `session.created` snapshot permits only xAI's observed content-free `turn_detection` defaults: `null`, exact `{ "type": null }`, or exact `{ "type": "server_vad" }`; none can grant readiness. A valid content-free `ping` is also ignored during greeting or an attested session; a late session/conversation creation event terminates instead of resetting state. No control can make the browser ready or alter the authoritative session, and malformed, unknown, or capability-bearing messages remain fail-closed.
- After exact attestation, the gateway queues the one server-owned greeting and marks the transport ready in the same JavaScript turn. Provider response events may therefore arrive before the WebSocket send callback without being mistaken for pre-ready capability drift; a synchronous throw, callback error, or callback timeout still closes the session.
- Unexpected session finalization records only a bounded reason, state-machine phase, and allowlisted provider event type. It never logs credentials, customer identity, prompt/knowledge text, audio, transcripts, provider payloads, or identifiers.
- Sessions are limited to one live session per user, 20 live sessions globally, ten minutes maximum, 120 seconds of user inactivity, and a 25-second ping/10-second pong deadline.

## Durable multi-instance session authority

One-time browser credential authority is stored in `private_support.support_voice_sessions`, not in a backend process. The browser receives the plaintext credential once; only its SHA-256 digest is written through a service-role RPC. Any healthy backend instance can atomically consume that digest exactly once before it connects to xAI.

The database owns all security constants and transitions:

- pending credentials expire after 60 seconds;
- consumed sessions expire after 600 seconds;
- one pending/active row is permitted per user fingerprint;
- no more than 20 pending/active rows are permitted globally;
- reserve is serialized by one namespaced transaction advisory lock;
- consume changes one pending row to active under a row lock and removes its credential digest;
- close and pending-abandon operations are idempotent.

`private_support` grants no schema usage to `PUBLIC`, `anon`, `authenticated`, or `service_role`. Its RLS-enabled table has no policies and no direct application-role grants. PostgreSQL-owned `SECURITY DEFINER` wrappers use an empty `search_path`; only `service_role` may execute the five public support-session RPCs. This is an authorization boundary, not a product-data store. It contains only opaque session IDs, credential digests, user fingerprints, state, timestamps, and bounded close reasons.

The backend probes the content-free health RPC every two seconds. Readiness is valid for at most five seconds after a successful probe. Health, reserve, and consume failures fail closed; only a later successful probe restores readiness. Terminal WebSocket cleanup retries the idempotent close RPC with bounded exponential backoff until success or the database-owned session expiry. A process crash cannot keep authority live beyond that expiry.

At least one exact support-voice origin is mandatory. `SUPPORT_VOICE_ALLOWED_ORIGIN` remains the single-origin compatibility setting; `SUPPORT_VOICE_ALLOWED_ORIGINS` accepts a comma-separated bounded list when more than one legitimate dashboard hostname is active. Production-mode backends accept only HTTPS origins, and every configured entry must be a complete exact origin. Localhost is available only in non-production with the explicit local-development flag. The former external scale monitor, monitor token, internal monitor routes, hard-coded QA origin, and single-instance confirmation flag are not part of this architecture.

## Release order

1. Apply the reviewed durable-session migration while the feature remains disabled.
2. Deploy the exact reviewed backend commit with `SUPPORT_VOICE_ALLOWED_ORIGIN` set to the exact QA frontend origin.
3. Require `session_store_ok=true`, exact backend identity, and knowledge-hash parity before enabling the backend feature.
4. Deploy/enable the matching QA frontend only after backend readiness is green.
5. Run hosted creation, cross-instance-equivalent consume, replay, conflict, timeout, close, privacy, and product-data non-mutation acceptance.

Production remains a separate reconstruction and approval gate. A future FAQ change must regenerate the snapshot, update both repositories, and repeat the backend-first parity gate.
