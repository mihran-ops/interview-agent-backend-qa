// src/clients/sendgrid.js
const fs = require('fs')
const path = require('path')
const sg = require('@sendgrid/mail')

const { TIMEOUT_PROFILES } = require('./http')

const API_KEY = process.env.SENDGRID_API_KEY
if (!API_KEY) {
  // Don't crash app in prod if not configured; calling code can handle
  console.warn('[mailer] SENDGRID_API_KEY not set; emails will be skipped')
} else {
  sg.setApiKey(API_KEY)
}
// Without this a hung SendGrid request holds the caller open indefinitely.
try {
  sg.client.setDefaultRequest('timeout', TIMEOUT_PROFILES.mutation.requestMs)
} catch (e) {
  console.warn('[mailer] could not set SendGrid request timeout:', e?.message || e)
}

const FROM = process.env.SENDGRID_FROM || 'no-reply@yourdomain.com'
const PUBLIC_SITE_BASE = String(process.env.PUBLIC_SITE_BASE || process.env.PUBLIC_SITE_BASE_FALLBACK || 'https://www.alphasourceai.com').trim().replace(/\/+$/, '')
const BRAND_LOGO_URL = process.env.BRANDED_EMAIL_LOGO_URL || `${PUBLIC_SITE_BASE}/logo-dark-text-clear.png`
const DEFAULT_HELP_EMAIL = process.env.BRANDED_EMAIL_HELP_EMAIL || 'info@alphasourceai.com'
const ALPHASCREEN_WELCOME_PLAYBOOK_PATH = path.join(__dirname, '..', '..', 'templates', 'email-attachments', 'alphascreen-getting-started-playbook.pdf')
const ALPHASCREEN_WELCOME_PLAYBOOK_FILENAME = 'alphaScreen Getting Started Playbook.pdf'

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeLegacyContentStyles(value) {
  return String(value || '')
    .replace(/#A78BFA/gi, '#A380F6')
    .replace(/#CFCBFF/gi, '#D7CBFB')
    .replace(/#C9D3FF/gi, '#46527C')
    .replace(/#E6EBFF/gi, '#0A1547')
    .replace(/#9FB0FF/gi, '#5C6A98')
    .replace(/#6B77C9/gi, '#6A76A2')
    .replace(/#FFFFFF/gi, '#4E40A5')
    .replace(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\.10\s*\)/gi, 'rgba(10,21,71,0.12)')
}

function formatTimestampAsCst(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(parsed)
  const partValue = (type) => parts.find((part) => part.type === type)?.value || ''
  const month = partValue('month')
  const day = partValue('day')
  const year = partValue('year')
  const hour24 = Number(partValue('hour'))
  const minute = partValue('minute')
  if (!month || !day || !year || !Number.isFinite(hour24) || !minute) return raw
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return `${month}-${day}-${year} ${String(hour12).padStart(2, '0')}:${minute} CST`
}

function buildAlphaScreenWelcomePlaybookAttachment(filePath = ALPHASCREEN_WELCOME_PLAYBOOK_PATH, logger = console) {
  try {
    const content = fs.readFileSync(filePath)
    return {
      content: content.toString('base64'),
      type: 'application/pdf',
      filename: ALPHASCREEN_WELCOME_PLAYBOOK_FILENAME,
      disposition: 'attachment'
    }
  } catch (error) {
    logger.warn?.('[mailer] alphascreen_welcome_playbook_attachment_missing', {
      attachment_missing: true,
      filename: ALPHASCREEN_WELCOME_PLAYBOOK_FILENAME,
      reason: error?.code === 'ENOENT' ? 'not_found' : 'read_failed'
    })
    return null
  }
}

function buildBrandedEmailShell({
  title,
  preheader = '',
  contentHtml = '',
  helpEmail = DEFAULT_HELP_EMAIL,
  footerNote = ''
} = {}) {
  const safeTitle = escapeHtml(title || '')
  const safePreheader = escapeHtml(preheader || '')
  const safeLogoUrl = escapeHtml(BRAND_LOGO_URL)
  const normalizedContentHtml = normalizeLegacyContentStyles(contentHtml || '')
  const safeHelpEmail = String(helpEmail || '').trim()
  const safeFooterNote = String(footerNote || '').trim()
  const footerParts = []
  if (safeHelpEmail) {
    const safeHelp = escapeHtml(safeHelpEmail)
    footerParts.push(`Need help? Email <a href="mailto:${safeHelp}" style="color:#A380F6;font-weight:700;">${safeHelp}</a>`)
  }
  if (safeFooterNote) footerParts.push(escapeHtml(safeFooterNote))
  const footerHtml = footerParts.length
    ? `
      <tr>
        <td style="border-top:1px solid rgba(10,21,71,0.12);padding-top:14px;color:#6A76A2;font-size:13px;line-height:1.55;">
          ${footerParts.map((part, index) => `<div style="${index > 0 ? 'margin-top:8px;' : ''}">${part}</div>`).join('')}
        </td>
      </tr>
    `
    : ''
  return `
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="color-scheme" content="light" />
      <meta name="supported-color-schemes" content="light" />
      <title>${safeTitle}</title>
      <style>
        body { margin: 0; padding: 0; background: #F8F9FD; color: #0A1547; font-family: Raleway, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        table { border-collapse: collapse; }
        a { color: #4E40A5; text-decoration: none; }
        p { margin: 0 0 12px; color: #0A1547; font-size: 15px; line-height: 1.65; }
        ul { margin: 0 0 12px; padding: 0; }
        li { color: #46527C; font-size: 14px; line-height: 1.55; }
        .cta {
          display: inline-block;
          background: #A380F6;
          color: #FFFFFF !important;
          border: 1px solid #8E6EE0;
          border-radius: 12px;
          padding: 11px 18px;
          font-size: 14px;
          font-weight: 700;
          line-height: 1;
        }
        @media (max-width: 640px) {
          .container { width: 100% !important; padding: 16px !important; }
          .card { padding: 18px !important; }
          .cta { display: block !important; width: 100% !important; text-align: center !important; box-sizing: border-box !important; }
        }
      </style>
    </head>
    <body>
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        ${safePreheader}
      </div>
      <table role="presentation" width="100%" style="background:#F8F9FD;color:#33416D;">
        <tr>
          <td align="center" style="padding: 24px 16px;">
            <table role="presentation" width="100%" class="container" style="max-width: 640px;">
              <tr>
                <td>
                  <table role="presentation" width="100%" class="card" style="background:#F8F9FD;color:#0A1547;border:0;border-radius:0;box-shadow:none;padding:24px;">
                    <tr>
                      <td align="left" style="padding-bottom:16px;">
                        <img src="${safeLogoUrl}" alt="AlphaSource" width="208" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:100%;" />
                      </td>
                    </tr>
                    <tr>
                      <td style="color:#0A1547;font-size:24px;line-height:1.25;font-weight:700;padding-bottom:10px;">
                        ${safeTitle}
                      </td>
                    </tr>
                    <tr>
                      <td style="color:#0A1547;">
                        ${normalizedContentHtml}
                      </td>
                    </tr>
                    ${footerHtml}
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `
}

async function sendInvite(to, acceptUrl, inviterEmail) {
  if (!API_KEY) return { skipped: true }
  const safeAcceptUrl = escapeHtml(String(acceptUrl || '').trim())
  const safeInviterEmail = escapeHtml(inviterEmail || '')
  const msg = {
    to,
    from: FROM,
    subject: 'You’ve been invited to Interview Agent',
    html: buildBrandedEmailShell({
      title: 'You’re invited to Interview Agent',
      preheader: 'Accept your invite to join your client account.',
      contentHtml: `
        <p style="margin:0 0 12px;color:#C9D3FF;font-size:15px;line-height:1.6;">
          You’ve been invited to join a client account on Interview Agent.
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeAcceptUrl}" target="_blank" rel="noopener noreferrer">
            Accept your invite
          </a>
        </p>
        ${safeInviterEmail ? `<p style="margin:0 0 12px;color:#C9D3FF;font-size:14px;line-height:1.55;">Invited by: <strong>${safeInviterEmail}</strong></p>` : ''}
        <p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">
          This link will sign you in and associate your account with the correct client.
        </p>
      `
    }),
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendSubscriptionCheckoutEmail(to, checkoutUrl, recipientName) {
  if (!API_KEY) return { skipped: true }
  const safeCheckoutUrl = escapeHtml(String(checkoutUrl || '').trim())
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const msg = {
    to,
    from: FROM,
    subject: 'Complete your alphaScreen membership',
    html: buildBrandedEmailShell({
      title: 'Complete your alphaScreen membership',
      preheader: 'Complete your secure membership checkout to activate your account.',
      helpEmail: 'info@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">
          Your membership setup is almost complete. Use the button below to finish secure checkout and activate your account.
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeCheckoutUrl}" target="_blank" rel="noopener noreferrer">
            Complete membership checkout
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the button doesn’t work, <a href="${safeCheckoutUrl}" target="_blank" rel="noopener noreferrer">click here</a> to complete your membership checkout.
        </p>
      `
    }),
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendRoleInterviewLimitReachedEmail(to, billingUrl, recipientName, roleTitle) {
  if (!API_KEY) return { skipped: true }
  const safeBillingUrl = escapeHtml(String(billingUrl || '').trim())
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const roleTitleText = String(roleTitle || 'This role').trim() || 'This role'
  const safeRoleTitle = escapeHtml(roleTitleText)
  const msg = {
    to,
    from: FROM,
    subject: `${roleTitleText} has no interviews remaining`,
    html: buildBrandedEmailShell({
      title: 'Interview capacity required',
      preheader: 'A role has reached zero remaining interview capacity.',
      helpEmail: 'info@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          <strong>${safeRoleTitle}</strong> has no interviews remaining.
        </p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">
          Additional interview capacity is required before new interviews can start.
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeBillingUrl}" target="_blank" rel="noopener noreferrer">
            Open billing
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the button doesn’t work, <a href="${safeBillingUrl}" target="_blank" rel="noopener noreferrer">click here</a> to open billing.
        </p>
      `
    }),
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMemberRecoveryEmail(to, recoveryUrl, recipientName) {
  if (!API_KEY) return { skipped: true }
  const safeRecoveryUrl = escapeHtml(String(recoveryUrl || '').trim())
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const msg = {
    to,
    from: FROM,
    subject: 'Set or reset your alphaScreen password',
    html: buildBrandedEmailShell({
      title: 'Set or reset your password',
      preheader: 'Use this secure link to set or reset your account password.',
      helpEmail: 'info@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">
          Use the secure link below to finish account setup and access your dashboard.
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeRecoveryUrl}" target="_blank" rel="noopener noreferrer">
            Set password
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the button doesn’t work, <a href="${safeRecoveryUrl}" target="_blank" rel="noopener noreferrer">click here</a> to set your password.
        </p>
      `
    })
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendAlphaScreenWelcomeEmail(to, details = {}) {
  if (!API_KEY) return { skipped: true }
  const firstNameRaw = String(details.firstName || details.first_name || details.recipientName || details.recipient_name || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const helpEmail = String(details.helpEmail || details.help_email || DEFAULT_HELP_EMAIL).trim() || DEFAULT_HELP_EMAIL
  const safeEmail = escapeHtml(String(to || '').trim())
  const safeHelpEmail = escapeHtml(helpEmail)
  const clientId = cleanEmailText(details.clientId || details.client_id)
  const agreementId = cleanEmailText(details.agreementId || details.agreement_id)
  const purchaseIntentId = cleanEmailText(details.purchaseIntentId || details.purchase_intent_id)
  const playbookAttachment = buildAlphaScreenWelcomePlaybookAttachment(
    details.playbookAttachmentPath || details.playbook_attachment_path || ALPHASCREEN_WELCOME_PLAYBOOK_PATH,
    details.logger || console
  )
  const msg = {
    to,
    from: FROM,
    subject: 'Welcome to alphaScreen',
    html: buildBrandedEmailShell({
      title: 'Welcome to alphaScreen',
      preheader: 'Your alphaScreen membership is active and account setup is being prepared.',
      helpEmail,
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          Thank you for signing up for alphaScreen. I appreciate you trusting alphaSource with your candidate screening workflow.
        </p>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          Your membership is now active, and your account setup is being prepared. The next step is to set your password using the setup email we send to ${safeEmail}.
        </p>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          After that, you can sign in, create your first role, review the AI-generated screening questions, make any edits you want, and start inviting candidates.
        </p>
        <p style="margin:0 0 8px;font-size:15px;line-height:1.6;">A few helpful starting points:</p>
        <ul style="margin:0 0 14px;padding:0;">
          <li style="margin:0 0 6px 18px;">Start with one role so you can get familiar with the workflow before adding more.</li>
          <li style="margin:0 0 6px 18px;">Review the AI-generated screening questions before inviting candidates.</li>
          <li style="margin:0 0 6px 18px;">Use the FAQ if you need help with setup, candidate links, memberships, billing, or interview limits.</li>
          <li style="margin:0 0 6px 18px;">The attached alphaScreen playbook walks through the recommended getting-started flow.</li>
        </ul>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          Need help? Email us at <a href="mailto:${safeHelpEmail}">${safeHelpEmail}</a> and we will help you get set up.
        </p>
        <p style="margin:0 0 2px;font-size:15px;line-height:1.6;">Thank you again,</p>
        <p style="margin:0;font-size:15px;line-height:1.6;">Jason Gardner<br />alphaSource</p>
      `
    }),
    categories: ['public_purchase_welcome'],
    customArgs: {
      email_category: 'public_purchase_welcome',
      client_id: clientId,
      agreement_id: agreementId,
      purchase_intent_id: purchaseIntentId
    }
  }
  if (playbookAttachment) msg.attachments = [playbookAttachment]
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementEmail(to, signingUrl, details = {}) {
  if (!API_KEY) return { skipped: true }
  const safeSigningUrl = escapeHtml(String(signingUrl || '').trim())
  const clientLegalNameText = String(details.clientLegalName || details.client_legal_name || 'Your organization')
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || 'Your organization')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeMembershipTier = escapeHtml(details.membershipTier || details.membership_tier || '')
  const formattedExpiresOn = formatTimestampAsCst(details.expiresOn || details.expires_on || '')
  const safeExpiresOn = escapeHtml(formattedExpiresOn)
  const greeting = safePrimaryAdmin ? `Hi ${safePrimaryAdmin},` : 'Hi there,'

  const msg = {
    to,
    from: FROM,
    subject: 'Review and sign your alphaScreen Membership Agreement',
    html: buildBrandedEmailShell({
      title: 'alphaScreen Membership Agreement',
      preheader: `Your membership agreement for ${clientLegalNameText} is ready for signature.`,
      helpEmail: 'memberships@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          ${escapeHtml(greeting)}
        </p>
        <p style="margin:0 0 10px;font-size:15px;line-height:1.6;">
          Your membership agreement for <strong>${safeClientLegalName}</strong> is ready for signature.
        </p>
        ${safeMembershipTier ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;">Membership tier: <strong>${safeMembershipTier}</strong></p>` : ''}
        ${safeExpiresOn ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;">Signing link expires on: <strong>${safeExpiresOn}</strong></p>` : ''}
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeSigningUrl}" target="_blank" rel="noopener noreferrer">
            Review and sign agreement
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the button doesn’t work, <a href="${safeSigningUrl}" target="_blank" rel="noopener noreferrer">click here</a> to open the agreement.
        </p>
      `
    })
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendRetailSignupEmailVerificationCode(to, code, details = {}) {
  if (!API_KEY) return { skipped: true }
  const rawCode = String(code || '').trim()
  const safeCode = escapeHtml(rawCode)
  const purchaseIntentId = String(details.purchaseIntentId || details.purchase_intent_id || '').trim()
  const verificationId = String(details.verificationId || details.verification_id || '').trim()
  const msg = {
    to,
    from: FROM,
    subject: 'Your alphaScreen verification code',
    text: `Use this one-time code to verify your email and continue your alphaScreen membership signup: ${rawCode}\n\nThis code expires in 10 minutes. If you did not request it, you can ignore this email.`,
    html: buildBrandedEmailShell({
      title: 'Verify your alphaScreen email',
      preheader: 'Use your one-time code to continue your alphaScreen membership signup.',
      helpEmail: 'memberships@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">
          Use this one-time code to verify your email and continue your alphaScreen membership signup:
        </p>
        <p style="margin:0 0 16px;">
          <span style="display:inline-block;background:#F8F9FD;color:#0A1547;border:1px solid #A380F6;border-radius:8px;padding:10px 16px;font-size:22px;font-weight:800;letter-spacing:0.22em;">
            ${safeCode}
          </span>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          This code expires in 10 minutes. If you did not request it, you can ignore this email.
        </p>
      `
    }),
    categories: ['retail_signup_email_verification'],
    customArgs: {
      email_category: 'retail_signup_email_verification',
      purchase_intent_id: purchaseIntentId,
      verification_id: verificationId
    }
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementInternalNotification(to, details = {}) {
  if (!API_KEY) return { skipped: true }

  const safeAgreementId = escapeHtml(details.agreementId || details.agreement_id || '')
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || '')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeAdminEmail = escapeHtml(details.adminEmail || details.admin_email || '')
  const safeMembershipTier = escapeHtml(details.membershipTier || details.membership_tier || '')
  const safeBillingOption = escapeHtml(details.billingOption || details.billing_option || '')
  const detailItems = [
    safeAgreementId ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Agreement ID:</strong> ${safeAgreementId}</li>` : '',
    safeClientLegalName ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Client:</strong> ${safeClientLegalName}</li>` : '',
    safePrimaryAdmin ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Primary Admin:</strong> ${safePrimaryAdmin}</li>` : '',
    safeAdminEmail ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Admin Email:</strong> ${safeAdminEmail}</li>` : '',
    safeMembershipTier ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Membership Tier:</strong> ${safeMembershipTier}</li>` : '',
    safeBillingOption ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Billing Option:</strong> ${safeBillingOption}</li>` : ''
  ].filter(Boolean).join('')

  const msg = {
    to,
    from: FROM,
    subject: 'Membership agreement sent - client checkout follows signature',
    html: buildBrandedEmailShell({
      title: 'Membership agreement sent',
      preheader: 'Membership agreement sent - client continues to checkout after signature.',
      helpEmail: '',
      footerNote: 'Internal notification for the memberships workflow.',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          A membership agreement has been sent.
        </p>
        <ul style="margin:0 0 14px;padding:0;">
          ${detailItems || '<li style="margin:0 0 6px 18px;font-size:13px;line-height:1.5;">No agreement details provided.</li>'}
        </ul>
        <p style="margin:0 0 14px;font-size:14px;line-height:1.55;">
          After signing, the client can continue directly to checkout from the signature flow.
        </p>
      `
    })
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementSignedCopyEmail(to, details = {}) {
  if (!API_KEY) return { skipped: true }
  const safeExecutedPdfUrl = escapeHtml(String(details.executedPdfUrl || details.executed_pdf_url || '').trim())
  const clientLegalNameText = String(details.clientLegalName || details.client_legal_name || 'Your organization')
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || 'Your organization')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeSignerTypedName = escapeHtml(details.signerTypedName || details.signer_typed_name || '')
  const safeSignedAt = escapeHtml(details.signedAt || details.signed_at || '')
  const pdfBase64 = String(details.pdfBase64 || details.pdf_base64 || '').trim()
  const fileName = String(details.fileName || details.file_name || 'membership-agreement-signed.pdf').trim() || 'membership-agreement-signed.pdf'
  const greeting = safePrimaryAdmin ? `Hi ${safePrimaryAdmin},` : 'Hi there,'

  const msg = {
    to,
    from: FROM,
    subject: 'Your signed alphaScreen Membership Agreement',
    html: buildBrandedEmailShell({
      title: 'Signed Membership Agreement',
      preheader: `Your signed agreement for ${clientLegalNameText} is attached.`,
      helpEmail: 'memberships@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          ${escapeHtml(greeting)}
        </p>
        <p style="margin:0 0 10px;font-size:15px;line-height:1.6;">
          Your signed agreement for <strong>${safeClientLegalName}</strong> is attached.
        </p>
        ${safeSignerTypedName ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;">Signed by: <strong>${safeSignerTypedName}</strong></p>` : ''}
        ${safeSignedAt ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;">Signed at: <strong>${safeSignedAt}</strong></p>` : ''}
        ${safeExecutedPdfUrl ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.55;">Secure copy link: <a href="${safeExecutedPdfUrl}" target="_blank" rel="noopener noreferrer">Open signed agreement</a></p>` : ''}
      `
    })
  }

  if (pdfBase64) {
    msg.attachments = [
      {
        content: pdfBase64,
        type: 'application/pdf',
        filename: fileName,
        disposition: 'attachment'
      }
    ]
  }

  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementCompletedInternalNotification(to, details = {}) {
  if (!API_KEY) return { skipped: true }

  const safeAgreementId = escapeHtml(details.agreementId || details.agreement_id || '')
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || '')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeAdminEmail = escapeHtml(details.adminEmail || details.admin_email || '')
  const safeSignerTypedName = escapeHtml(details.signerTypedName || details.signer_typed_name || '')
  const safeSignedAt = escapeHtml(details.signedAt || details.signed_at || '')
  const detailItems = [
    safeAgreementId ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Agreement ID:</strong> ${safeAgreementId}</li>` : '',
    safeClientLegalName ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Client:</strong> ${safeClientLegalName}</li>` : '',
    safePrimaryAdmin ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Primary Admin:</strong> ${safePrimaryAdmin}</li>` : '',
    safeAdminEmail ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Admin Email:</strong> ${safeAdminEmail}</li>` : '',
    safeSignerTypedName ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Signer:</strong> ${safeSignerTypedName}</li>` : '',
    safeSignedAt ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Signed At:</strong> ${safeSignedAt}</li>` : ''
  ].filter(Boolean).join('')

  const msg = {
    to,
    from: FROM,
    subject: 'Membership agreement signed - client checkout ready',
    html: buildBrandedEmailShell({
      title: 'Membership agreement signed',
      preheader: 'Membership agreement signed - client can continue to checkout from the signature success page.',
      helpEmail: '',
      footerNote: 'Internal notification for the memberships workflow.',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          A membership agreement has been signed.
        </p>
        <ul style="margin:0 0 14px;padding:0;">
          ${detailItems || '<li style="margin:0 0 6px 18px;font-size:13px;line-height:1.5;">No agreement details provided.</li>'}
        </ul>
        <p style="margin:0 0 14px;font-size:14px;line-height:1.55;">
          The client can continue directly to checkout from the signature success page, and payment onboarding continues through the client checkout flow.
        </p>
      `
    })
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

function cleanEmailText(value, fallback = '') {
  return String(value || fallback || '').replace(/[\r\n]+/g, ' ').trim()
}

function cleanFirstName(value) {
  const firstNameRaw = String(value || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  return firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
}

async function sendSecondRoundSchedulingEmail(to, details = {}) {
  if (!API_KEY) return { skipped: true }
  const schedulingUrl = String(details.schedulingUrl || details.scheduling_url || '').trim()
  const roleTitleText = cleanEmailText(details.roleTitle || details.role_title, 'the role')
  const candidateFirstName = cleanFirstName(details.candidateName || details.candidate_name)
  const greeting = /[A-Za-z0-9]/.test(candidateFirstName) ? `Hi ${candidateFirstName},` : 'Hi,'
  const schedulingLabelText = cleanEmailText(
    details.schedulingLabel || details.scheduling_label,
    'Schedule next step'
  )
  const hiringManagerName = cleanEmailText(details.hiringManagerName || details.hiring_manager_name)
  const safeSchedulingUrl = escapeHtml(schedulingUrl)
  const safeRoleTitle = escapeHtml(roleTitleText)
  const safeSchedulingLabel = escapeHtml(schedulingLabelText || 'Schedule next step')
  const safeHiringManagerName = escapeHtml(hiringManagerName)
  const actionId = cleanEmailText(details.automationActionId || details.automation_action_id)
  const clientId = cleanEmailText(details.clientId || details.client_id)
  const roleId = cleanEmailText(details.roleId || details.role_id)
  const candidateId = cleanEmailText(details.candidateId || details.candidate_id)
  const subjectRoleTitle = roleTitleText === 'the role' ? 'your opportunity' : roleTitleText
  const subject = `Next step for ${subjectRoleTitle}`
  const text = [
    greeting,
    '',
    `The hiring team would like to invite you to schedule the next step for the ${roleTitleText} opportunity.`,
    '',
    'Please use the link below to choose a time:',
    schedulingUrl,
    '',
    'If the time options do not work for you, please contact the hiring team directly.'
  ].join('\n')

  const msg = {
    to,
    from: FROM,
    subject,
    text,
    html: buildBrandedEmailShell({
      title: 'Schedule your next step',
      preheader: `Schedule the next step for the ${roleTitleText} opportunity.`,
      helpEmail: 'info@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
          The hiring team would like to invite you to schedule the next step for the <strong>${safeRoleTitle}</strong> opportunity.
        </p>
        ${safeHiringManagerName ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;">Contact: <strong>${safeHiringManagerName}</strong></p>` : ''}
        <p style="margin:0 0 10px;font-size:15px;line-height:1.6;">
          Please use the link below to choose a time:
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeSchedulingUrl}" target="_blank" rel="noopener noreferrer">
            ${safeSchedulingLabel}
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the time options do not work for you, please contact the hiring team directly.
        </p>
      `
    }),
    categories: ['candidate_second_round_scheduling'],
    customArgs: {
      email_category: 'candidate_second_round_scheduling',
      automation_action_id: actionId,
      client_id: clientId,
      role_id: roleId,
      candidate_id: candidateId
    }
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendPendingApprovalDigestEmail(to, details = {}) {
  if (!API_KEY) return { skipped: true }
  const actions = Array.isArray(details.actions) ? details.actions : []
  const actionCount = Math.max(0, Number(details.digestActionCount || details.digest_action_count || actions.length) || 0)
  const recipientFirstName = cleanFirstName(details.recipientName || details.recipient_name)
  const greeting = /[A-Za-z0-9]/.test(recipientFirstName) ? `Hi ${recipientFirstName},` : 'Hi,'
  const clientId = cleanEmailText(details.clientId || details.client_id)
  const roleId = cleanEmailText(details.roleId || details.role_id)
  const digestApprovalUrl = String(details.digestApprovalUrl || details.digest_approval_url || '').trim()
  const hasDigestApprovalUrl = Boolean(digestApprovalUrl)
  const safeDigestApprovalUrl = escapeHtml(digestApprovalUrl)
  const rows = actions.map((action, index) => {
    const candidateName = cleanEmailText(action.candidateName || action.candidate_name, 'Candidate')
    const roleTitle = cleanEmailText(action.roleTitle || action.role_title, 'Role')
    const approvalUrl = String(action.approvalUrl || action.approval_url || '').trim()
    const safeCandidateName = escapeHtml(candidateName)
    const safeRoleTitle = escapeHtml(roleTitle)
    const safeApprovalUrl = escapeHtml(approvalUrl)
    return `
      <tr>
        <td style="padding:14px 0;border-top:${index === 0 ? '0' : '1px solid rgba(10,21,71,0.12)'};">
          <p style="margin:0 0 4px;font-size:15px;line-height:1.45;font-weight:700;">${safeCandidateName}</p>
          <p style="margin:0${hasDigestApprovalUrl ? '' : ' 0 10px'};font-size:13px;line-height:1.5;color:#46527C;">${safeRoleTitle}</p>
          ${hasDigestApprovalUrl ? '' : `<p style="margin:0;">
            <a class="cta" href="${safeApprovalUrl}" target="_blank" rel="noopener noreferrer">
              Review approval
            </a>
          </p>`}
        </td>
      </tr>
    `
  }).join('')
  const text = hasDigestApprovalUrl ? [
    greeting,
    '',
    `${actionCount} candidate automation approval${actionCount === 1 ? '' : 's'} need review.`,
    'Open the review page to approve or decline each candidate.',
    'Approving a candidate sends the second-round scheduling email.',
    '',
    digestApprovalUrl,
    '',
    ...actions.flatMap((action, index) => [
      `${index + 1}. ${cleanEmailText(action.candidateName || action.candidate_name, 'Candidate')} - ${cleanEmailText(action.roleTitle || action.role_title, 'Role')}`,
      ''
    ])
  ].join('\n') : [
    greeting,
    '',
    `${actionCount} candidate automation approval${actionCount === 1 ? '' : 's'} need review.`,
    'Candidates matched configured automation rules. Review is required before any candidate-facing scheduling email is sent.',
    '',
    ...actions.flatMap((action, index) => [
      `${index + 1}. ${cleanEmailText(action.candidateName || action.candidate_name, 'Candidate')} - ${cleanEmailText(action.roleTitle || action.role_title, 'Role')}`,
      String(action.approvalUrl || action.approval_url || '').trim(),
      ''
    ])
  ].join('\n')

  const msg = {
    to,
    from: FROM,
    subject: 'Candidate automation approvals needed',
    text,
    html: buildBrandedEmailShell({
      title: 'Candidate automation approvals needed',
      preheader: `${actionCount} candidate automation approval${actionCount === 1 ? '' : 's'} need review.`,
      helpEmail: 'info@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          ${actionCount} candidate automation approval${actionCount === 1 ? '' : 's'} need review.
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          ${hasDigestApprovalUrl
            ? 'Open the review page to approve or decline each candidate. Approving a candidate sends the second-round scheduling email.'
            : 'Candidates matched configured automation rules. Review is required before any candidate-facing scheduling email is sent.'}
        </p>
        ${hasDigestApprovalUrl ? `<p style="margin:0 0 18px;">
          <a class="cta" href="${safeDigestApprovalUrl}" target="_blank" rel="noopener noreferrer">
            Review candidates
          </a>
        </p>` : ''}
        <table role="presentation" width="100%" style="border-collapse:collapse;">
          ${rows}
        </table>
      `
    }),
    categories: ['automation_pending_approval_digest'],
    customArgs: {
      email_category: 'automation_pending_approval_digest',
      client_id: clientId,
      role_id: roleId,
      digest_action_count: String(actionCount)
    }
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

module.exports = {
  escapeHtml,
  buildBrandedEmailShell,
  sendInvite,
  sendSubscriptionCheckoutEmail,
  sendRoleInterviewLimitReachedEmail,
  sendMemberRecoveryEmail,
  sendAlphaScreenWelcomeEmail,
  sendMembershipAgreementEmail,
  sendRetailSignupEmailVerificationCode,
  sendMembershipAgreementInternalNotification,
  sendMembershipAgreementSignedCopyEmail,
  sendMembershipAgreementCompletedInternalNotification,
  sendSecondRoundSchedulingEmail,
  sendPendingApprovalDigestEmail
}
