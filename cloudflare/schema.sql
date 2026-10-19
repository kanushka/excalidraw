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
