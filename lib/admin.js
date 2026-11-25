import { desc, eq } from 'drizzle-orm';
import { db, pool } from './db/index.js';
import { ensureDatabaseSchema } from './db/ensure-schema.js';
import { botUsers, promoCodes } from './db/schema.js';
import { callTelegramApi } from './telegram.js';
import {
  computeConversionRate,
  isAdminUserId,
  parseAdminIds,
  sanitizeBroadcastText
} from './admin-helpers.js';
import { normalizePromoCode } from './subscription-helpers.js';

export {
  computeConversionRate,
  isAdminUserId,
  parseAdminIds,
  sanitizeBroadcastText
};

export async function upsertBotUser({
  telegramId,
  username = null,
  firstName = null,
  lastName = null,
  languageCode = null,
  hasStartedBot = false
}) {
  if (!telegramId) return;
  try {
    await ensureDatabaseSchema();
    const idStr = String(telegramId).trim();
    if (!/^\d{1,20}$/.test(idStr)) return;

    await pool.query(
      `INSERT INTO bot_users (
        telegram_id, account_id, username, first_name, last_name, language_code,
        has_started_bot, bot_blocked, first_seen_at, last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW(), NOW())
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = COALESCE(EXCLUDED.username, bot_users.username),
        first_name = COALESCE(EXCLUDED.first_name, bot_users.first_name),
        last_name = COALESCE(EXCLUDED.last_name, bot_users.last_name),
        language_code = COALESCE(EXCLUDED.language_code, bot_users.language_code),
        has_started_bot = bot_users.has_started_bot OR EXCLUDED.has_started_bot,
        bot_blocked = CASE WHEN EXCLUDED.has_started_bot THEN FALSE ELSE bot_users.bot_blocked END,
        last_seen_at = NOW()`,
      [
        idStr,
        `tg_${idStr}`,
        username ? String(username).slice(0, 64) : null,
        firstName ? String(firstName).slice(0, 128) : null,
        lastName ? String(lastName).slice(0, 128) : null,
        languageCode ? String(languageCode).slice(0, 16) : null,
        Boolean(hasStartedBot)
      ]
    );
  } catch (err) {
    console.warn('[admin] upsertBotUser warning:', err);
  }
}

export async function markBotUserBlocked(telegramId, blocked = true) {
  if (!telegramId) return;
  try {
    await ensureDatabaseSchema();
    await db
      .update(botUsers)
      .set({ botBlocked: Boolean(blocked) })
      .where(eq(botUsers.telegramId, String(telegramId)));
  } catch (err) {
    console.warn('[admin] markBotUserBlocked warning:', err);
  }
}

export async function trackAnalyticsEvent({ userId, eventName, meta = null }) {
  if (!userId || !eventName) return;
  try {
    await ensureDatabaseSchema();
    await pool.query(
      `INSERT INTO analytics_events (user_id, event_name, meta)
       VALUES ($1, $2, $3::jsonb)`,
      [
        String(userId).slice(0, 64),
        String(eventName).slice(0, 64),
        meta ? JSON.stringify(meta) : null
      ]
    );
  } catch (err) {
    console.warn('[analytics] trackAnalyticsEvent warning:', err);
  }
}

export async function createPromoCode({
  code,
  discountPercent,
  maxUses = null,
  durationHours = null,
  createdBy = null
}) {
  await ensureDatabaseSchema();
  const cleanCode = normalizePromoCode(code);
  if (!cleanCode) {
    return { ok: false, code: 'PROMO_INVALID_CODE', error: 'Code must be 3-32 characters (A-Z, 0-9, _, -)' };
  }

  const pct = Number(discountPercent);
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
    return { ok: false, code: 'PROMO_INVALID_DISCOUNT', error: 'Discount must be an integer between 1 and 100' };
  }

  let parsedMaxUses = null;
  if (maxUses !== null && maxUses !== undefined && maxUses !== '') {
    parsedMaxUses = Number(maxUses);
    if (!Number.isInteger(parsedMaxUses) || parsedMaxUses < 1 || parsedMaxUses > 1000000) {
      return { ok: false, code: 'PROMO_INVALID_LIMIT', error: 'Max uses must be a positive integer' };
    }
  }

  let parsedHours = null;
  let expiresAt = null;
  if (durationHours !== null && durationHours !== undefined && durationHours !== '') {
    parsedHours = Number(durationHours);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0 || parsedHours > 24 * 365 * 5) {
      return { ok: false, code: 'PROMO_INVALID_DURATION', error: 'Duration must be positive' };
    }
    parsedHours = Math.round(parsedHours);
    expiresAt = new Date(Date.now() + parsedHours * 3600 * 1000);
  }

  const inserted = await db
    .insert(promoCodes)
    .values({
      code: cleanCode,
      discountPercent: pct,
      maxUses: parsedMaxUses,
      durationHours: parsedHours,
      expiresAt,
      isActive: true,
      createdBy: createdBy ? String(createdBy) : null
    })
    .onConflictDoNothing({ target: promoCodes.code })
    .returning();

  if (inserted.length === 0) {
    return { ok: false, code: 'PROMO_ALREADY_EXISTS', error: 'A promo code with this code already exists' };
  }

  return { ok: true, promo: inserted[0] };
}

