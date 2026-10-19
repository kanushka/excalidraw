// Multiple canvases persisted to a server-side canvas API (Cloudflare Pages
// Functions, see /functions/api). Enabled when `VITE_APP_CANVAS_API_URL` is
// set; otherwise the app keeps excalidraw.com's single local canvas.
//
// localStorage/IndexedDB (LocalData) remain the local cache of the canvas
// currently open in this tab. The server is the source of truth, except when
// the local cache holds changes that haven't reached the server yet ("dirty"),
// e.g. after editing offline.

import { isInitializedImageElement } from "@excalidraw/element";
import { randomId } from "@excalidraw/common";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";

import { LocalData } from "./LocalData";

export type CanvasMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type CanvasScene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
};

const API_URL = (import.meta.env.VITE_APP_CANVAS_API_URL || "").replace(
  /\/$/,
  "",
);

const SERVER_SAVE_TIMEOUT = 1000;

export const isCanvasStoreEnabled = () => !!API_URL;

// -----------------------------------------------------------------------------
// API client
// -----------------------------------------------------------------------------

class CanvasApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const request = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "same-origin",
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = (await res.json()).error || message;
    } catch {}
    throw new CanvasApiError(message, res.status);
  }
  return res;
};

export const listCanvases = async (): Promise<CanvasMeta[]> =>
  (await request("/canvases")).json();

export const createCanvas = async (name: string): Promise<CanvasMeta> =>
  (
    await request("/canvases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: randomId(), name }),
    })
  ).json();

export const renameCanvas = async (
  id: string,
  name: string,
): Promise<CanvasMeta> =>
  (
    await request(`/canvases/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
  ).json();

export const deleteCanvas = async (id: string) => {
  await request(`/canvases/${id}`, { method: "DELETE" });
};

/** returns `null` if the canvas doesn't exist */
const loadCanvasScene = async (
  id: string,
): Promise<{ name: string; scene: CanvasScene | null } | null> => {
  try {
    const res = await request(`/canvases/${id}`);
    const name = decodeURIComponent(res.headers.get("x-canvas-name") || "");
    const data = await res.json();
    return {
      name,
      scene: data
        ? { elements: data.elements || [], appState: data.appState || {} }
        : null,
    };
  } catch (error: any) {
    if (error instanceof CanvasApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
};

const saveCanvasScene = async (id: string, serializedScene: string) => {
  await request(`/canvases/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: serializedScene,
  });
};

/** file id -> version of the file known to be stored on the server */
const storedFileVersions = new Map<FileId, number>();

const getFileVersion = (file: BinaryFileData) => file.version ?? 1;

const isFileStored = (file: BinaryFileData) =>
  storedFileVersions.get(file.id) === getFileVersion(file);

