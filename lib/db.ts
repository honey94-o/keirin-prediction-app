import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

// Turso（Hrana HTTP）は大量の連続クエリ（バックテストで1レースあたり数十クエリ×1000件超）を
// 投げると稀に一時的な502等を返すことがある。スクリプトが即クラッシュするのを防ぐため、
// 一時的なエラーに限って数回リトライする。
const RETRYABLE_PATTERN = /50\d|ECONNRESET|ETIMEDOUT|fetch failed|network/i;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES || !RETRYABLE_PATTERN.test(message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error(
        "TURSO_DATABASE_URL is not set. Add it to .env.local (see README デプロイ手順)."
      );
    }
    const rawClient = createClient({ url, authToken });
    const originalExecute = rawClient.execute.bind(rawClient);
    const originalBatch = rawClient.batch.bind(rawClient);
    rawClient.execute = ((...args: Parameters<typeof originalExecute>) =>
      withRetry(() => originalExecute(...args))) as typeof rawClient.execute;
    rawClient.batch = ((...args: Parameters<typeof originalBatch>) =>
      withRetry(() => originalBatch(...args))) as typeof rawClient.batch;
    client = rawClient;
  }
  return client;
}
