// Live collaboration room for one canvas: a Durable Object that relays scene
// changes, cursors and follow requests between the canvas's owner and its
// share link holders, and keeps the canvas in R2 up to date.
//
// The protocol mirrors the excalidraw-room socket server the app was written
// for (excalidraw-app/collab), as JSON arrays `[event, ...args]` over a plain
// WebSocket, with two differences: payloads aren't end-to-end encrypted, so
// the room can enforce read-only links and save the scene itself, and the room
// sends a joining client the whole scene instead of asking a peer for it.
//
// Uses the WebSocket Hibernation API: the object is evicted from memory while
// its sockets are idle, so per-socket state lives in socket attachments and
// the scene is reloaded from R2 when needed.

import type { RoomRole } from "../shares";
import type { D1Database, R2Bucket } from "../types";

export interface RoomEnv {
  BUCKET: R2Bucket;
  DB: D1Database;
}

interface HibernatableWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
}

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

type SocketState = {
  id: string;
  role: RoomRole;
  /** the share link the socket joined with */
  token: string | null;
  joined: boolean;
  /** socket ids of the users this one follows */
  following: string[];
};

type SceneElement = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  index?: string | null;
  type?: string;
  fileId?: string | null;
};

type Scene = {
  /** the stored .excalidraw document, `elements` excepted */
  doc: Record<string, unknown> & { appState: Record<string, unknown> };
  /** includes deleted elements, so stale updates can't resurrect them */
  elements: Map<string, SceneElement>;
};

/** what read-only link holders may broadcast */
const VIEWER_MESSAGE_TYPES = new Set([
  "MOUSE_LOCATION",
  "IDLE_STATUS",
  "USER_VISIBLE_SCENE_BOUNDS",
]);

/** canvas settings collaborators share (others are per user) */
const SHARED_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
];

const SAVE_DELAY = 1000;

/** close codes the app reads (excalidraw-app/collab/CanvasRoomSocket.ts) */
export const CLOSE_CODES = {
  LINK_REVOKED: 4001,
  CANVAS_DELETED: 4004,
} as const;

const sceneKey = (canvasId: string) => `canvases/${canvasId}.excalidraw`;

const isSceneElement = (value: unknown): value is SceneElement =>
  !!value &&
  typeof value === "object" &&
  typeof (value as SceneElement).id === "string" &&
  typeof (value as SceneElement).version === "number" &&
  typeof (value as SceneElement).versionNonce === "number";

/** same rule as `reconcileElements` in @excalidraw/excalidraw */
const isNewer = (remote: SceneElement, local: SceneElement | undefined) =>
  !local ||
  remote.version > local.version ||
  (remote.version === local.version &&
    remote.versionNonce < local.versionNonce);

const compareIndex = (a: SceneElement, b: SceneElement) => {
  // fractional indices order as plain strings; unindexed elements go last
  if (a.index === b.index) {
    return 0;
  }
  if (a.index == null) {
    return 1;
  }
  if (b.index == null) {
    return -1;
  }
  return a.index < b.index ? -1 : 1;
};

const pickSharedAppState = (appState: unknown) => {
  const picked: Record<string, unknown> = {};
  if (appState && typeof appState === "object") {
    for (const key of SHARED_APP_STATE_KEYS) {
      if (key in appState) {
        picked[key] = (appState as Record<string, unknown>)[key];
      }
    }
  }
  return picked;
};

