import { getAppUrl, getTelegramWebhookSecret } from '../lib/config.js';

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required to configure the Telegram webhook');
}

const webhookUrl = `${getAppUrl()}/api/bot`;
const secretToken = getTelegramWebhookSecret();
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secretToken)) {
  throw new Error('TELEGRAM_WEBHOOK_SECRET contains unsupported characters');
}

const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ['message', 'pre_checkout_query'],
    drop_pending_updates: false
  })
});
const data = await response.json().catch(() => null);
if (!response.ok || !data?.ok) {
  throw new Error('Telegram rejected the webhook configuration');
}

console.log(`Telegram webhook configured for ${webhookUrl}`);