export async function togglePromoCodeActive({ code, isActive }) {
  await ensureDatabaseSchema();
  const cleanCode = normalizePromoCode(code);
  if (!cleanCode) return null;
  const updated = await db
    .update(promoCodes)
    .set({ isActive: Boolean(isActive) })
    .where(eq(promoCodes.code, cleanCode))
    .returning();
  return updated[0] || null;
}

export async function deletePromoCode(code) {
  await ensureDatabaseSchema();
  const cleanCode = normalizePromoCode(code);
  if (!cleanCode) return false;
  const deleted = await db
    .delete(promoCodes)
    .where(eq(promoCodes.code, cleanCode))
    .returning({ code: promoCodes.code });
  return deleted.length > 0;
}

export async function getAdminDashboardData() {
  await ensureDatabaseSchema();

  const summaryResult = await pool.query(`
    WITH all_accounts AS (
      SELECT account_id AS user_id FROM bot_users
      UNION
      SELECT user_id FROM symptom_diary_data
      UNION
      SELECT user_id FROM user_subscriptions
      UNION
      SELECT user_id FROM star_payments
      UNION
      SELECT user_id FROM analytics_events
    ),
    app_opened AS (
      SELECT user_id FROM analytics_events WHERE event_name = 'app_open'
      UNION
      SELECT user_id FROM symptom_diary_data
      UNION
      SELECT user_id FROM user_subscriptions
    )
    SELECT
      (SELECT COUNT(*)::int FROM all_accounts) AS total_users,
      (SELECT COUNT(*)::int FROM bot_users WHERE has_started_bot = TRUE) AS bot_started_users,
      (SELECT COUNT(*)::int FROM bot_users WHERE has_started_bot = TRUE AND bot_blocked = FALSE) AS bot_reachable_users,
      (SELECT COUNT(*)::int FROM bot_users WHERE bot_blocked = TRUE) AS bot_blocked_users,
      (SELECT COUNT(*)::int FROM app_opened) AS app_opened_users,
      (SELECT COUNT(*)::int FROM symptom_diary_data) AS diary_users,
      (SELECT COUNT(*)::int FROM user_subscriptions WHERE trial_claimed = TRUE) AS trial_users,
      (SELECT COUNT(DISTINCT user_id)::int FROM analytics_events WHERE event_name = 'invoice_created') AS invoice_opened_users,
      (SELECT COUNT(DISTINCT user_id)::int FROM star_payments WHERE refunded_at IS NULL) AS paying_users,
      (SELECT COUNT(*)::int FROM user_subscriptions WHERE expires_at > NOW()) AS active_pro_users,
      (SELECT COUNT(DISTINCT user_id)::int FROM analytics_events WHERE event_name IN ('pdf_downloaded', 'pdf_sent_chat')) AS pdf_users,
      (SELECT COUNT(*)::int FROM analytics_events WHERE event_name IN ('pdf_downloaded', 'pdf_sent_chat')) AS pdf_exports_total,
      (SELECT COALESCE(SUM(stars_amount), 0)::int FROM star_payments WHERE refunded_at IS NULL) AS stars_revenue_total,
      (SELECT COUNT(*)::int FROM star_payments WHERE refunded_at IS NULL) AS payments_count,
      (SELECT COUNT(*)::int FROM star_payments WHERE refunded_at IS NOT NULL) AS refunds_count,
      (SELECT COUNT(*)::int FROM promo_redemptions) AS promo_redemptions_total,
      (SELECT COUNT(*)::int FROM bot_users WHERE first_seen_at >= NOW() - INTERVAL '7 days') AS new_users_7d,
      (SELECT COUNT(*)::int FROM user_subscriptions WHERE trial_claimed = TRUE AND trial_claimed_at >= NOW() - INTERVAL '7 days') AS trials_7d,
      (SELECT COUNT(DISTINCT user_id)::int FROM analytics_events WHERE event_name = 'invoice_created' AND created_at >= NOW() - INTERVAL '7 days') AS invoices_7d,
      (SELECT COUNT(*)::int FROM star_payments WHERE refunded_at IS NULL AND created_at >= NOW() - INTERVAL '7 days') AS payments_7d,
      (SELECT COALESCE(SUM(stars_amount), 0)::int FROM star_payments WHERE refunded_at IS NULL AND created_at >= NOW() - INTERVAL '7 days') AS stars_7d
  `);

  const stats = summaryResult.rows[0] || {};
  const rates = {
    appToTrialPct: computeConversionRate(stats.trial_users, stats.app_opened_users),
    trialToPaidPct: computeConversionRate(stats.paying_users, stats.trial_users),
    appToPaidPct: computeConversionRate(stats.paying_users, stats.app_opened_users),
    invoiceToPaidPct: computeConversionRate(stats.paying_users, stats.invoice_opened_users)
  };

  const usersResult = await pool.query(`
    SELECT
      COALESCE(bu.telegram_id, REPLACE(COALESCE(us.user_id, sd.user_id), 'tg_', '')) AS telegram_id,
      COALESCE(bu.account_id, us.user_id, sd.user_id) AS account_id,
      bu.username,
      bu.first_name,
      bu.last_name,
      bu.language_code,
      COALESCE(bu.has_started_bot, FALSE) AS has_started_bot,
      COALESCE(bu.bot_blocked, FALSE) AS bot_blocked,
      COALESCE(bu.last_seen_at, sd.updated_at, us.updated_at) AS last_seen_at,
      COALESCE(us.trial_claimed, FALSE) AS trial_claimed,
      us.plan_id,
      us.expires_at,
      (us.expires_at IS NOT NULL AND us.expires_at > NOW()) AS is_pro,
      CASE
        WHEN jsonb_typeof(sd.payload->'entries') = 'array' THEN jsonb_array_length(sd.payload->'entries')
        ELSE 0
      END AS entries_count,
      COALESCE(sp.paid_stars, 0)::int AS paid_stars,
      COALESCE(sp.payments_count, 0)::int AS payments_count
    FROM bot_users bu
    FULL OUTER JOIN user_subscriptions us ON us.user_id = bu.account_id
    FULL OUTER JOIN symptom_diary_data sd ON sd.user_id = COALESCE(bu.account_id, us.user_id)
    LEFT JOIN (
      SELECT user_id, SUM(stars_amount) AS paid_stars, COUNT(*) AS payments_count
      FROM star_payments
      WHERE refunded_at IS NULL
      GROUP BY user_id
    ) sp ON sp.user_id = COALESCE(bu.account_id, us.user_id, sd.user_id)
    WHERE COALESCE(bu.telegram_id, REPLACE(COALESCE(us.user_id, sd.user_id), 'tg_', '')) ~ '^[0-9]+$'
    ORDER BY COALESCE(bu.last_seen_at, sd.updated_at, us.updated_at) DESC NULLS LAST
    LIMIT 400
  `);

  const promos = await db
    .select()
    .from(promoCodes)
    .orderBy(desc(promoCodes.createdAt))
    .limit(200);

  const recentPaymentsResult = await pool.query(`
    SELECT
      sp.charge_id,
      sp.user_id,
      sp.plan_id,
      sp.stars_amount,
      sp.days_added,
      sp.created_at,
      sp.refunded_at,
      bu.username,
      bu.first_name
    FROM star_payments sp
    LEFT JOIN bot_users bu ON bu.account_id = sp.user_id
    ORDER BY sp.created_at DESC
    LIMIT 25
  `);

  return {
    stats: {
      totalUsers: Number(stats.total_users || 0),
      botStartedUsers: Number(stats.bot_started_users || 0),
      botReachableUsers: Number(stats.bot_reachable_users || 0),
      botBlockedUsers: Number(stats.bot_blocked_users || 0),
      appOpenedUsers: Number(stats.app_opened_users || 0),
      diaryUsers: Number(stats.diary_users || 0),
      trialUsers: Number(stats.trial_users || 0),
      invoiceOpenedUsers: Number(stats.invoice_opened_users || 0),
      payingUsers: Number(stats.paying_users || 0),
      activeProUsers: Number(stats.active_pro_users || 0),
      pdfUsers: Number(stats.pdf_users || 0),
      pdfExportsTotal: Number(stats.pdf_exports_total || 0),
      starsRevenueTotal: Number(stats.stars_revenue_total || 0),
      paymentsCount: Number(stats.payments_count || 0),
      refundsCount: Number(stats.refunds_count || 0),
      promoRedemptionsTotal: Number(stats.promo_redemptions_total || 0),
      newUsers7d: Number(stats.new_users_7d || 0),
      trials7d: Number(stats.trials_7d || 0),
      invoices7d: Number(stats.invoices_7d || 0),
      payments7d: Number(stats.payments_7d || 0),
      stars7d: Number(stats.stars_7d || 0),
      rates
    },
    users: usersResult.rows.map((row) => ({
      telegramId: row.telegram_id,
      username: row.username || null,
      firstName: row.first_name || null,
      lastName: row.last_name || null,
      languageCode: row.language_code || null,
      hasStartedBot: Boolean(row.has_started_bot),
      botBlocked: Boolean(row.bot_blocked),
      lastSeenAtMs: row.last_seen_at ? new Date(row.last_seen_at).getTime() : null,
      trialClaimed: Boolean(row.trial_claimed),
      planId: row.plan_id || null,
      isPro: Boolean(row.is_pro),
      expiresAtMs: row.expires_at ? new Date(row.expires_at).getTime() : null,
      entriesCount: Number(row.entries_count || 0),
      paidStars: Number(row.paid_stars || 0),
      paymentsCount: Number(row.payments_count || 0)
    })),
    promos: promos.map((p) => ({
      code: p.code,
      discountPercent: p.discountPercent,
      maxUses: p.maxUses,
      usedCount: p.usedCount,
      durationHours: p.durationHours,
      expiresAtMs: p.expiresAt ? new Date(p.expiresAt).getTime() : null,
      isActive: p.isActive,
      createdAtMs: p.createdAt ? new Date(p.createdAt).getTime() : null
    })),
    recentPayments: recentPaymentsResult.rows.map((p) => ({
      chargeId: p.charge_id,
      userId: p.user_id,
      username: p.username || null,
      firstName: p.first_name || null,
      planId: p.plan_id,
      starsAmount: p.stars_amount,
      daysAdded: p.days_added,
      createdAtMs: p.created_at ? new Date(p.created_at).getTime() : null,
      refundedAtMs: p.refunded_at ? new Date(p.refunded_at).getTime() : null
    }))
  };
}

