import { error, isValidId } from "../../../../cloudflare/http";
import { connectToRoom } from "../../../../cloudflare/shares";

import type { Handler } from "../../../../cloudflare/types";

/** GET /api/canvases/:id/room — WebSocket: join the canvas's live room */
export const onRequestGet: Handler<"id"> = async ({ request, env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid canvas id");
  }
  const canvas = await env.DB.prepare(
    "SELECT id FROM canvases WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(params.id)
    .first();
  if (!canvas) {
    return error(404, "canvas not found");
  }
  return connectToRoom(env, request, {
    canvasId: params.id,
    role: "owner",
    token: null,
  });
};
