import { connection } from './redis.js';

const WEBHOOKS_KEY = 'wa:webhook_urls';
const MODE_KEY = 'wa:bulk_mode';

function parseEnvWebhooks(envValue) {
  return String(envValue || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

export async function loadWebhookUrls(envFallback) {
  const raw = await connection.get(WEBHOOKS_KEY);
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      console.warn('[Store] WEBHOOK_URLS en Redis inválido, se usa fallback.');
    }
  }

  const fromEnv = parseEnvWebhooks(envFallback);
  if (fromEnv.length) {
    await connection.set(WEBHOOKS_KEY, JSON.stringify(fromEnv));
  }
  return fromEnv;
}

export async function saveWebhookUrls(urls) {
  await connection.set(WEBHOOKS_KEY, JSON.stringify(urls));
}

export async function loadBulkMode(defaultMode = false) {
  const raw = await connection.get(MODE_KEY);
  if (raw == null) return defaultMode;
  return raw === '1' || raw === 'true';
}

export async function saveBulkMode(isBulk) {
  await connection.set(MODE_KEY, isBulk ? '1' : '0');
}
