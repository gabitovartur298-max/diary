import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const symptomDiaryData = pgTable('symptom_diary_data', {
  userId: text('user_id').primaryKey(),
  payload: jsonb('payload').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const diarySubscriptions = pgTable('diary_subscriptions', {
  userId: text('user_id').primaryKey(),
  planId: text('plan_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  trialClaimedAt: timestamp('trial_claimed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const diaryPayments = pgTable('diary_payments', {
  telegramPaymentChargeId: text('telegram_payment_charge_id').primaryKey(),
  userId: text('user_id'),
  planId: text('plan_id').notNull(),
  starsAmount: integer('stars_amount').notNull(),
  providerPaymentChargeId: text('provider_payment_charge_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const diaryRateLimits = pgTable('diary_rate_limits', {
  rateKey: text('rate_key').primaryKey(),
  requestCount: integer('request_count').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
});
