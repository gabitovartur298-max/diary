import { getAppUrl, isTelegramWebhookRequest } from '../lib/config.js';
import { ensureDatabaseSchema } from '../lib/db/index.js';
import { getPlanForTelegramPayment, processSuccessfulPayment } from '../lib/subscriptions.js';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } }
};

async function callTelegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(`TELEGRAM_${method.toUpperCase()}_FAILED`);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!process.env.BOT_TOKEN) {
    return res.status(503).json({ ok: false, error: 'Service temporarily unavailable' });
  }
  if (!isTelegramWebhookRequest(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    if (body.pre_checkout_query) {
      const query = body.pre_checkout_query;
      const userId = query.from?.id;
      const planKey = getPlanForTelegramPayment({
        invoice_payload: query.invoice_payload,
        total_amount: query.total_amount,
        currency: query.currency
      }, userId);

      await callTelegram('answerPreCheckoutQuery', planKey
        ? { pre_checkout_query_id: query.id, ok: true }
        : {
            pre_checkout_query_id: query.id,
            ok: false,
            error_message: 'Этот счёт недействителен. Создайте новый счёт в мини-приложении.'
          });
      return res.status(200).json({ ok: true });
    }

    if (body.message?.successful_payment) {
      const userId = body.message.from?.id;
      if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) {
        return res.status(200).json({ ok: true });
      }
      await ensureDatabaseSchema();
      const result = await processSuccessfulPayment(String(userId), body.message.successful_payment);
      if (!result.ok) console.error('Rejected an invalid successful payment update');
      return res.status(200).json({ ok: true });
    }

    if (typeof body.message?.text === 'string' && body.message.text.startsWith('/start')) {
      const chatId = body.message.chat?.id;
      if (Number.isSafeInteger(Number(chatId))) {
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'Привет! Чтобы попасть в приложение, нажимай на кнопку «Открыть дневник». Здоровья и удачи!',
          reply_markup: {
            inline_keyboard: [[{ text: 'Открыть дневник', web_app: { url: getAppUrl() } }]]
          }
        });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({ ok: false, error: 'Webhook processing temporarily unavailable' });
  }
}