export class CanvasRoom {
  private scene: Promise<Scene> | null = null;
  private isDirty = false;
  // a pending timer also keeps the object from hibernating (and losing the
  // unsaved scene) until it's saved
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: DurableObjectState, private env: RoomEnv) {}

  // ---------------------------------------------------------------------------
  // requests from the Pages Functions (cloudflare/shares.ts)
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const canvasId = request.headers.get("x-canvas-id");
    if (!canvasId) {
      return new Response("missing canvas id", { status: 400 });
    }
    if ((await this.ctx.storage.get<string>("canvasId")) !== canvasId) {
      await this.ctx.storage.put("canvasId", canvasId);
    }

    switch (url.pathname) {
      case "/connect":
        return this.connect(request);
      case "/has-file": {
        const fileId = url.searchParams.get("id");
        const scene = await this.getScene();
        const hasFile = [...scene.elements.values()].some(
          (element) => element.type === "image" && element.fileId === fileId,
        );
        return new Response(null, { status: hasFile ? 204 : 404 });
      }
      case "/disconnect": {
        const { token } = (await request.json()) as { token: string | null };
        for (const ws of this.ctx.getWebSockets()) {
          const state = this.getState(ws);
          if (token ? state.token === token : state.role !== "owner") {
            ws.close(
              token ? CLOSE_CODES.LINK_REVOKED : CLOSE_CODES.CANVAS_DELETED,
              token ? "link revoked" : "canvas deleted",
            );
          }
        }
        this.broadcastUsers();
        return new Response(null, { status: 204 });
      }
    }
    return new Response("not found", { status: 404 });
  }

  private connect(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const role = request.headers.get("x-room-role") as RoomRole;
    if (role !== "owner" && role !== "edit" && role !== "view") {
      return new Response("invalid role", { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1] as HibernatableWebSocket;
    this.ctx.acceptWebSocket(server);
    const state: SocketState = {
      id: crypto.randomUUID(),
      role,
      token: request.headers.get("x-room-token") || null,
      joined: false,
      following: [],
    };
    server.serializeAttachment(state);
    this.send(server, "connected", state.id, role);
    this.send(server, "init-room");
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit);
  }

  // ---------------------------------------------------------------------------
  // WebSocket events
  // ---------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message),
      );
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
      return;
    }
    const [event, ...args] = parsed as [string, ...any[]];
    const state = this.getState(ws);

    switch (event) {
      case "join-room": {
        if (!state.joined) {
          state.joined = true;
          this.setState(ws, state);
        }
        const scene = await this.getScene();
        this.send(ws, "client-broadcast", {
          type: "SCENE_INIT",
          payload: { elements: [...scene.elements.values()] },
        });
        this.send(
          ws,
          "canvas-app-state",
          pickSharedAppState(scene.doc.appState),
        );
        this.broadcastUsers();
        break;
      }
      case "server-broadcast":
      case "server-volatile-broadcast": {
        const [roomId, data] = args;
        if (!state.joined || !data || typeof data.type !== "string") {
          return;
        }
        if (state.role === "view" && !VIEWER_MESSAGE_TYPES.has(data.type)) {
          return;
        }
        if (data.type === "SCENE_INIT" || data.type === "SCENE_UPDATE") {
          await this.mergeElements(data.payload?.elements);
        }
        const followed =
          typeof roomId === "string" && roomId.startsWith("follow@")
            ? roomId.slice("follow@".length)
            : null;
        for (const other of this.getJoinedSockets(ws)) {
          if (!followed || this.getState(other).following.includes(followed)) {
            this.send(other, "client-broadcast", data);
          }
        }
        break;
      }
      case "user-follow": {
        const payload = args[0];
        const target = payload?.userToFollow?.socketId;
        if (typeof target !== "string") {
          return;
        }
        state.following = state.following.filter((id) => id !== target);
        if (payload.action === "FOLLOW") {
          state.following.push(target);
        }
        this.setState(ws, state);
        this.sendFollowers(target);
        break;
      }
      case "canvas-app-state": {
        if (state.role === "view") {
          return;
        }
        const appState = pickSharedAppState(args[0]);
        const scene = await this.getScene();
        scene.doc.appState = { ...scene.doc.appState, ...appState };
        this.scheduleSave();
        for (const other of this.getJoinedSockets(ws)) {
          this.send(other, "canvas-app-state", appState);
        }
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const state = this.getState(ws);
    try {
      ws.close(code, reason);
    } catch {}
    this.broadcastUsers(ws);
    for (const followed of state.following) {
      this.sendFollowers(followed, ws);
    }
    if (!this.getJoinedSockets(ws).length) {
      // last one out: save now rather than after the delay
      await this.save();
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011, "error");
  }

  // ---------------------------------------------------------------------------
  // sockets
  // ---------------------------------------------------------------------------

  private getState(ws: WebSocket) {
    return (ws as HibernatableWebSocket).deserializeAttachment() as SocketState;
  }

  private setState(ws: WebSocket, state: SocketState) {
    (ws as HibernatableWebSocket).serializeAttachment(state);
  }

  private send(ws: WebSocket, event: string, ...args: unknown[]) {
    try {
      ws.send(JSON.stringify([event, ...args]));
    } catch {
      // closed in the meantime
    }
  }

  /** the open, joined sockets, optionally except one */
  private getJoinedSockets(except?: WebSocket) {
    return this.ctx
      .getWebSockets()
      .filter(
        (ws) =>
          ws !== except &&
          ws.readyState === WebSocket.OPEN &&
          this.getState(ws).joined,
      );
  }

  private broadcastUsers(except?: WebSocket) {
    const sockets = this.getJoinedSockets(except);
    const ids = sockets.map((ws) => this.getState(ws).id);
    for (const ws of sockets) {
      this.send(ws, "room-user-change", ids);
    }
  }

  /** tells a user who follows them */
  private sendFollowers(socketId: string, except?: WebSocket) {
    const sockets = this.getJoinedSockets(except);
    const target = sockets.find((ws) => this.getState(ws).id === socketId);
    if (target) {
      const followers = sockets
        .map((ws) => this.getState(ws))
        .filter((state) => state.following.includes(socketId))
        .map((state) => state.id);
      this.send(target, "user-follow-room-change", followers);
    }
  }

  // ---------------------------------------------------------------------------
  // scene
  // ---------------------------------------------------------------------------

  private getCanvasId() {
    return this.ctx.storage.get<string>("canvasId");
  }

  private getScene() {
    if (!this.scene) {
      this.scene = this.loadScene().catch((error) => {
        this.scene = null;
        throw error;
      });
    }
    return this.scene;
  }

  private async loadScene(): Promise<Scene> {
    const canvasId = await this.getCanvasId();
    const object = canvasId
      ? await this.env.BUCKET.get(sceneKey(canvasId))
      : null;
    let doc: Record<string, any> | null = null;
    if (object) {
      try {
        doc = JSON.parse(await object.text());
      } catch (error) {
        console.error("stored scene isn't valid JSON", error);
        throw error;
      }
    }
    const elements = new Map<string, SceneElement>();
    for (const element of Array.isArray(doc?.elements) ? doc!.elements : []) {
      if (isSceneElement(element)) {
        elements.set(element.id, element);
      }
    }
    const { elements: _, ...rest } = doc || {};
    return {
      doc: {
        type: "excalidraw",
        version: 2,
        source: "excalidraw-collab",
        files: {},
        ...rest,
        appState: rest.appState || {},
      },
      elements,
    };
  }

  private async mergeElements(elements: unknown) {
    if (!Array.isArray(elements)) {
      return;
    }
    const scene = await this.getScene();
    let changed = false;
    for (const element of elements) {
      if (
        isSceneElement(element) &&
        isNewer(element, scene.elements.get(element.id))
      ) {
        scene.elements.set(element.id, element);
        changed = true;
      }
    }
    if (changed) {
      this.scheduleSave();
    }
  }

  private scheduleSave(delay = SAVE_DELAY) {
    this.isDirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.save();
      }, delay);
    }
  }

  private async save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.isDirty || !this.scene) {
      return;
    }
    this.isDirty = false;
    const canvasId = await this.getCanvasId();
    if (!canvasId) {
      return;
    }
    try {
      const scene = await this.scene;
      const { meta } = await this.env.DB.prepare(
        "UPDATE canvases SET updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
        .bind(Date.now(), canvasId)
        .run();
      if (!meta.changes) {
        // deleted canvas: leave its last saved scene as it was
        return;
      }
      const elements = [...scene.elements.values()]
        .filter((element) => !element.isDeleted)
        .sort(compareIndex);
      await this.env.BUCKET.put(
        sceneKey(canvasId),
        JSON.stringify({ ...scene.doc, elements }),
        { httpMetadata: { contentType: "application/json" } },
      );
    } catch (error) {
      console.error("failed to save canvas", error);
      this.scheduleSave(SAVE_DELAY * 5);
    }
  }
}