export async function sendAdminTelegramMessages({
  targetMode,
  telegramIds = [],
  messageText,
  attachAppButton = false,
  appUrl = ''
}) {
  await ensureDatabaseSchema();
  const cleanText = sanitizeBroadcastText(messageText);
  if (!cleanText) {
    return { ok: false, error: 'Message text cannot be empty' };
  }

  let targets = [];
  let skippedNotStarted = 0;

  if (targetMode === 'all') {
    const res = await pool.query(
      `SELECT telegram_id, language_code, has_started_bot, bot_blocked
       FROM bot_users
       ORDER BY last_seen_at DESC`
    );
    for (const row of res.rows) {
      if (!row.has_started_bot || row.bot_blocked) {
        skippedNotStarted += 1;
      } else {
        targets.push({
          telegramId: row.telegram_id,
          languageCode: row.language_code || 'ru'
        });
      }
    }
  } else {
    const uniqueIds = [...new Set(
      (Array.isArray(telegramIds) ? telegramIds : [])
        .map((id) => String(id || '').replace(/^tg_/, '').trim())
        .filter((id) => /^\d{1,20}$/.test(id))
    )].slice(0, 500);

    if (uniqueIds.length === 0) {
      return { ok: false, error: 'No valid Telegram user IDs selected' };
    }
    targets = uniqueIds.map((telegramId) => ({ telegramId, languageCode: 'ru' }));
  }

  let sent = 0;
  let failed = 0;
  let blocked = 0;
  const errors = [];

  const BATCH_SIZE = 15;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (target) => {
        const btnText = target.languageCode && target.languageCode.startsWith('en')
          ? 'Open Diary'
          : 'Открыть дневник';
        try {
          const res = await callTelegramApi('sendMessage', {
            chat_id: target.telegramId,
            text: cleanText,
            reply_markup: attachAppButton && appUrl
              ? { inline_keyboard: [[{ text: btnText, web_app: { url: appUrl } }]] }
              : undefined
          });
          if (res.ok) {
            sent += 1;
          } else {
            failed += 1;
            const desc = res.data?.description || `HTTP ${res.status}`;
            if (res.status === 403 || /blocked|chat not found|initiate conversation|deactivated/i.test(desc)) {
              blocked += 1;
              await markBotUserBlocked(target.telegramId, true);
            }
            if (errors.length < 10) {
              errors.push({ telegramId: target.telegramId, error: desc });
            }
          }
        } catch (err) {
          failed += 1;
          if (errors.length < 10) {
            errors.push({ telegramId: target.telegramId, error: err?.message || 'Request failed' });
          }
        }
      })
    );
    if (i + BATCH_SIZE < targets.length) {
      await new Promise((resolve) => setTimeout(resolve, 65));
    }
  }

  return {
    ok: true,
    totalTargets: targets.length,
    sent,
    failed,
    blocked,
    skippedNotStarted,
    errors
  };
}
