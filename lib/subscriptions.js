import crypto from 'node:crypto';
import { getAppUrl } from './config.js';
import { getPool } from './db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 3;

export const STARS_PLANS = Object.freeze({
  '1m': Object.freeze({ stars: 50, days: 30, title: 'PRO на 30 дней' }),
  '6m': Object.freeze({ stars: 250, days: 180, title: 'PRO на 180 дней' }),
  '12m': Object.freeze({ stars: 500, days: 360, title: 'PRO на 360 дней' })
});

function getPaymentSigningKey() {
  const secret = process.env.PAYMENT_SIGNING_SECRET || process.env.BOT_TOKEN;
  if (!secret) return null;
  return crypto.createHmac('sha256', String(secret)).update('symptom-diary-invoice-v1').digest();
}

function signInvoicePart(planKey, userId, nonce) {
  const key = getPaymentSigningKey();
  if (!key) throw new Error('PAYMENTS_UNAVAILABLE');
  return crypto.createHmac('sha256', key).update(`${planKey}.${userId}.${nonce}`).digest('hex').slice(0, 32);
}

function createInvoicePayload(planKey, userId) {
  const nonce = crypto.randomBytes(12).toString('hex');
  return `diary_v1.${planKey}.${userId}.${nonce}.${signInvoicePart(planKey, userId, nonce)}`;
}

function getSignedPlan(payload, userId) {
  if (typeof payload !== 'string' || payload.length > 160) return null;
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== 'diary_v1') return null;

  const [, planKey, payloadUserId, nonce, signature] = parts;
  if (!STARS_PLANS[planKey] || payloadUserId !== String(userId) || !/^[a-f0-9]{24}$/.test(nonce)) {
    return null;
  }

  const expected = signInvoicePart(planKey, userId, nonce);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  return planKey;
}

export function getPlanForTelegramPayment(payment, userId) {
  if (!payment || payment.currency !== 'XTR' || !Number.isSafeInteger(payment.total_amount)) {
    return null;
  }

  const signedPlan = getSignedPlan(payment.invoice_payload, userId);
  if (signedPlan) {
    return STARS_PLANS[signedPlan].stars === payment.total_amount ? signedPlan : null;
  }

  // Ранее созданные ссылки не содержали подписанного payload. Им разрешено
  // завершиться только с точной валютой и уникальной стоимостью одного из тарифов.
  if (typeof payment.invoice_payload === 'string' && payment.invoice_payload.startsWith('diary_v1.')) {
    return null;
  }
  return Object.keys(STARS_PLANS).find(key => STARS_PLANS[key].stars === payment.total_amount) || null;
}

function serializeSubscription(row) {
  const expiresAtMs = row?.expires_at ? new Date(row.expires_at).getTime() : null;
  const startedAtMs = row?.started_at ? new Date(row.started_at).getTime() : null;
  const trialClaimedAtMs = row?.trial_claimed_at ? new Date(row.trial_claimed_at).getTime() : null;
  const active = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();

  return {
    active,
    planId: active ? row?.plan_id || null : null,
    startedAtMs: active ? startedAtMs : null,
    expiresAtMs: active ? expiresAtMs : null,
    totalDays: active && startedAtMs ? Math.max(1, Math.round((expiresAtMs - startedAtMs) / DAY_MS)) : 0,
    trialClaimed: Boolean(trialClaimedAtMs),
    trialClaimedAtMs
  };
}

async function selectSubscription(client, userId, forUpdate = false) {
  const result = await client.query(
    `SELECT user_id, plan_id, started_at, expires_at, trial_claimed_at
     FROM diary_subscriptions WHERE user_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId]
  );
  return result.rows[0] || null;
}

async function lockAccount(client, userId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscription:${userId}`]);
}

async function extendSubscriptionLocked(client, userId, planKey, days, claimTrial = false) {
  const current = await selectSubscription(client, userId, true);
  const now = Date.now();
  const currentExpiresAtMs = current?.expires_at ? new Date(current.expires_at).getTime() : 0;
  const isActive = currentExpiresAtMs > now;
  const startedAt = isActive && current?.started_at ? new Date(current.started_at) : new Date(now);
  const expiresAt = new Date((isActive ? currentExpiresAtMs : now) + days * DAY_MS);
  const trialClaimedAt = claimTrial
    ? new Date(now)
    : current?.trial_claimed_at || null;
  const nextPlan = planKey === 'trial_3d' && isActive ? current.plan_id || planKey : planKey;

  const result = await client.query(
    `INSERT INTO diary_subscriptions
       (user_id, plan_id, started_at, expires_at, trial_claimed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       started_at = EXCLUDED.started_at,
       expires_at = EXCLUDED.expires_at,
       trial_claimed_at = EXCLUDED.trial_claimed_at,
       updated_at = NOW()
     RETURNING user_id, plan_id, started_at, expires_at, trial_claimed_at`,
    [userId, nextPlan, startedAt, expiresAt, trialClaimedAt]
  );
  return serializeSubscription(result.rows[0]);
}

export async function getSubscriptionStatus(userId) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  const row = await selectSubscription(pool, userId);
  return serializeSubscription(row);
}

export async function createStarsInvoice(userId, planKey) {
  const plan = STARS_PLANS[planKey];
  if (!plan || !process.env.BOT_TOKEN) return null;

  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: plan.title,
      description: 'Доступ к PDF-отчётам и точному времени записей в «Дневнике симптомов».',
      payload: createInvoicePayload(planKey, userId),
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: plan.title, amount: plan.stars }],
      start_parameter: `diary-${planKey}`,
      need_name: false,
      need_email: false,
      need_phone_number: false,
      need_shipping_address: false,
      is_flexible: false
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok || typeof data.result !== 'string') {
    throw new Error('INVOICE_CREATION_FAILED');
  }
  return data.result;
}

export async function claimFreeTrial(userId) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockAccount(client, userId);
    const current = await selectSubscription(client, userId, true);
    if (current?.trial_claimed_at) {
      await client.query('COMMIT');
      return { claimed: false, subscription: serializeSubscription(current) };
    }
    const subscription = await extendSubscriptionLocked(client, userId, 'trial_3d', TRIAL_DAYS, true);
    await client.query('COMMIT');
    return { claimed: true, subscription };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function processSuccessfulPayment(userId, payment) {
  const planKey = getPlanForTelegramPayment(payment, userId);
  const chargeId = typeof payment?.telegram_payment_charge_id === 'string'
    ? payment.telegram_payment_charge_id.slice(0, 160)
    : '';
  if (!planKey || !chargeId) return { ok: false };

  const pool = getPool();
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  const client = await pool.connect();
  const plan = STARS_PLANS[planKey];

  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO diary_payments
         (telegram_payment_charge_id, user_id, plan_id, stars_amount, provider_payment_charge_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_payment_charge_id) DO NOTHING
       RETURNING telegram_payment_charge_id`,
      [chargeId, userId, planKey, plan.stars, String(payment.provider_payment_charge_id || '').slice(0, 160) || null]
    );

    if (inserted.rowCount === 0) {
      const current = await selectSubscription(client, userId);
      await client.query('COMMIT');
      return { ok: true, duplicate: true, subscription: serializeSubscription(current) };
    }

    await lockAccount(client, userId);
    const subscription = await extendSubscriptionLocked(client, userId, planKey, plan.days);
    await client.query('COMMIT');
    return { ok: true, duplicate: false, subscription };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function getMiniAppUrl() {
  return getAppUrl();
}
