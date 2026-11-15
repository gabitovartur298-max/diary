import crypto from 'node:crypto';

export function getTelegramUserFromInitData(initData) {
  if (!initData || typeof initData !== 'string' || !process.env.BOT_TOKEN) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    const rawUser = params.get('user');

    if (!receivedHash || !rawUser || !Number.isFinite(authDate)) {
      return null;
    }

    if (Math.abs(Date.now() / 1000 - authDate) > 60 * 60 * 24) {
      return null;
    }

    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
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
    if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) {
      return null;
    }

    return { id: String(user.id) };
  } catch {
    return null;
  }
}
