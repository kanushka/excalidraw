import { error } from "../../../cloudflare/http";
import { disconnectGuests, isValidToken } from "../../../cloudflare/shares";

import type { Handler } from "../../../cloudflare/types";

/** DELETE /api/links/:token — revoke a share link and disconnect its guests */
export const onRequestDelete: Handler<"token"> = async ({ env, params }) => {
  if (!isValidToken(params.token)) {
    return error(400, "invalid link");
  }
  const link = await env.DB.prepare(
    "SELECT canvas_id FROM share_links WHERE token = ? AND revoked_at IS NULL",
  )
    .bind(params.token)
    .first<{ canvas_id: string }>();
  if (!link) {
    return error(404, "link not found");
  }
  await env.DB.prepare("UPDATE share_links SET revoked_at = ? WHERE token = ?")
    .bind(Date.now(), params.token)
    .run();
  await disconnectGuests(env, link.canvas_id, params.token);
  return new Response(null, { status: 204 });
};
