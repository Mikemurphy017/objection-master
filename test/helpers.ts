import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import pg from "pg";
import { SqliteStore, type Store } from "../src/db.ts";
import { PostgresStore } from "../src/db-postgres.ts";
import { FsImageStore, S3ImageStore, type ImageStore, type S3Like } from "../src/images.ts";

/**
 * Postgres tests run only when TEST_DATABASE_URL points at a disposable database
 * (each test gets a throwaway schema), e.g. postgres://postgres:postgres@localhost:5432/om_test
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface StoreBackend {
  name: string;
  open(): Promise<Store>;
}

export const storeBackends: StoreBackend[] = [
  { name: "sqlite", open: async () => new SqliteStore(":memory:") },
  ...(TEST_DATABASE_URL ? [{ name: "postgres", open: () => openCleanPostgres(TEST_DATABASE_URL) }] : []),
];

let schemaCount = 0;

/** A PostgresStore in its own fresh schema (test files run in parallel), dropped again on close(). */
export async function openCleanPostgres(url: string): Promise<Store> {
  const schema = `om_test_${process.pid}_${++schemaCount}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const store = await PostgresStore.connect(scoped.toString(), {});
  const close = store.close.bind(store);
  store.close = async () => {
    await close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  return store;
}

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "om-test-"));

/** Minimal in-memory stand-in for S3Client.send(), recording every command it receives. */
export class FakeS3 implements S3Like {
  objects = new Map<string, { body: Buffer; contentType?: string }>();
  calls: { command: string; input: Record<string, any> }[] = [];

  async send(command: any): Promise<any> {
    const name: string = command.constructor.name;
    const input = command.input as Record<string, any>;
    this.calls.push({ command: name, input });
    const key = `${input.Bucket}/${input.Key}`;
    const notFound = () => Object.assign(new Error("not found"), { name: name === "HeadObjectCommand" ? "NotFound" : "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    switch (name) {
      case "PutObjectCommand":
        this.objects.set(key, { body: Buffer.from(input.Body), contentType: input.ContentType });
        return {};
      case "HeadObjectCommand":
        if (!this.objects.has(key)) throw notFound();
        return {};
      case "GetObjectCommand": {
        const obj = this.objects.get(key);
        if (!obj) throw notFound();
        return { Body: Readable.from([obj.body]), ContentType: obj.contentType, ContentLength: obj.body.length };
      }
      case "DeleteObjectCommand":
        this.objects.delete(key);
        return {};
      default:
        throw new Error(`FakeS3: unexpected ${name}`);
    }
  }
}

export interface ImageBackend {
  name: string;
  open(): ImageStore;
}

export const imageBackends: ImageBackend[] = [
  { name: "filesystem", open: () => new FsImageStore(tmpDir()) },
  {
    name: "s3 (fake client)",
    open: () =>
      new S3ImageStore(
        { bucket: "test-bucket", region: "auto", accessKeyId: "k", secretAccessKey: "s", forcePathStyle: false, prefix: "screenshots/" },
        new FakeS3(),
      ),
  },
];
