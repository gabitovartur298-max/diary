import { readInitData, readJsonBody, resolveAppUrl } from '../lib/http.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';
import {
  createPromoCode,
  deletePromoCode,
  getAdminDashboardData,
  isAdminUserId,
  sendAdminTelegramMessages,
  togglePromoCodeActive
} from '../lib/admin.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' });
  }

  const body = req.method === 'POST' ? readJsonBody(req) : {};
  const user = getTelegramUserFromInitData(readInitData(req, body));
  if (!user) {
    return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Telegram authentication required' });
  }

  if (!isAdminUserId(user.id)) {
    return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Admin access denied' });
  }

  try {
    if (req.method === 'GET') {
      const dashboard = await getAdminDashboardData();
      return res.status(200).json({
        ok: true,
        adminId: user.id,
        ...dashboard
      });
    }

    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'send_message') {
      if (!process.env.BOT_TOKEN) {
        return res.status(500).json({ ok: false, code: 'SERVER_CONFIG_ERROR', error: 'BOT_TOKEN is not configured' });
      }
      const targetMode = body.targetMode === 'all' ? 'all' : 'selected';
      const telegramIds = Array.isArray(body.telegramIds)
        ? body.telegramIds
        : typeof body.telegramIds === 'string'
          ? body.telegramIds.split(/[\s,;]+/)
          : [];
      const result = await sendAdminTelegramMessages({
        targetMode,
        telegramIds,
        messageText: body.messageText,
        attachAppButton: Boolean(body.attachAppButton),
        appUrl: resolveAppUrl(req)
      });
      if (!result.ok) {
        return res.status(400).json({ ok: false, code: 'INVALID_MESSAGE', error: result.error });
      }
      return res.status(200).json(result);
    }

    if (action === 'create_promo') {
      const created = await createPromoCode({
        code: body.code,
        discountPercent: body.discountPercent,
        maxUses: body.maxUses,
        durationHours: body.durationHours,
        createdBy: `tg_${user.id}`
      });
      if (!created.ok) {
        return res.status(400).json({ ok: false, code: created.code, error: created.error });
      }
      return res.status(200).json({ ok: true, promo: created.promo });
    }

    if (action === 'toggle_promo') {
      const updated = await togglePromoCodeActive({
        code: body.code,
        isActive: body.isActive
      });
      if (!updated) {
        return res.status(404).json({ ok: false, code: 'PROMO_NOT_FOUND', error: 'Promo code not found' });
      }
      return res.status(200).json({ ok: true, promo: updated });
    }

    if (action === 'delete_promo') {
      const deleted = await deletePromoCode(body.code);
      if (!deleted) {
        return res.status(404).json({ ok: false, code: 'PROMO_NOT_FOUND', error: 'Promo code not found' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, code: 'UNKNOWN_ACTION', error: 'Unknown admin action' });
  } catch (error) {
    console.error('[admin] Admin API error:', error);
    return res.status(500).json({ ok: false, code: 'ADMIN_UNAVAILABLE', error: 'Admin service unavailable' });
  }
}
