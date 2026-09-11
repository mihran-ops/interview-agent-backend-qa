'use strict';

const GSM_7_BASIC = new Set(Array.from(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
));
const GSM_7_EXTENSION = new Set(Array.from('\f^{}\\[~]|€'));

function analyzeSmsSegments(value) {
  const text = String(value ?? '');
  let septets = 0;
  let gsm7 = true;
  for (const character of text) {
    if (GSM_7_BASIC.has(character)) septets += 1;
    else if (GSM_7_EXTENSION.has(character)) septets += 2;
    else {
      gsm7 = false;
      break;
    }
  }
  if (gsm7) {
    return Object.freeze({
      encoding: 'GSM-7',
      units: septets,
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
      singleSegmentLimit: 160,
      multipartSegmentLimit: 153,
    });
  }
  const units = text.length;
  return Object.freeze({
    encoding: 'UCS-2',
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
    singleSegmentLimit: 70,
    multipartSegmentLimit: 67,
  });
}

function buildOtpSmsMessage({
  code,
  expiresAt,
  now = new Date(),
  brand = 'alphaScreen',
  complianceSuffix = '',
  maxSegments = 1,
} = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) throw new TypeError('code must be six digits');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(String(brand || ''))) throw new TypeError('brand is invalid');
  const expiryMs = Date.parse(String(expiresAt || ''));
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(expiryMs) || !Number.isFinite(nowMs) || expiryMs <= nowMs) {
    throw new TypeError('expiresAt must be in the future');
  }
  if (!Number.isInteger(maxSegments) || maxSegments < 1 || maxSegments > 3) throw new TypeError('maxSegments is invalid');
  const minutes = Math.max(1, Math.ceil((expiryMs - nowMs) / 60_000));
  const suffix = String(complianceSuffix || '').trim();
  const body = `${brand}: Your verification code is ${code}. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Do not share it.${suffix ? ` ${suffix}` : ''}`;
  const analysis = analyzeSmsSegments(body);
  if (analysis.segments > maxSegments) throw new RangeError('SMS message exceeds the accepted segment limit');
  return Object.freeze({ body, expiresAt: new Date(expiryMs).toISOString(), minutes, analysis });
}

module.exports = { analyzeSmsSegments, buildOtpSmsMessage };
