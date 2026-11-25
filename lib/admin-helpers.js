export function parseAdminIds(raw = process.env.ADMIN_TELEGRAM_IDS || '') {
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  const ids = raw
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d{1,20}$/.test(part));
  return new Set(ids);
}

export function isAdminUserId(userId, raw = process.env.ADMIN_TELEGRAM_IDS || '') {
  if (!userId) return false;
  const set = parseAdminIds(raw);
  return set.has(String(userId).trim());
}

export function sanitizeBroadcastText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\r\n/g, '\n').replace(/\0/g, '').trim().slice(0, 3800);
}

export function computeConversionRate(numerator, denominator) {
  const num = Number(numerator || 0);
  const den = Number(denominator || 0);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return Number(((num / den) * 100).toFixed(1));
}
