import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index.js';
import { ensureDatabaseSchema } from '../lib/db/ensure-schema.js';
import { promoCodes, symptomDiaryData } from '../lib/db/schema.js';
import { getHeader, readJsonBody, resolveAppUrl } from '../lib/http.js';
import { callTelegramApi, safeEqualStrings } from '../lib/telegram.js';
import { trackAnalyticsEvent, upsertBotUser } from '../lib/admin.js';
import {
  applyStarPayment,
  checkPromoCodeForUser,
  parsePaymentPayload,
  resolvePlanFromPayment,
  revokeStarPaymentRefund
} from '../lib/subscriptions.js';

function resolveLangFromCode(languageCode) {
  if (typeof languageCode !== 'string' || !languageCode.trim()) return 'ru';
  const norm = languageCode.trim().toLowerCase();
  return norm.startsWith('ru') || norm.startsWith('uk') || norm.startsWith('be') || norm.startsWith('kk')
    ? 'ru'
    : 'en';
}

async function getUserLocalePrefs(accountId, fallbackLanguageCode) {
  let lang = resolveLangFromCode(fallbackLanguageCode);
  let tzOffsetMinutes = lang === 'en' ? 0 : 180;
  try {
    await ensureDatabaseSchema();
    const rows = await db
      .select({ payload: symptomDiaryData.payload })
      .from(symptomDiaryData)
      .where(eq(symptomDiaryData.userId, accountId))
      .limit(1);
    const payload = rows[0]?.payload;
    if (payload && typeof payload === 'object') {
      if (payload.lang === 'en' || payload.lang === 'ru') {
        lang = payload.lang;
      }
      if (Number.isFinite(Number(payload.tzOffsetMinutes))) {
        tzOffsetMinutes = Math.round(Number(payload.tzOffsetMinutes));
      }
    }
  } catch (err) {
    console.warn('[bot] Failed to read user locale prefs:', err);
  }
  return { lang, tzOffsetMinutes };
}

function formatExpiryInTz(expiresAtMs, tzOffsetMinutes, lang) {
  if (!expiresAtMs) return '';
  const offsetMin = Number.isFinite(Number(tzOffsetMinutes))
    ? Math.round(Number(tzOffsetMinutes))
    : (lang === 'en' ? 0 : 180);
  const shifted = new Date(expiresAtMs + offsetMin * 60000);
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = shifted.getUTCFullYear();
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const offM = String(absMin % 60).padStart(2, '0');
  const tzLabel = `UTC${sign}${offH}:${offM}`;
  return lang === 'en'
    ? `${yyyy}-${mm}-${dd} ${hh}:${min} (${tzLabel})`
    : `${dd}.${mm}.${yyyy} ${hh}:${min} (${tzLabel})`;
}

