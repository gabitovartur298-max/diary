import crypto from 'node:crypto';

const DEFAULT_APP_URL = 'https://diary-nu-eosin.vercel.app';

export function getAppUrl() {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return DEFAULT_APP_URL;

  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return DEFAULT_APP_URL;
    }
    return configured;
  } catch {
    return DEFAULT_APP_URL;
  }
}

export function getTelegramWebhookSecret() {
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    return String(process.env.TELEGRAM_WEBHOOK_SECRET);
  }
  if (!process.env.BOT_TOKEN) return '';

  return crypto
    .createHmac('sha256', process.env.BOT_TOKEN)
    .update('symptom-diary-telegram-webhook-v1')
    .digest('hex');
}

export function isTelegramWebhookRequest(req) {
  const expected = getTelegramWebhookSecret();
  const header = req.headers['x-telegram-bot-api-secret-token'];
  const received = Array.isArray(header) ? header[0] : header;
  if (!expected || !received || typeof received !== 'string') return false;

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
