import { error } from "../../../../cloudflare/http";
import {
  connectToRoom,
  getShareLink,
  isValidToken,
} from "../../../../cloudflare/shares";

import type { Handler } from "../../../../cloudflare/types";

/** GET /api/share/:token/room — WebSocket: join the shared canvas's room */
export const onRequestGet: Handler<"token"> = async ({
  request,
  env,
  params,
}) => {
  if (!isValidToken(params.token)) {
    return error(404, "link not found");
  }
  const link = await getShareLink(env, params.token);
  if (!link) {
    return error(404, "link not found");
  }
  return connectToRoom(env, request, {
    canvasId: link.canvas_id,
    role: link.mode,
    token: link.token,
  });
};
