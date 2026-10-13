import path from "node:path";
import { SqliteStore, type Store } from "./db.ts";
import { FsImageStore, S3ImageStore, s3ConfigFromEnv, type ImageStore } from "./images.ts";

export type StorageKinds = { database: "postgres" | "sqlite"; images: "s3" | "filesystem" };

/** Which backends the environment selects: Postgres when DATABASE_URL is set, a bucket when one is configured. */
export function storageKinds(env: NodeJS.ProcessEnv = process.env): StorageKinds {
  return {
    database: env.DATABASE_URL?.trim() ? "postgres" : "sqlite",
    images: s3ConfigFromEnv(env) ? "s3" : "filesystem",
  };
}

/**
 * Open the data store and screenshot store. Anything not configured falls back
 * to DATA_DIR (SQLite file and an uploads/ folder), which needs a persistent volume.
 */
export async function openStorage(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): Promise<{ store: Store; images: ImageStore }> {
  const kinds = storageKinds(env);
  const store =
    kinds.database === "postgres"
      ? // Loaded lazily so local SQLite runs never touch the pg driver.
        await (await import("./db-postgres.ts")).PostgresStore.connect(env.DATABASE_URL!.trim(), env)
      : new SqliteStore(path.join(dataDir, "objection-master.db"));
  const s3 = s3ConfigFromEnv(env);
  const images = s3 ? new S3ImageStore(s3) : new FsImageStore(path.join(dataDir, "uploads"));
  return { store, images };
}
