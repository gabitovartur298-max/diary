import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const symptomDiaryData = pgTable('symptom_diary_data', {
  userId: text('user_id').primaryKey(),
  payload: jsonb('payload').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
