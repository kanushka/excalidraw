// Worker that hosts the live collaboration rooms. It has no routes of its
// own: the Pages Functions reach the rooms through their `ROOMS` binding
// (see /wrangler.toml), after checking the Access login or the share link.

export { CanvasRoom } from "./room";

export default {
  fetch: () => new Response("not found", { status: 404 }),
};
