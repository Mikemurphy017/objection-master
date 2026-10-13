import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** A stored screenshot, ready to stream back to the browser. */
export interface StoredImage {
  body: Readable;
  contentType: string;
  length?: number;
}

/**
 * Where uploaded screenshots live. Ids are already validated by the caller
 * (32 hex chars plus an image extension), so implementations can use them as keys.
 */
export interface ImageStore {
  /** Human-readable description for the startup log; never includes secrets. */
  readonly summary: string;
  save(id: string, data: Buffer, contentType: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  /** Resolves null when there is no such image. */
  get(id: string): Promise<StoredImage | null>;
  remove(id: string): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const contentTypeFor = (id: string) => CONTENT_TYPES[path.extname(id).slice(1)] ?? "application/octet-stream";

/** Screenshots as files in a directory (the default; put it on a volume in production). */
export class FsImageStore implements ImageStore {
  readonly summary: string;
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.summary = `filesystem at ${dir}`;
    fs.mkdirSync(dir, { recursive: true });
  }

  async save(id: string, data: Buffer): Promise<void> {
    await fs.promises.writeFile(path.join(this.dir, id), data);
  }

  async exists(id: string): Promise<boolean> {
    return fs.existsSync(path.join(this.dir, id));
  }

  async get(id: string): Promise<StoredImage | null> {
    const file = path.join(this.dir, id);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    return { body: fs.createReadStream(file), contentType: contentTypeFor(id), length: stat.size };
  }

  async remove(id: string): Promise<void> {
    await fs.promises.rm(path.join(this.dir, id), { force: true });
  }
}

export interface S3Config {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Key prefix inside the bucket, e.g. "screenshots/". */
  prefix: string;
}

const first = (env: NodeJS.ProcessEnv, names: string[]) => names.map((n) => env[n]?.trim()).find(Boolean);

/**
 * Bucket settings from the environment, or null when no bucket is configured.
 * Accepts Railway's bucket variable names (BUCKET, ENDPOINT, ACCESS_KEY_ID,
 * SECRET_ACCESS_KEY, REGION), the BUCKET_* names from Railway's guides, and the
 * usual S3_* / AWS_* names. A bucket name plus both keys are required.
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const bucket = first(env, ["S3_BUCKET", "BUCKET_NAME", "AWS_S3_BUCKET_NAME", "BUCKET"]);
  const accessKeyId = first(env, ["S3_ACCESS_KEY_ID", "BUCKET_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "ACCESS_KEY_ID"]);
  const secretAccessKey = first(env, [
    "S3_SECRET_ACCESS_KEY",
    "BUCKET_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "SECRET_ACCESS_KEY",
  ]);
  if (!bucket) return null;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`Bucket "${bucket}" is configured but its access key id or secret access key is missing.`);
  }
  const pathStyle = first(env, ["S3_FORCE_PATH_STYLE", "BUCKET_FORCE_PATH_STYLE"]) ?? "";
  return {
    bucket,
    endpoint: first(env, ["S3_ENDPOINT", "BUCKET_ENDPOINT", "AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL", "ENDPOINT"]),
    region: first(env, ["S3_REGION", "BUCKET_REGION", "AWS_REGION", "AWS_DEFAULT_REGION", "REGION"]) ?? "auto",
    accessKeyId,
    secretAccessKey,
    forcePathStyle: /^(1|true|yes)$/i.test(pathStyle),
    prefix: first(env, ["S3_PREFIX"]) ?? "screenshots/",
  };
}

/** The slice of S3Client this store uses, so tests can pass a fake. */
export interface S3Like {
  send(command: unknown): Promise<any>;
}

const isNotFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
};

/** Screenshots in an S3-compatible bucket (Railway Buckets, AWS S3, R2...). The bucket stays private. */
export class S3ImageStore implements ImageStore {
  readonly summary: string;
  private readonly client: S3Like;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: S3Config, client?: S3Like) {
    this.bucket = config.bucket;
    this.prefix = config.prefix;
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      });
    const where = config.endpoint ? new URL(config.endpoint).host : `AWS ${config.region}`;
    this.summary = `bucket "${config.bucket}" at ${where}${config.forcePathStyle ? " (path-style)" : ""}`;
  }

  private key(id: string) {
    return this.prefix + id;
  }

  async save(id: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key(id), Body: data, ContentType: contentType }),
    );
  }

  async exists(id: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async get(id: string): Promise<StoredImage | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
      const body = out.Body instanceof Readable ? out.Body : Readable.fromWeb(out.Body.transformToWebStream());
      return { body, contentType: contentTypeFor(id), length: out.ContentLength };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
  }
}
