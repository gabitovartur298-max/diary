import { eq } from 'drizzle-orm';
import { db, pool } from './db/index.js';
import { starPayments, userSubscriptions } from './db/schema.js';
import {
  DAY_MS,
  STARS_PLANS,
  TRIAL_DAYS,
  formatSubscriptionForClient,
  resolvePlanFromPayment
} from './subscription-helpers.js';

export {
  STARS_PLANS,
  TRIAL_DAYS,
  formatSubscriptionForClient,
  resolvePlanFromPayment
};

export async function getUserSubscription(userId) {
  const rows = await db
    .select()
    .from(userSubscriptions)
    .where(eq(userSubscriptions.userId, userId))
    .limit(1);

  return formatSubscriptionForClient(rows[0] || null);
}

export async function hasActivePro(userId) {
  const sub = await getUserSubscription(userId);
  return sub.active;
}

export async function claimFreeTrialForUser(userId) {
  return db.transaction(async (tx) => {
    await tx
      .insert(userSubscriptions)
      .values({ userId })
      .onConflictDoNothing({ target: userSubscriptions.userId });

    const rows = await tx
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .for('update')
      .limit(1);

    const existing = rows[0];
    const nowMs = Date.now();

    if (existing?.trialClaimed) {
      return {
        alreadyClaimed: true,
        subscription: formatSubscriptionForClient(existing, nowMs)
      };
    }

    const existingExpMs = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
    const isCurrentlyActive = existingExpMs > nowMs;
    const newStartedAt = isCurrentlyActive && existing?.startedAt
      ? new Date(existing.startedAt)
      : new Date(nowMs);
    const baseMs = isCurrentlyActive ? existingExpMs : nowMs;
    const newExpiresAt = new Date(baseMs + TRIAL_DAYS * DAY_MS);
    const nowDate = new Date(nowMs);

    const updated = await tx
      .update(userSubscriptions)
      .set({
        trialClaimed: true,
        trialClaimedAt: nowDate,
        planId: isCurrentlyActive && existing?.planId ? existing.planId : 'trial_3d',
        startedAt: newStartedAt,
        expiresAt: newExpiresAt,
        updatedAt: nowDate
      })
      .where(eq(userSubscriptions.userId, userId))
      .returning();

    return {
      alreadyClaimed: false,
      subscription: formatSubscriptionForClient(updated[0], nowMs)
    };
  });
}

export async function applyStarPayment({
  chargeId,
  userId,
  planId,
  starsAmount,
  daysAdded,
  invoicePayload
}) {
  return db.transaction(async (tx) => {
    // Идемпотентность: если Telegram повторно прислал тот же чек, не начисляем дважды
    const insertedPayment = await tx
      .insert(starPayments)
      .values({
        chargeId,
        userId,
        planId,
        starsAmount,
        daysAdded,
        invoicePayload: String(invoicePayload || '').slice(0, 256)
      })
      .onConflictDoNothing({ target: starPayments.chargeId })
      .returning({ chargeId: starPayments.chargeId });

    if (insertedPayment.length === 0) {
      const currentRows = await tx
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId))
        .limit(1);
      return {
        duplicate: true,
        subscription: formatSubscriptionForClient(currentRows[0] || null)
      };
    }

    await tx
      .insert(userSubscriptions)
      .values({ userId })
      .onConflictDoNothing({ target: userSubscriptions.userId });

    const rows = await tx
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .for('update')
      .limit(1);

    const existing = rows[0];
    const nowMs = Date.now();
    const existingExpMs = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
    const isCurrentlyActive = existingExpMs > nowMs;

    const newStartedAt = isCurrentlyActive && existing?.startedAt
      ? new Date(existing.startedAt)
      : new Date(nowMs);
    const baseMs = isCurrentlyActive ? existingExpMs : nowMs;
    const newExpiresAt = new Date(baseMs + daysAdded * DAY_MS);

    const updated = await tx
      .update(userSubscriptions)
      .set({
        planId,
        startedAt: newStartedAt,
        expiresAt: newExpiresAt,
        updatedAt: new Date(nowMs)
      })
      .where(eq(userSubscriptions.userId, userId))
      .returning();

    return {
      duplicate: false,
      subscription: formatSubscriptionForClient(updated[0], nowMs)
    };
  });
}

let refundedAtColumnReadyPromise = null;

async function ensureRefundedAtColumn() {
  if (!refundedAtColumnReadyPromise) {
    refundedAtColumnReadyPromise = (async () => {
      const check = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'star_payments' AND column_name = 'refunded_at'
         LIMIT 1`
      );
      if (check.rowCount === 0) {
        await pool.query('ALTER TABLE star_payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ');
      }
    })().catch((err) => {
      refundedAtColumnReadyPromise = null;
      throw err;
    });
  }
  await refundedAtColumnReadyPromise;
}

export async function revokeStarPaymentRefund({ chargeId, userId = null }) {
  await ensureRefundedAtColumn();
  return db.transaction(async (tx) => {
    const paymentRows = await tx
      .select()
      .from(starPayments)
      .where(eq(starPayments.chargeId, chargeId))
      .for('update')
      .limit(1);

    const payment = paymentRows[0];
    if (!payment) {
      return { found: false, duplicate: false, subscription: null };
    }

    const targetUserId = payment.userId || userId;
    if (payment.refundedAt) {
      const currentRows = targetUserId
        ? await tx
            .select()
            .from(userSubscriptions)
            .where(eq(userSubscriptions.userId, targetUserId))
            .limit(1)
        : [];
      return {
        found: true,
        duplicate: true,
        userId: targetUserId,
        daysDeducted: 0,
        subscription: formatSubscriptionForClient(currentRows[0] || null)
      };
    }

    const nowMs = Date.now();
    const nowDate = new Date(nowMs);

    await tx
      .update(starPayments)
      .set({ refundedAt: nowDate })
      .where(eq(starPayments.chargeId, chargeId));

    if (!targetUserId) {
      return {
        found: true,
        duplicate: false,
        userId: null,
        daysDeducted: payment.daysAdded,
        subscription: formatSubscriptionForClient(null, nowMs)
      };
    }

    const subRows = await tx
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, targetUserId))
      .for('update')
      .limit(1);

    const existing = subRows[0];
    if (!existing) {
      return {
        found: true,
        duplicate: false,
        userId: targetUserId,
        daysDeducted: payment.daysAdded,
        subscription: formatSubscriptionForClient(null, nowMs)
      };
    }

    const existingExpMs = existing.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
    const deductedMs = Math.max(0, Number(payment.daysAdded || 0)) * DAY_MS;
    const newExpMs = existingExpMs - deductedMs;
    const stillActive = newExpMs > nowMs;

    const updated = await tx
      .update(userSubscriptions)
      .set({
        planId: stillActive ? existing.planId : null,
        startedAt: stillActive ? existing.startedAt : null,
        expiresAt: stillActive ? new Date(newExpMs) : null,
        updatedAt: nowDate
      })
      .where(eq(userSubscriptions.userId, targetUserId))
      .returning();

    return {
      found: true,
      duplicate: false,
      userId: targetUserId,
      daysDeducted: payment.daysAdded,
      subscription: formatSubscriptionForClient(updated[0], nowMs)
    };
  });
}
