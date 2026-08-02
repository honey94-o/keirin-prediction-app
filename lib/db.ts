import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error(
        "TURSO_DATABASE_URL is not set. Add it to .env.local (see README デプロイ手順)."
      );
    }
    client = createClient({ url, authToken });
  }
  return client;
}
