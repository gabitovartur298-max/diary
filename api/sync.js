import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index.js';
import { ensureDatabaseSchema } from '../lib/db/ensure-schema.js';
import { symptomDiaryData } from '../lib/db/schema.js';
import { mergeDiaryPayloads, sanitizeDiaryPayload } from '../lib/diary.js';
import { readInitData, readJsonBody } from '../lib/http.js';
import { getUserSubscription } from '../lib/subscriptions.js';
import { isAdminUserId, trackAnalyticsEvent, upsertBotUser } from '../lib/admin.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(204).end();
  }

  const method = req.method;
  if (!['GET', 'POST', 'DELETE'].includes(method)) {
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' });
  }

  const body = method === 'POST' ? readJsonBody(req) : {};
  const user = getTelegramUserFromInitData(readInitData(req, body));
  if (!user) {
    return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Telegram authentication required' });
  }

  const accountId = `tg_${user.id}`;
  const isAdmin = isAdminUserId(user.id);

  try {
    await ensureDatabaseSchema();

    if (method === 'GET') {
      const isInitial = req.query?.initial === '1';
      await upsertBotUser({
        telegramId: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        languageCode: user.languageCode,
        hasStartedBot: false
      });
      if (isInitial) {
        await trackAnalyticsEvent({ userId: accountId, eventName: 'app_open' });
      }

      const rows = await db
        .select({
          payload: symptomDiaryData.payload,
          version: symptomDiaryData.version,
          updatedAt: symptomDiaryData.updatedAt
        })
        .from(symptomDiaryData)
        .where(eq(symptomDiaryData.userId, accountId))
        .limit(1);
      const subscription = await getUserSubscription(accountId);

      const stored = rows[0]?.payload ? sanitizeDiaryPayload(rows[0].payload) : null;

      return res.status(200).json({
        ok: true,
        isAdmin,
        data: stored,
        version: rows[0]?.version || 0,
        updatedAt: rows[0]?.updatedAt || null,
        subscription
      });
    }

    if (method === 'POST') {
      const incoming = sanitizeDiaryPayload(body.data);
      if (!incoming) {
        return res.status(400).json({ ok: false, code: 'INVALID_PAYLOAD', error: 'Invalid or oversized diary payload' });
      }

      const saved = await db.transaction(async (tx) => {
        await tx
          .insert(symptomDiaryData)
          .values({
            userId: accountId,
            payload: {},
            version: 0
          })
          .onConflictDoNothing({ target: symptomDiaryData.userId });

        const existingRows = await tx
          .select()
          .from(symptomDiaryData)
          .where(eq(symptomDiaryData.userId, accountId))
          .for('update')
          .limit(1);

        const existing = existingRows[0];
        const merged = mergeDiaryPayloads(existing?.payload, incoming);
        const nextVersion = (existing?.version || 0) + 1;

        const updated = await tx
          .update(symptomDiaryData)
          .set({
            payload: merged,
            version: nextVersion,
            updatedAt: new Date()
          })
          .where(eq(symptomDiaryData.userId, accountId))
          .returning({
            version: symptomDiaryData.version,
            updatedAt: symptomDiaryData.updatedAt
          });

        return {
          data: merged,
          version: updated[0]?.version || nextVersion,
          updatedAt: updated[0]?.updatedAt || null
        };
      });
      const subscription = await getUserSubscription(accountId);

      return res.status(200).json({
        ok: true,
        isAdmin,
        data: saved.data,
        version: saved.version,
        updatedAt: saved.updatedAt,
        subscription
      });
    }

    if (method === 'DELETE') {
      await db
        .delete(symptomDiaryData)
        .where(eq(symptomDiaryData.userId, accountId));

      return res.status(200).json({ ok: true });
    }
  } catch (error) {
    console.error('[sync] Diary sync API error:', error);
    return res.status(500).json({ ok: false, code: 'SYNC_UNAVAILABLE', error: 'Diary sync unavailable' });
  }
}
