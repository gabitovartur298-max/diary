import { callTelegramApi, safeEqualStrings } from '../lib/telegram.js';
import { applyStarPayment, resolvePlanFromPayment } from '../lib/subscriptions.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function getAppUrl(req) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return host ? `https://${host}` : '';
}

export default async function handler(req, res) {
  if (!process.env.BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'BOT_TOKEN is not configured' });
  }

  const appUrl = getAppUrl(req);

  // 1. Защищённая установка вебхука:
  // GET /api/bot?setup=1&secret=ВАШ_SETUP_SECRET
  if (req.method === 'GET') {
    if (req.query?.setup === '1') {
      const setupSecret = process.env.SETUP_SECRET;
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

      if (!setupSecret || !webhookSecret) {
        return res.status(500).json({
          ok: false,
          error: 'Задайте SETUP_SECRET и TELEGRAM_WEBHOOK_SECRET в настройках Vercel'
        });
      }

      const providedSecret = Array.isArray(req.query.secret)
        ? req.query.secret[0]
        : String(req.query.secret || '');

      if (!safeEqualStrings(providedSecret, setupSecret)) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }

      const webhookUrl = `${appUrl}/api/bot`;
      const result = await callTelegramApi('setWebhook', {
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ['message', 'pre_checkout_query']
      });

      return res.status(result.ok ? 200 : 502).json({
        ok: result.ok,
        message: result.ok
          ? 'Вебхук подключён с secret_token! /start, /paysupport и Telegram Stars готовы.'
          : 'Ошибка подключения вебхука',
        webhookUrl,
        warning: process.env.APP_URL ? undefined : 'Рекомендуется задать APP_URL в переменных Vercel',
        telegramResponse: result.data
      });
    }

    return res.status(200).json({ ok: true, status: 'Bot endpoint is running' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // 2. Обязательная проверка секрета вебхука от серверов Telegram
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error('[bot] TELEGRAM_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ ok: false, error: 'Webhook secret not configured' });
  }

  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  const secretStr = Array.isArray(incomingSecret) ? incomingSecret[0] : String(incomingSecret || '');
  if (!safeEqualStrings(secretStr, expectedSecret)) {
    return res.status(403).json({ ok: false, error: 'Invalid webhook secret' });
  }

  const body = parseBody(req);

  // 3. Проверка платежа Telegram Stars перед списанием (ответ должен уйти < 10 сек)
  if (body.pre_checkout_query) {
    const query = body.pre_checkout_query;
    const plan =
      query.currency === 'XTR'
        ? resolvePlanFromPayment(query.invoice_payload, query.total_amount)
        : null;

    try {
      await callTelegramApi('answerPreCheckoutQuery', plan
        ? { pre_checkout_query_id: query.id, ok: true }
        : {
            pre_checkout_query_id: query.id,
            ok: false,
            error_message: 'Неверный тариф или сумма оплаты. Попробуйте открыть счёт заново.'
          });
    } catch (err) {
      console.error('[bot] pre_checkout_query error:', err);
    }

    return res.status(200).json({ ok: true });
  }

  const message = body.message;
  if (!message) {
    return res.status(200).json({ ok: true });
  }

  // 4. Подтверждённая оплата Telegram Stars — начисляем подписку в БД
  if (message.successful_payment) {
    const sp = message.successful_payment;
    const telegramUserId = message.from?.id || message.chat?.id;
    const plan =
      sp.currency === 'XTR'
        ? resolvePlanFromPayment(sp.invoice_payload, sp.total_amount)
        : null;

    if (!telegramUserId || !plan || !sp.telegram_payment_charge_id) {
      console.error('[bot] Unrecognized successful_payment:', {
        telegramUserId,
        currency: sp.currency,
        totalAmount: sp.total_amount,
        payload: sp.invoice_payload
      });
      return res.status(200).json({ ok: true });
    }

    try {
      const result = await applyStarPayment({
        chargeId: sp.telegram_payment_charge_id,
        userId: `tg_${telegramUserId}`,
        planId: plan.id,
        starsAmount: plan.stars,
        daysAdded: plan.days,
        invoicePayload: sp.invoice_payload
      });

      if (!result.duplicate && message.chat?.id) {
        const expDate = result.subscription.expiresAtMs
          ? new Date(result.subscription.expiresAtMs).toLocaleDateString('ru-RU')
          : '';
        try {
          await callTelegramApi('sendMessage', {
            chat_id: message.chat.id,
            text: `⭐ Оплата ${plan.stars} Stars прошла успешно!\nПодписка PRO продлена на ${plan.days} дн. (активна до ${expDate}).\n\nОткройте дневник — экспорт PDF и точное время уже доступны.`,
            reply_markup: appUrl
              ? { inline_keyboard: [[{ text: 'Открыть дневник', web_app: { url: appUrl } }]] }
              : undefined
          });
        } catch (notifyErr) {
          console.warn('[bot] Failed to send payment receipt message:', notifyErr);
        }
      }

      return res.status(200).json({ ok: true });
    } catch (dbErr) {
      // Возвращаем 500 ТОЛЬКО при сбое БД, чтобы Telegram повторил доставку оплаты
      console.error('[bot] Failed to persist Star payment:', dbErr);
      return res.status(500).json({ ok: false, error: 'Database error' });
    }
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const chatId = message.chat?.id;

  if (!chatId || !text) {
    return res.status(200).json({ ok: true });
  }

  try {
    // 5. Команда /start
    if (/^\/start(@\w+)?(\s|$)/i.test(text)) {
      await callTelegramApi('sendMessage', {
        chat_id: chatId,
        text: 'Привет! Чтобы открыть приложение, нажмите кнопку «Открыть дневник» ниже.\n\nПо вопросам оплаты и подписок используйте команду /paysupport.\nЗдоровья и удачи!',
        reply_markup: appUrl
          ? {
              inline_keyboard: [
                [{ text: 'Открыть дневник', web_app: { url: appUrl } }]
              ]
            }
          : undefined
      });
      return res.status(200).json({ ok: true });
    }

    // 6. Обязательная по правилам Telegram Stars команда /paysupport
    if (/^\/paysupport(@\w+)?(\s|$)/i.test(text)) {
      const supportContact = process.env.SUPPORT_CONTACT || 'поддержку через описание бота';
      await callTelegramApi('sendMessage', {
        chat_id: chatId,
        text: `Поддержка по оплатам Telegram Stars:\n\nЕсли подписка PRO не активировалась сразу после оплаты, просто переоткройте Mini App — статус синхронизируется с сервером автоматически.\n\nПо вопросам возврата и сбоев оплаты напишите в ${supportContact} и укажите ваш Telegram ID: ${message.from?.id || chatId}.`
      });
      return res.status(200).json({ ok: true });
    }
  } catch (err) {
    // Не возвращаем 500 на обычных командах (например, если юзер заблокировал бота), чтобы избежать retry-шторма
    console.warn('[bot] Command response warning:', err);
  }

  return res.status(200).json({ ok: true });
}
