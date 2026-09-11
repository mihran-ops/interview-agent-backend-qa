'use strict';

const sg = require('@sendgrid/mail');
const { buildBrandedEmailShell, escapeHtml } = require('../clients/sendgrid');
const { markOtpChallengeDelivery } = require('./otpChallenge');

function buildOtpEmailHtml(appName, otpCode, context = {}) {
  const safeAppName = escapeHtml(appName || 'Interview Agent');
  const safeOtpCode = escapeHtml(otpCode || '');
  const safeIntro = escapeHtml(context.intro || `Use this one-time code to continue your ${safeAppName} verification.`);
  const safeLink = context.link ? escapeHtml(context.link) : '';
  return buildBrandedEmailShell({
    title: context.title || 'Your verification code',
    preheader: `Your verification code is ${safeOtpCode}. It expires in 10 minutes.`,
    contentHtml: `
      <p style="margin:0 0 14px;color:#C9D3FF;font-size:15px;line-height:1.6;">${safeIntro}</p>
      <p style="margin:0 0 16px;"><span style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:10px 16px;font-size:22px;font-weight:800;letter-spacing:0.22em;">${safeOtpCode}</span></p>
      <p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">This code expires in 10 minutes.</p>
      ${safeLink ? `<p style="margin:0;"><a href="${safeLink}" style="color:#CFCBFF;font-weight:700;">Open your interview</a></p>` : ''}
    `,
  });
}

function createEmailOtpDelivery({ env = process.env, send = null } = {}) {
  const apiKey = String(env.SENDGRID_API_KEY || '').trim();
  const from = String(env.SENDGRID_FROM || '').trim();
  const appName = String(env.APP_NAME || 'Interview Agent').trim();
  if (apiKey) sg.setApiKey(apiKey);
  const sendMessage = send || ((message) => sg.send(message));

  return async function deliverEmailOtp({ db, challengeId, destination, code, context = {} }) {
    if (!apiKey || !from) throw new Error('OTP email delivery is not configured');
    try {
      await sendMessage({
        to: destination,
        from: { email: from, name: appName },
        subject: context.subject || `Your ${appName} verification code`,
        text: `${context.textPrefix || 'Your verification code is'} ${code}. It expires in 10 minutes.${context.link ? ` ${context.link}` : ''}`,
        html: buildOtpEmailHtml(appName, code, context),
      });
      await markOtpChallengeDelivery(db, challengeId, 'sent');
      return { state: 'sent' };
    } catch (error) {
      await markOtpChallengeDelivery(db, challengeId, 'failed').catch(() => {});
      throw error;
    }
  };
}

const OTP_DELIVERY_CHANNELS = Object.freeze({
  email: 'enabled',
  sms: 'planned_not_enabled',
});

module.exports = { OTP_DELIVERY_CHANNELS, buildOtpEmailHtml, createEmailOtpDelivery };
