import {
  canvasSceneKey,
  error,
  isValidId,
  json,
  sanitizeName,
  toCanvasMeta,
} from "../../../../cloudflare/http";
import { disconnectGuests } from "../../../../cloudflare/shares";

import type { CanvasRow } from "../../../../cloudflare/http";
import type { Env, Handler } from "../../../../cloudflare/types";

const MAX_SCENE_SIZE = 50 * 1024 * 1024;

const getCanvas = (env: Env, id: string) =>
  env.DB.prepare(
    "SELECT id, name, created_at, updated_at FROM canvases WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(id)
    .first<CanvasRow>();

/** GET /api/canvases/:id — the canvas scene (.excalidraw JSON) */
export const onRequestGet: Handler<"id"> = async ({ env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid canvas id");
  }
  const canvas = await getCanvas(env, params.id);
  if (!canvas) {
    return error(404, "canvas not found");
  }
  const object = await env.BUCKET.get(canvasSceneKey(params.id));
  return new Response(object ? object.body : "null", {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-canvas-name": encodeURIComponent(canvas.name),
    },
  });
};

/** PUT /api/canvases/:id — save the canvas scene, creating the canvas if needed */
export const onRequestPut: Handler<"id"> = async ({ request, env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid canvas id");
  }
  const scene = await request.text();
  if (scene.length > MAX_SCENE_SIZE) {
    return error(413, "scene too large");
  }
  try {
    JSON.parse(scene);
  } catch {
    return error(400, "scene must be valid JSON");
  }

  const now = Date.now();
  await env.BUCKET.put(canvasSceneKey(params.id), scene, {
    httpMetadata: { contentType: "application/json" },
  });
  await env.DB.prepare(
    `INSERT INTO canvases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted_at = NULL`,
  )
    .bind(params.id, "Untitled", now, now)
    .run();

  const canvas = await getCanvas(env, params.id);
  return json(canvas && toCanvasMeta(canvas));
};

/** PATCH /api/canvases/:id { name } — rename */
export const onRequestPatch: Handler<"id"> = async ({
  request,
  env,
  params,
}) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid canvas id");
  }
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
  } | null;
  const name = sanitizeName(body?.name);
  if (!name) {
    return error(400, "invalid name");
  }
  const { meta } = await env.DB.prepare(
    "UPDATE canvases SET name = ? WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(name, params.id)
    .run();
  if (!meta.changes) {
    return error(404, "canvas not found");
  }
  const canvas = await getCanvas(env, params.id);
  return json(canvas && toCanvasMeta(canvas));
};

/**
 * DELETE /api/canvases/:id — soft delete: the row is kept with `deleted_at`
 * and the scene object stays in R2, so a deleted canvas can be restored by
 * hand. Image files are shared between canvases and are never deleted here.
 * Its share links stop working, and guests in its room are disconnected.
 */
export const onRequestDelete: Handler<"id"> = async ({ env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid canvas id");
  }
  const { meta } = await env.DB.prepare(
    "UPDATE canvases SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(Date.now(), params.id)
    .run();
  if (!meta.changes) {
    return error(404, "canvas not found");
  }
  await disconnectGuests(env, params.id);
  return new Response(null, { status: 204 });
};
