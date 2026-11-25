import crypto from 'node:crypto';

export function safeEqualStrings(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getTelegramUserFromInitData(initData) {
  if (!initData || typeof initData !== 'string' || !process.env.BOT_TOKEN) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    const rawUser = params.get('user');

    if (
      !receivedHash ||
      !/^[0-9a-f]{64}$/i.test(receivedHash) ||
      !rawUser ||
      !Number.isFinite(authDate)
    ) {
      return null;
    }

    const nowSec = Date.now() / 1000;
    if (nowSec - authDate > 60 * 60 * 24 || authDate - nowSec > 300) {
      return null;
    }

    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const receivedBuffer = Buffer.from(receivedHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return null;
    }

    const user = JSON.parse(rawUser);
    const numericId = Number(user?.id);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      return null;
    }

    return {
      id: String(numericId),
      username: typeof user.username === 'string' ? user.username.slice(0, 64) : null,
      firstName: typeof user.first_name === 'string' ? user.first_name.slice(0, 128) : null,
      lastName: typeof user.last_name === 'string' ? user.last_name.slice(0, 128) : null,
      languageCode: typeof user.language_code === 'string' ? user.language_code : null
    };
  } catch {
    return null;
  }
}

export async function callTelegramApi(method, payload, { isFormData = false, timeoutMs = 15000 } = {}) {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error('BOT_TOKEN is not configured');
  }

  const options = {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs)
  };

  if (isFormData) {
    options.body = payload;
  } else {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(payload || {});
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, options);
  const data = await response.json().catch(() => null);
  return { status: response.status, ok: Boolean(response.ok && data?.ok), data };
}
