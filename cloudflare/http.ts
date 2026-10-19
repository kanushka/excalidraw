export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export const error = (status: number, message: string) =>
  json({ error: message }, status);

// canvas and file ids are generated client-side (nanoid / excalidraw file ids)
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export const isValidId = (id: unknown): id is string =>
  typeof id === "string" && ID_RE.test(id);

export const canvasSceneKey = (id: string) => `canvases/${id}.excalidraw`;
export const fileKey = (id: string) => `files/${id}`;

export type CanvasRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
};

export const toCanvasMeta = (row: CanvasRow) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const MAX_NAME_LENGTH = 200;

export const sanitizeName = (name: unknown) =>
  typeof name === "string" && name.trim()
    ? name.trim().slice(0, MAX_NAME_LENGTH)
    : null;
