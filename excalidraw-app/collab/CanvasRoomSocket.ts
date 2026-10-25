// Client for a canvas's live room (cloudflare/collab/room.ts). It exposes the
// part of the socket.io client API that Collab and Portal use, so they work
// unchanged against the room: messages are JSON arrays `[event, ...args]`.
//
// Unlike socket.io it doesn't buffer while disconnected. It reconnects on
// its own, and the room then sends the whole scene again (see Collab).

type Listener = ((...args: any[]) => void) & { original?: Listener };

/** close codes sent by the room when a guest has to leave for good */
export const ROOM_CLOSE_CODES = {
  LINK_REVOKED: 4001,
  CANVAS_DELETED: 4004,
} as const;

const MAX_RECONNECT_DELAY = 30_000;

export class CanvasRoomSocket {
  id: string | undefined = undefined;
  connected = false;

  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private isClosed = false;
  private hasConnected = false;
  private reconnectDelay = 1000;
  private reconnectTimer: number | null = null;

  constructor(private url: string) {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(message) || typeof message[0] !== "string") {
        return;
      }
      const [name, ...args] = message;
      if (name === "connected") {
        this.id = args[0];
        this.connected = true;
        this.hasConnected = true;
        this.reconnectDelay = 1000;
        this.dispatch("connect");
        return;
      }
      this.dispatch(name, ...args);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) {
        return;
      }
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      if (this.isClosed) {
        return;
      }
      if (event.code >= 4000 && event.code < 5000) {
        // closed by the room on purpose: don't come back
        this.isClosed = true;
        this.dispatch("room-closed", event.code, event.reason);
        return;
      }
      this.dispatch(
        this.hasConnected ? "disconnect" : "connect_error",
        wasConnected ? event.reason : undefined,
      );
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        MAX_RECONNECT_DELAY,
      );
    };
  }

  private dispatch(name: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(name) || [])]) {
      listener(...args);
    }
  }

  on(name: string, listener: Listener) {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, new Set());
    }
    this.listeners.get(name)!.add(listener);
    return this;
  }

  once(name: string, listener: Listener) {
    const wrapped: Listener = (...args) => {
      this.off(name, wrapped);
      listener(...args);
    };
    wrapped.original = listener;
    return this.on(name, wrapped);
  }

  off(name?: string, listener?: Listener) {
    if (!name) {
      this.listeners.clear();
    } else if (!listener) {
      this.listeners.delete(name);
    } else {
      const listeners = this.listeners.get(name);
      for (const added of [...(listeners || [])]) {
        if (added === listener || added.original === listener) {
          listeners!.delete(added);
        }
      }
    }
    return this;
  }

  emit(name: string, ...args: unknown[]) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify([name, ...args]));
    }
    return this;
  }

  close() {
    this.isClosed = true;
    this.connected = false;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000);
    this.ws = null;
    return this;
  }
}
