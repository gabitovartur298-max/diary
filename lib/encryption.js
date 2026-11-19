import crypto from 'node:crypto';

const ENCRYPTION_VERSION = 1;

function getEncryptionKey() {
  const configuredKey = process.env.DATA_ENCRYPTION_KEY;
  if (configuredKey) {
    return crypto.createHash('sha256').update(String(configuredKey)).digest();
  }
  if (!process.env.BOT_TOKEN) return null;

  return crypto
    .createHmac('sha256', process.env.BOT_TOKEN)
    .update('symptom-diary-health-data-encryption-v1')
    .digest();
}

export function encryptDiaryPayload(payload, userId) {
  const key = getEncryptionKey();
  if (!key) throw new Error('ENCRYPTION_UNAVAILABLE');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`symptom-diary:${userId}`, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    $encrypted: ENCRYPTION_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

export function decryptDiaryPayload(storedPayload, userId) {
  if (!storedPayload || typeof storedPayload !== 'object' || !storedPayload.$encrypted) {
    return storedPayload || null;
  }

  const key = getEncryptionKey();
  if (!key || storedPayload.$encrypted !== ENCRYPTION_VERSION) {
    throw new Error('DECRYPTION_UNAVAILABLE');
  }

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(storedPayload.iv, 'base64')
    );
    decipher.setAAD(Buffer.from(`symptom-diary:${userId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(storedPayload.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(storedPayload.data, 'base64')),
      decipher.final()
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    throw new Error('DECRYPTION_FAILED');
  }
}
