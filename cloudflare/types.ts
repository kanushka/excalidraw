// Minimal subset of the Cloudflare runtime types used by the canvas API, so
// the functions don't need `@cloudflare/workers-types` as a dependency.

export interface R2ObjectBody {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
  text(): Promise<string>;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<object | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  /** e.g. `myteam.cloudflareaccess.com` */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Cloudflare Access application */
  ACCESS_AUD?: string;
  /** set to "true" to serve the API without Cloudflare Access (local dev) */
  ALLOW_UNAUTHENTICATED?: string;
}

export interface Context<Params extends string = never> {
  request: Request;
  env: Env;
  params: Record<Params, string>;
  next(): Promise<Response>;
}

export type Handler<Params extends string = never> = (
  context: Context<Params>,
) => Promise<Response> | Response;