const uploadFile = async (file: BinaryFileData) => {
  if (!storedFileVersions.has(file.id) && getFileVersion(file) === 1) {
    // likely uploaded in an earlier session
    try {
      await request(`/files/${file.id}`, { method: "HEAD" });
      storedFileVersions.set(file.id, 1);
      return;
    } catch (error: any) {
      if (!(error instanceof CanvasApiError && error.status === 404)) {
        throw error;
      }
    }
  }
  await request(`/files/${file.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: file.id,
      mimeType: file.mimeType,
      dataURL: file.dataURL,
      created: file.created,
      version: file.version,
    }),
  });
  storedFileVersions.set(file.id, getFileVersion(file));
};

export const loadFilesFromCanvasStore = async (fileIds: readonly FileId[]) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(fileIds)].map(async (id) => {
      try {
        const data: BinaryFileData = await (
          await request(`/files/${id}`)
        ).json();
        loadedFiles.push({ ...data, lastRetrieved: Date.now() });
        storedFileVersions.set(id, getFileVersion(data));
      } catch (error: any) {
        console.error(error);
        erroredFiles.set(id, true);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

/** loads image files from the local cache, falling back to the server */
export const loadCanvasFiles = async (fileIds: readonly FileId[]) => {
  const local = fileIds.length
    ? await LocalData.fileStorage.getFiles([...fileIds])
    : { loadedFiles: [], erroredFiles: new Map<FileId, true>() };
  if (!local.erroredFiles.size) {
    return local;
  }
  const remote = await loadFilesFromCanvasStore([...local.erroredFiles.keys()]);
  return {
    loadedFiles: [...local.loadedFiles, ...remote.loadedFiles],
    erroredFiles: remote.erroredFiles,
  };
};

export const getSceneFileIds = (elements: readonly ExcalidrawElement[]) => {
  const fileIds = new Set<FileId>();
  for (const element of elements) {
    if (!element.isDeleted && isInitializedImageElement(element)) {
      fileIds.add(element.fileId);
    }
  }
  return [...fileIds];
};

// -----------------------------------------------------------------------------
// current canvas
// -----------------------------------------------------------------------------

const CANVAS_URL_PARAM = "canvas";

/** the canvas open in this tab (other tabs may have other canvases open) */
let currentCanvasId: string | null = null;

const storage = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null) => {
    try {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    } catch (error) {
      console.error(error);
    }
  },
};

export const getCurrentCanvasId = () => currentCanvasId;

/** whether the local cache (LocalData) holds this tab's canvas */
export const isLocalCacheOfCurrentCanvas = () =>
  !!currentCanvasId &&
  storage.get(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_ID) === currentCanvasId;

const setCurrentCanvasId = (id: string) => {
  currentCanvasId = id;
  storage.set(STORAGE_KEYS.LOCAL_STORAGE_LAST_CANVAS_ID, id);
  const url = new URL(window.location.href);
  if (url.searchParams.get(CANVAS_URL_PARAM) !== id) {
    url.searchParams.set(CANVAS_URL_PARAM, id);
    window.history.replaceState({}, "", url.toString());
  }
};

/** re-adds the canvas param if something reset the URL */
export const syncCanvasIdToUrl = () => {
  if (currentCanvasId) {
    setCurrentCanvasId(currentCanvasId);
  }
};

// -----------------------------------------------------------------------------
// saving
// -----------------------------------------------------------------------------

let pendingSave: {
  canvasId: string;
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
} | null = null;
let saveTimer: number | null = null;
let inFlightSave: Promise<void> = Promise.resolve();
const lastSavedScenes = new Map<string, string>();

const listeners = new Set<(status: CanvasSaveStatus) => void>();
export type CanvasSaveStatus = "saved" | "saving" | "error";
let saveStatus: CanvasSaveStatus = "saved";

const setSaveStatus = (status: CanvasSaveStatus) => {
  saveStatus = status;
  listeners.forEach((listener) => listener(status));
};

export const getCanvasSaveStatus = () => saveStatus;
export const subscribeToCanvasSaveStatus = (
  listener: (status: CanvasSaveStatus) => void,
) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const serializeScene = (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
) =>
  serializeAsJSON(
    elements.filter((element) => !element.isDeleted),
    appState,
    {},
    "database",
  );

const runSave = async () => {
  const save = pendingSave;
  pendingSave = null;
  if (!save) {
    return;
  }

  const serialized = serializeScene(save.elements, save.appState);
  const filesToUpload = getSceneFileIds(save.elements)
    .map((id) => save.files[id])
    .filter((file) => file && !isFileStored(file));

  const markSaved = () => {
    if (!pendingSave) {
      if (
        storage.get(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_DIRTY) === save.canvasId
      ) {
        storage.set(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_DIRTY, null);
      }
      setSaveStatus("saved");
    }
  };

  if (
    lastSavedScenes.get(save.canvasId) === serialized &&
    !filesToUpload.length
  ) {
    markSaved();
    return;
  }

  setSaveStatus("saving");
  try {
    // upload images first so a saved scene never references missing files
    await Promise.all(filesToUpload.map(uploadFile));
    await saveCanvasScene(save.canvasId, serialized);
    lastSavedScenes.set(save.canvasId, serialized);
    markSaved();
  } catch (error: any) {
    console.error("failed to save canvas", error);
    // retry with the latest state on the next change or flush
    pendingSave = pendingSave || save;
    setSaveStatus("error");
    throw error;
  }
};

const startSave = () => {
  inFlightSave = inFlightSave.catch(() => {}).then(runSave);
  return inFlightSave;
};

/**
 * Call on every scene change, together with LocalData.save (which writes the
 * same state to the local cache).
 */
export const scheduleCanvasSave = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) => {
  if (!currentCanvasId) {
    return;
  }
  // the local cache now holds this canvas, ahead of the server until saved
  storage.set(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_ID, currentCanvasId);
  storage.set(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_DIRTY, currentCanvasId);
  pendingSave = { canvasId: currentCanvasId, elements, appState, files };
  if (saveStatus !== "saving") {
    setSaveStatus("saving");
  }
  if (saveTimer) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    startSave().catch(() => {});
  }, SERVER_SAVE_TIMEOUT);
};

/** saves pending changes now; rejects if the server can't be reached */
export const flushCanvasSave = async () => {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  await inFlightSave.catch(() => {});
  if (pendingSave) {
    await startSave();
  }
};

// -----------------------------------------------------------------------------
// loading
// -----------------------------------------------------------------------------

export type LoadedCanvasScene = {
  canvas: { id: string; name: string };
  scene: CanvasScene;
};

export type LoadedCanvas = {
  canvas: { id: string; name: string };
  /** `null` = use the local cache as is (it's newer than the server) */
  scene: CanvasScene | null;
};

/**
 * Picks the canvas to open on startup (URL param, else last opened, else the
 * most recently edited, else a new one seeded from the local cache) and loads
 * it.
 */
export const loadInitialCanvas = async (
  localScene: CanvasScene,
): Promise<LoadedCanvas> => {
  const url = new URL(window.location.href);
  let id =
    url.searchParams.get(CANVAS_URL_PARAM) ||
    storage.get(STORAGE_KEYS.LOCAL_STORAGE_LAST_CANVAS_ID);

  const localCanvasId = storage.get(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_ID);
  const isLocalDirty =
    !!id && storage.get(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_DIRTY) === id;

  if (id) {
    try {
      const loaded = await loadCanvasScene(id);
      if (loaded) {
        setCurrentCanvasId(id);
        if (isLocalDirty && localCanvasId === id) {
          // unsynced local edits win; they'll be saved on the next change
          return { canvas: { id, name: loaded.name }, scene: null };
        }
        if (loaded.scene) {
          lastSavedScenes.set(
            id,
            serializeScene(loaded.scene.elements, loaded.scene.appState),
          );
        }
        return {
          canvas: { id, name: loaded.name },
          scene: loaded.scene || { elements: [], appState: {} },
        };
      }
    } catch (error) {
      // offline: fall back to the local cache if it holds this canvas
      if (localCanvasId === id) {
        console.warn("canvas API unreachable, using local cache", error);
        setCurrentCanvasId(id);
        return { canvas: { id, name: "" }, scene: null };
      }
      throw error;
    }
  }

  // requested canvas doesn't exist (or none requested)
  const canvases = await listCanvases();
  if (canvases.length) {
    id = canvases[0].id;
    const loaded = await loadCanvasScene(id);
    setCurrentCanvasId(id);
    const scene = loaded?.scene || { elements: [], appState: {} };
    lastSavedScenes.set(id, serializeScene(scene.elements, scene.appState));
    return { canvas: { id, name: canvases[0].name }, scene };
  }

  // first run: migrate the single local canvas
  const canvas = await createCanvas("My first canvas");
  setCurrentCanvasId(canvas.id);
  storage.set(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_ID, canvas.id);
  if (localScene.elements.length) {
    await saveCanvasScene(
      canvas.id,
      serializeScene(localScene.elements, localScene.appState),
    );
  }
  return { canvas: { id: canvas.id, name: canvas.name }, scene: null };
};

/**
 * Saves the open canvas and loads another one. Rejects without switching if
 * the open canvas's changes can't be saved.
 */
export const openCanvas = async (id: string): Promise<LoadedCanvasScene> => {
  await flushCanvasSave();
  const loaded = await loadCanvasScene(id);
  if (!loaded) {
    throw new Error("Canvas not found");
  }
  const scene = loaded.scene || { elements: [], appState: {} };
  lastSavedScenes.set(id, serializeScene(scene.elements, scene.appState));
  setCurrentCanvasId(id);
  storage.set(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_ID, id);
  storage.set(STORAGE_KEYS.LOCAL_STORAGE_CANVAS_DIRTY, null);
  return { canvas: { id, name: loaded.name }, scene };
};