export default async function handler(req, res) {
  if (!process.env.BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'BOT_TOKEN is not configured' });
  }

  const appUrl = resolveAppUrl(req);

  if (req.method === 'GET') {
    if (req.query?.setup === '1') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({
        ok: false,
        error: 'Use POST /api/bot?setup=1 with header x-setup-secret to avoid exposing secrets in URLs.'
      });
    }

    return res.status(200).json({ ok: true, status: 'Bot endpoint is running' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // 1. Защищённая установка вебхука:
  // POST /api/bot?setup=1 с заголовком x-setup-secret: ВАШ_SETUP_SECRET
  if (req.query?.setup === '1') {
    const setupSecret = process.env.SETUP_SECRET;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!setupSecret || !webhookSecret) {
      return res.status(500).json({
        ok: false,
        error: 'Задайте SETUP_SECRET и TELEGRAM_WEBHOOK_SECRET в настройках Vercel'
      });
    }

    const providedSecret = getHeader(req, 'x-setup-secret');
    if (!safeEqualStrings(providedSecret, setupSecret)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (!appUrl) {
      return res.status(500).json({ ok: false, error: 'APP_URL is not configured' });
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

  // 2. Обязательная проверка секрета вебхука от серверов Telegram
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error('[bot] TELEGRAM_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ ok: false, error: 'Webhook secret not configured' });
  }

  const secretStr = getHeader(req, 'x-telegram-bot-api-secret-token');
  if (!safeEqualStrings(secretStr, expectedSecret)) {
    return res.status(403).json({ ok: false, error: 'Invalid webhook secret' });
  }

  const body = readJsonBody(req);

  // 3. Проверка платежа Telegram Stars перед списанием (ответ должен уйти < 10 сек)
  if (body.pre_checkout_query) {
    const query = body.pre_checkout_query;
    const lang = resolveLangFromCode(query.from?.language_code);

    if (query.from?.id) {
      await upsertBotUser({
        telegramId: query.from.id,
        username: query.from.username,
        firstName: query.from.first_name,
        lastName: query.from.last_name,
        languageCode: query.from.language_code,
        hasStartedBot: false
      });
    }

    let plan = null;
    let rejectReason = lang === 'en'
      ? 'Invalid plan or amount. Please reopen the invoice from the app.'
      : 'Неверный тариф или сумма оплаты. Попробуйте открыть счёт заново.';

    if (query.currency === 'XTR') {
      const { promoCode } = parsePaymentPayload(query.invoice_payload);
      if (promoCode) {
        try {
          const accountId = query.from?.id ? `tg_${query.from.id}` : '';
          const promoCheck = await checkPromoCodeForUser({ promoCode, userId: accountId });
          if (!promoCheck.eligible) {
            rejectReason = lang === 'en'
              ? 'Promo code expired or reached its usage limit.'
              : 'Промокод недействителен, истёк или исчерпан.';
          } else {
            plan = resolvePlanFromPayment(query.invoice_payload, query.total_amount, {
              expectedDiscountPercent: promoCheck.promo.discountPercent
            });
          }
        } catch (promoErr) {
          console.error('[bot] pre_checkout_query promo check error:', promoErr);
          rejectReason = lang === 'en'
            ? 'Could not verify promo code right now. Please try again.'
            : 'Не удалось проверить промокод. Попробуйте ещё раз.';
        }
      } else {
        plan = resolvePlanFromPayment(query.invoice_payload, query.total_amount);
      }
    }

    try {
      await callTelegramApi('answerPreCheckoutQuery', plan
        ? { pre_checkout_query_id: query.id, ok: true }
        : {
            pre_checkout_query_id: query.id,
            ok: false,
            error_message: rejectReason
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

  if (message.from?.id && message.chat?.type === 'private') {
    await upsertBotUser({
      telegramId: message.from.id,
      username: message.from.username,
      firstName: message.from.first_name,
      lastName: message.from.last_name,
      languageCode: message.from.language_code,
      hasStartedBot: true
    });
  }

  // 4. Подтверждённая оплата Telegram Stars — начисляем подписку в БД
  if (message.successful_payment) {
    const sp = message.successful_payment;
    const telegramUserId = message.from?.id || message.chat?.id;
    const { promoCode } = parsePaymentPayload(sp.invoice_payload);

    let plan = null;
    if (sp.currency === 'XTR') {
      if (promoCode) {
        try {
          await ensureDatabaseSchema();
          const promoRows = await db
            .select()
            .from(promoCodes)
            .where(eq(promoCodes.code, promoCode))
            .limit(1);
          const discountPercent = promoRows[0]?.discountPercent;
          plan = resolvePlanFromPayment(sp.invoice_payload, sp.total_amount, {
            expectedDiscountPercent: discountPercent
          });
        } catch (err) {
          console.error('[bot] Failed to load promo for successful_payment:', err);
          return res.status(500).json({ ok: false, error: 'Database error' });
        }
      } else {
        plan = resolvePlanFromPayment(sp.invoice_payload, sp.total_amount);
      }
    }

    if (!telegramUserId || !plan || !sp.telegram_payment_charge_id) {
      console.error('[bot] Unrecognized successful_payment:', {
        telegramUserId,
        currency: sp.currency,
        totalAmount: sp.total_amount,
        payload: sp.invoice_payload,
        chargeId: sp.telegram_payment_charge_id
      });
      if (message.chat?.id) {
        const lang = resolveLangFromCode(message.from?.language_code);
        try {
          await callTelegramApi('sendMessage', {
            chat_id: message.chat.id,
            text: lang === 'en'
              ? `Payment received, but we could not match it automatically to a PRO plan. Please run /paysupport and share your Telegram ID (${telegramUserId || message.chat.id}) and charge ID: ${sp.telegram_payment_charge_id || 'n/a'}.`
              : `Платёж получен, но не удалось автоматически сопоставить тариф PRO. Пожалуйста, отправьте команду /paysupport и укажите ваш Telegram ID (${telegramUserId || message.chat.id}) и ID транзакции: ${sp.telegram_payment_charge_id || 'н/д'}.`
          });
        } catch (notifyErr) {
          console.warn('[bot] Failed to notify user about unrecognized payment:', notifyErr);
        }
      }
      return res.status(200).json({ ok: true });
    }

    const accountId = `tg_${telegramUserId}`;
    const paidStars = Number(sp.total_amount || plan.stars);
    try {
      const result = await applyStarPayment({
        chargeId: sp.telegram_payment_charge_id,
        userId: accountId,
        planId: plan.id,
        starsAmount: paidStars,
        daysAdded: plan.days,
        invoicePayload: sp.invoice_payload,
        promoCode
      });

      if (!result.duplicate) {
        await trackAnalyticsEvent({
          userId: accountId,
          eventName: 'payment_succeeded',
          meta: {
            planId: plan.id,
            stars: paidStars,
            promoCode: promoCode || null
          }
        });
        if (promoCode) {
          await trackAnalyticsEvent({
            userId: accountId,
            eventName: 'promo_redeemed',
            meta: {
              code: promoCode,
              planId: plan.id,
              stars: paidStars
            }
          });
        }
      }

      if (!result.duplicate && message.chat?.id) {
        const { lang, tzOffsetMinutes } = await getUserLocalePrefs(accountId, message.from?.language_code);
        const expDate = formatExpiryInTz(result.subscription.expiresAtMs, tzOffsetMinutes, lang);
        const btnText = lang === 'en' ? 'Open Diary' : 'Открыть дневник';
        const text = lang === 'en'
          ? `⭐ Payment of ${paidStars} Stars succeeded!\nYour PRO subscription has been extended by ${plan.days} days (active until ${expDate}).\n\nOpen the diary — PDF export and exact timestamps are unlocked.`
          : `⭐ Оплата ${paidStars} Stars прошла успешно!\nПодписка PRO продлена на ${plan.days} дн. (активна до ${expDate}).\n\nОткройте дневник — экспорт PDF и точное время уже доступны.`;
        try {
          await callTelegramApi('sendMessage', {
            chat_id: message.chat.id,
            text,
            reply_markup: appUrl
              ? { inline_keyboard: [[{ text: btnText, web_app: { url: appUrl } }]] }
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

  // 5. Возврат платежа Telegram Stars — списываем начисленные дни PRO
  if (message.refunded_payment) {
    const rp = message.refunded_payment;
    const telegramUserId = message.from?.id || message.chat?.id;
    const chargeId = rp.telegram_payment_charge_id;

    if (!chargeId) {
      return res.status(200).json({ ok: true });
    }

    const fallbackAccountId = telegramUserId ? `tg_${telegramUserId}` : null;
    try {
      const result = await revokeStarPaymentRefund({
        chargeId,
        userId: fallbackAccountId
      });

      if (result.found && !result.duplicate && message.chat?.id) {
        const targetAccountId = result.userId || fallbackAccountId;
        const { lang } = targetAccountId
          ? await getUserLocalePrefs(targetAccountId, message.from?.language_code)
          : { lang: resolveLangFromCode(message.from?.language_code) };
        try {
          await callTelegramApi('sendMessage', {
            chat_id: message.chat.id,
            text: lang === 'en'
              ? `Refund processed (${rp.total_amount || ''} Stars). ${result.daysDeducted} PRO days were deducted from your subscription.`
              : `Возврат оплаты выполнен (${rp.total_amount || ''} Stars). С подписки PRO списано ${result.daysDeducted} дн.`
          });
        } catch (notifyErr) {
          console.warn('[bot] Failed to send refund notice:', notifyErr);
        }
      }

      return res.status(200).json({ ok: true });
    } catch (dbErr) {
      console.error('[bot] Failed to process refunded_payment:', dbErr);
      return res.status(500).json({ ok: false, error: 'Database error' });
    }
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const chatId = message.chat?.id;

  if (!chatId || !text) {
    return res.status(200).json({ ok: true });
  }

  const lang = resolveLangFromCode(message.from?.language_code);

  try {
    // 6. Команда /start
    if (/^\/start(@\w+)?(\s|$)/i.test(text)) {
      const startText = lang === 'en'
        ? (appUrl
            ? 'Hello! Tap "Open Diary" below to launch the app.\n\nFor payment and subscription help, use /paysupport.\nWishing you good health!'
            : 'Hello! Open the Symptom Diary Mini App from the bot menu.\n\nFor payment and subscription help, use /paysupport.\nWishing you good health!')
        : (appUrl
            ? 'Привет! Чтобы открыть приложение, нажмите кнопку «Открыть дневник» ниже.\n\nПо вопросам оплаты и подписок используйте команду /paysupport.\nЗдоровья и удачи!'
            : 'Привет! Откройте приложение через меню бота.\n\nПо вопросам оплаты и подписок используйте команду /paysupport.\nЗдоровья и удачи!');
      const btnText = lang === 'en' ? 'Open Diary' : 'Открыть дневник';

      await callTelegramApi('sendMessage', {
        chat_id: chatId,
        text: startText,
        reply_markup: appUrl
          ? {
              inline_keyboard: [
                [{ text: btnText, web_app: { url: appUrl } }]
              ]
            }
          : undefined
      });
      return res.status(200).json({ ok: true });
    }

    // 7. Обязательная по правилам Telegram Stars команда /paysupport
    if (/^\/paysupport(@\w+)?(\s|$)/i.test(text)) {
      const supportContact = process.env.SUPPORT_CONTACT || (lang === 'en' ? 'support via the bot description' : 'поддержку через описание бота');
      await callTelegramApi('sendMessage', {
        chat_id: chatId,
        text: lang === 'en'
          ? `Telegram Stars Payment Support:\n\nIf your PRO subscription did not activate immediately after payment, reopen the Mini App — status syncs with the server automatically.\n\nFor refunds or payment issues, contact ${supportContact}.`
          : `Поддержка по оплатам Telegram Stars:\n\nЕсли подписка PRO не активировалась сразу после оплаты, просто переоткройте Mini App — статус синхронизируется с сервером автоматически.\n\nПо вопросам возврата и сбоев оплаты напишите в ${supportContact}.`
      });
      return res.status(200).json({ ok: true });
    }
  } catch (err) {
    // Не возвращаем 500 на обычных командах (например, если юзер заблокировал бота), чтобы избежать retry-шторма
    console.warn('[bot] Command response warning:', err);
  }

  return res.status(200).json({ ok: true });
}
