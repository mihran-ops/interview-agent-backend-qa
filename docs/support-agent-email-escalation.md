# Support agent email escalation

September 11, 2026. QA implementation; verify hosted readiness and delivery before describing a channel as active.

## Intended behavior

Escalate only when the caller requests human help or the agent cannot resolve an issue. Offer a phone connection/contact route or a message to support. Never email after every conversation. For email, collect the caller’s name, reply email and short issue summary, ask for spelling when uncertain, and read all three back, and obtain explicit approval before invoking `send_support_message` with `confirmed: true`.

Both agents keep tool names, parameters, provider names and sending mechanics out of spoken replies. After approval, use “I’ll send a message to the support team.” Only an accepted result permits confirming submission. Email uses a natural greeting, the exact approved message, a reply sentence and a short sign-off; it does not lead with channel labels, reference codes or protocol details.

The dashboard cannot transfer its browser voice session. It may provide (605) 599-8008, whose phone agent can offer an approved transfer. Preserve the phone agent's existing transfer destination, permission requirement, and pricing/contract restrictions.

## Addresses and delivery

- Fixed From: `support-agent@alphasourceai.com`, an alternate address on Jason's Workspace account. No extra Workspace seat.
- Fixed To: `support@alphasourceai.com`, Google Group `00meukdy3zc4lgt`, initially only Jason as owner/member. Invite-only membership; members-only conversations and member visibility; incoming external email allowed.
- Reply-To: the caller-confirmed reply email. It is not proof of account identity or authority.
- SendGrid domain authentication was verified, and the single authorized setup email arrived in Jason's inbox through the group on September 11. This verifies address routing, not agent execution.

## Backend controls

`SUPPORT_HANDOFF_ENABLED=true` plus the existing `SENDGRID_API_KEY` enable the single dashboard tool. The provider canary attests its complete schema and continues to reject other tools/capabilities. Account access, transcripts, recordings, arbitrary recipients, attachments, external lookup and account changes remain unavailable.

`POST /api/support/phone-handoff` additionally requires `Authorization: Bearer <SUPPORT_PHONE_HANDOFF_TOKEN>`, a dedicated random secret of at least 32 characters. No browser Origin is accepted. Configure the phone API request tool with four required JSON body fields: `contact_name` (string, confirmed spelling, 1–120 characters), `summary` (string), `contact_email` (string), `confirmed` (boolean). Never put this token into source, a public client, query parameters, or the agent prompt. The QA URL is `https://ia-backend-qa.onrender.com/api/support/phone-handoff`; production routing requires a separate deployment decision.

The backend validates exact fields, requires a nonempty caller name and bounds name, summary and email length, rejects obvious credentials/codes/private links, and sends plain text only to the fixed team group. Prompts forbid candidate records and other sensitive information; these content rules still require operational review because pattern checks cannot identify all sensitive prose.

The existing shared `check_and_increment_rate_limit` RPC enforces 60 attempts/hour globally and five/hour per hashed reply email. A 24-hour send reservation prevents retries across backend instances. Dashboard requests use the authenticated session ID; phone requests use a hash of the normalized approved payload because the current Console tool exposes no stable call ID. Consequently, an identical phone request within 24 hours is suppressed even if made on a new call. Only hashes/counters enter this database path; message text and reply addresses are not stored there or logged by the feature.

The dashboard allows one tool attempt per voice session. Provider continuation waits until the current response and estimated audio playback finish. The email may finish after the caller disconnects if they already approved submission.

`accepted` means SendGrid accepted the request, not guaranteed inbox delivery or a response deadline. `unknown`, `failed`, `already_attempted`, `rate_limited`, `invalid_request`, or `unavailable` must never be described as success. There is no automatic retry after uncertain sending. Give the direct support address if submission cannot be confirmed.

## Validation and rollout

Local service/router/WebSocket tests cover fixed recipient, explicit consent, malformed input, authentication, browser-Origin rejection, duplicate prevention, uncertain sends, disabled mode, tool allowlisting and audio continuation. The complete pre-existing voice suite remains required. No new database schema or customer-record access is needed. QA RPC verification used only a synthetic rate-limit key.

Before activation, verify `/api/support/voice/health` using the exact QA frontend Origin; require `available`, `provider_contract_ok`, and `email_handoff_enabled` true. Verify the dashboard popover disclosure, approved-message behavior and a no-send/declined-consent conversation. A live email test requires a specifically authorized, clearly labeled setup message, followed by inbox verification. Do not infer this from mocked tests.

For the phone, review the API request preview and consent instructions, set the dedicated token, and publish only after its intended environment is confirmed. Never give either agent Gmail access to Jason's personal mailbox.

Rollback: set `SUPPORT_HANDOFF_ENABLED=false` and redeploy the backend; the dashboard reverts to the existing no-tool policy and hides its email disclosure. Remove/disable the phone tool and restore its no-email instructions if necessary. The support group and sender address can remain available for manual email.

## Follow-on cleanup

Jason confirmed Tawk is unused. Remove its public and dashboard mounts, component, unused consent category and current privacy wording after the current support/agent work is finished. Preserve other tracking choices and existing saved analytics/marketing preferences. No Tawk account deletion is authorized or needed.
