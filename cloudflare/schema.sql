-- D1 schema for the canvas list. Apply with:
--   npx wrangler d1 execute excalidraw --remote --file=cloudflare/schema.sql
CREATE TABLE IF NOT EXISTS canvases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  thumbnail_key TEXT,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS canvases_updated_at ON canvases(updated_at DESC);

-- Share links: each token opens one canvas, read-only ("view") or editable
-- ("edit"), without Cloudflare Access. Revoked links keep `revoked_at`.
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('view', 'edit')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_links_canvas_id ON share_links(canvas_id);
