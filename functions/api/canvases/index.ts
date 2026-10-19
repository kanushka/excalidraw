import {
  error,
  isValidId,
  json,
  sanitizeName,
  toCanvasMeta,
} from "../../../cloudflare/http";

import type { CanvasRow } from "../../../cloudflare/http";
import type { Handler } from "../../../cloudflare/types";

/** GET /api/canvases — list canvases, most recently edited first */
export const onRequestGet: Handler = async ({ env }) => {
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at, updated_at FROM canvases WHERE deleted_at IS NULL ORDER BY updated_at DESC",
  ).all<CanvasRow>();
  return json(results.map(toCanvasMeta));
};

/** POST /api/canvases { id, name } — create an empty canvas */
export const onRequestPost: Handler = async ({ request, env }) => {
  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
    name?: unknown;
  } | null;
  if (!body || !isValidId(body.id)) {
    return error(400, "invalid canvas id");
  }
  const name = sanitizeName(body.name) ?? "Untitled";
  const now = Date.now();
  const { meta } = await env.DB.prepare(
    "INSERT INTO canvases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(body.id, name, now, now)
    .run();
  if (!meta.changes) {
    return error(409, "canvas already exists");
  }
  return json(
    toCanvasMeta({ id: body.id, name, created_at: now, updated_at: now }),
    201,
  );
};
