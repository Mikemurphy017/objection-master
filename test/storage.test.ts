import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { poolConfig } from "../src/db-postgres.ts";
import { S3ImageStore, s3ConfigFromEnv } from "../src/images.ts";
import { storageKinds } from "../src/storage.ts";
import { FakeS3 } from "./helpers.ts";

const railwayBucket = {
  BUCKET: "objection-shots-ab12cd",
  ACCESS_KEY_ID: "id",
  SECRET_ACCESS_KEY: "secret",
  REGION: "auto",
  ENDPOINT: "https://t3.storageapi.dev",
};

test("nothing configured: SQLite and filesystem", () => {
  assert.deepEqual(storageKinds({}), { database: "sqlite", images: "filesystem" });
});

test("DATABASE_URL selects Postgres, bucket variables select S3", () => {
  assert.deepEqual(storageKinds({ DATABASE_URL: "postgres://u:p@h/db", ...railwayBucket }), {
    database: "postgres",
    images: "s3",
  });
  assert.deepEqual(storageKinds({ DATABASE_URL: "  " }).database, "sqlite");
  // AWS keys on their own (e.g. for something else) don't turn the bucket on.
  assert.equal(storageKinds({ AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y" }).images, "filesystem");
});

test("Railway's bucket variable names are read as-is", () => {
  assert.deepEqual(s3ConfigFromEnv(railwayBucket), {
    bucket: "objection-shots-ab12cd",
    endpoint: "https://t3.storageapi.dev",
    region: "auto",
    accessKeyId: "id",
    secretAccessKey: "secret",
    forcePathStyle: false,
    prefix: "screenshots/",
  });
});

test("standard S3/AWS names work too, and a half-configured bucket fails loudly", () => {
  const cfg = s3ConfigFromEnv({
    S3_BUCKET: "b",
    AWS_ENDPOINT_URL_S3: "https://s3.example.com",
    AWS_ACCESS_KEY_ID: "id",
    AWS_SECRET_ACCESS_KEY: "secret",
    AWS_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: "true",
  })!;
  assert.equal(cfg.bucket, "b");
  assert.equal(cfg.endpoint, "https://s3.example.com");
  assert.equal(cfg.region, "us-east-1");
  assert.equal(cfg.forcePathStyle, true);
  assert.throws(() => s3ConfigFromEnv({ S3_BUCKET: "b" }), /access key id or secret access key is missing/);
});

test("Postgres SSL: off for private/local hosts, unverified for public, explicit modes win", () => {
  const ssl = (url: string, env = {}) => poolConfig(url, env).ssl;
  assert.equal(ssl("postgresql://u:p@postgres.railway.internal:5432/railway"), false);
  assert.equal(ssl("postgres://u:p@localhost/db"), false);
  assert.equal(ssl("postgres://u:p@db/app"), false);
  assert.deepEqual(ssl("postgresql://u:p@monorail.proxy.rlwy.net:12345/railway"), { rejectUnauthorized: false });
  assert.equal(ssl("postgres://u:p@db.example.com/app?sslmode=disable"), false);
  assert.deepEqual(ssl("postgres://u:p@localhost/db", { PGSSLMODE: "require" }), { rejectUnauthorized: false });
  assert.deepEqual(ssl("postgres://u:p@db.example.com/app?sslmode=verify-full"), { rejectUnauthorized: true });
  assert.throws(() => poolConfig("postgres://u:p@h.example.com/db?sslmode=bogus", {}), /Unknown sslmode/);
  // The URL's ssl params are stripped so pg doesn't override the decision.
  assert.equal(
    poolConfig("postgres://u:p@db.example.com/app?sslmode=require&application_name=om", {}).connectionString,
    "postgres://u:p@db.example.com/app?application_name=om",
  );
});

test("S3 image store puts, checks, streams and deletes under the prefix", async () => {
  const fake = new FakeS3();
  const store = new S3ImageStore({ ...s3ConfigFromEnv(railwayBucket)! }, fake);
  assert.equal(store.summary, 'bucket "objection-shots-ab12cd" at t3.storageapi.dev');
  const id = "0123456789abcdef0123456789abcdef.png";

  assert.equal(await store.exists(id), false);
  assert.equal(await store.get(id), null);
  await store.save(id, Buffer.from("png-bytes"), "image/png");
  assert.deepEqual(fake.calls.at(-1), {
    command: "PutObjectCommand",
    input: { Bucket: "objection-shots-ab12cd", Key: `screenshots/${id}`, Body: Buffer.from("png-bytes"), ContentType: "image/png" },
  });
  assert.equal(await store.exists(id), true);

  const image = (await store.get(id))!;
  assert.equal(image.contentType, "image/png");
  assert.equal(image.length, 9);
  const chunks: Buffer[] = [];
  for await (const c of image.body) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), "png-bytes");

  await store.remove(id);
  assert.equal(await store.exists(id), false);
  assert.deepEqual(
    fake.calls.map((c) => c.command),
    ["HeadObjectCommand", "GetObjectCommand", "PutObjectCommand", "HeadObjectCommand", "GetObjectCommand", "DeleteObjectCommand", "HeadObjectCommand"],
  );
});

test("S3 errors other than not-found propagate", async () => {
  const store = new S3ImageStore(s3ConfigFromEnv(railwayBucket)!, {
    send: async () => {
      throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    },
  });
  await assert.rejects(store.exists("x.png"), /AccessDenied/);
  await assert.rejects(store.get("x.png"), /AccessDenied/);
});

test("S3 image store works with the real S3Client against an S3-shaped HTTP server", async () => {
  // Tiny path-style S3 stand-in: PUT/GET/HEAD/DELETE on /<bucket>/<key>.
  const objects = new Map<string, Buffer>();
  const server = http.createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    if (req.method === "PUT") objects.set(key, Buffer.concat(chunks));
    else if (req.method === "DELETE") objects.delete(key);
    else if (!objects.has(key)) {
      res.writeHead(404, { "Content-Type": "application/xml" });
      return res.end(req.method === "HEAD" ? undefined : "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
    } else {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": objects.get(key)!.length });
      return res.end(req.method === "HEAD" ? undefined : objects.get(key));
    }
    res.writeHead(req.method === "DELETE" ? 204 : 200).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const store = new S3ImageStore({
      ...s3ConfigFromEnv({ ...railwayBucket, ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })!,
      forcePathStyle: true,
    });
    const id = "fedcba9876543210fedcba9876543210.png";
    assert.equal(await store.get(id), null);
    assert.equal(await store.exists(id), false);
    await store.save(id, Buffer.from("real-sdk"), "image/png");
    assert.ok(objects.has(`/objection-shots-ab12cd/screenshots/${id}`));
    assert.equal(await store.exists(id), true);
    const chunks: Buffer[] = [];
    for await (const c of (await store.get(id))!.body) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), "real-sdk");
    await store.remove(id);
    assert.equal(objects.size, 0);
  } finally {
    server.close();
  }
});
