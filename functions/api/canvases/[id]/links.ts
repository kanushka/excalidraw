import { error, isValidId, json } from "../../../../cloudflare/http";
import {
  generateToken,
  isShareMode,
  toShareLinkMeta,
} from "../../../../cloudflare/shares";

import type { ShareLinkRow } from "../../../../cloudflare/shares";
import type { Handler } from "../../../../cloudflare/types";

/** GET /api/canvases/:id/links — the canvas's active share links */
export const onRequestGet: Handler<"id"> = async ({ request, env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid canvas id");
  }
  const { results } = await env.DB.prepare(
    `SELECT token, canvas_id, mode, created_at FROM share_links
     WHERE canvas_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(params.id)
    .all<ShareLinkRow>();
  return json(results.map((row) => toShareLinkMeta(env, request, row)));
};

/** POST /api/canvases/:id/links { mode: "view" | "edit" } — create a link */
export const onRequestPost: Handler<"id"> = async ({
  request,
  env,
  params,
}) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid canvas id");
  }
  const body = (await request.json().catch(() => null)) as {
    mode?: unknown;
  } | null;
  if (!isShareMode(body?.mode)) {
    return error(400, 'mode must be "view" or "edit"');
  }
  const canvas = await env.DB.prepare(
    "SELECT id FROM canvases WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(params.id)
    .first();
  if (!canvas) {
    return error(404, "canvas not found");
  }
  const row: ShareLinkRow = {
    token: generateToken(),
    canvas_id: params.id,
    mode: body!.mode as ShareLinkRow["mode"],
    created_at: Date.now(),
  };
  await env.DB.prepare(
    "INSERT INTO share_links (token, canvas_id, mode, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(row.token, row.canvas_id, row.mode, row.created_at)
    .run();
  return json(toShareLinkMeta(env, request, row), 201);
};
