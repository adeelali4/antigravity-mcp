import type { AgentEvent, AgentEventSource } from "../types";

/** Minimal pub-sub base every concrete event source shares. */
export abstract class BaseEventSource implements AgentEventSource {
  private listeners = new Set<(event: AgentEvent) => void>();

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  abstract start(): void;
  abstract stop(): void;
}

/**
 * Stub showing how a real backend feed slots in later: same interface, same
 * consumer (the store just calls handleEvent), zero changes anywhere else.
 * Not wired up anywhere -- included so the "replaceable without a rewrite"
 * requirement is demonstrably true, not just asserted.
 */
export type WsStatus = "open" | "closed" | "error" | "reconnecting";

export class WebSocketAgentEventSource extends BaseEventSource {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private retryDelay = 1000;

  constructor(private url: string, private onStatus?: (status: WsStatus) => void) {
    super();
  }

  start(): void {
    this.shouldReconnect = true;
    this.connect();
  }

  private connect(): void {
    if (!this.shouldReconnect) return;
    this.cleanupSocket();

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.onStatus?.("error");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.retryDelay = 1000;
      this.onStatus?.("open");
    };

    this.ws.onclose = () => {
      this.onStatus?.("closed");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.onStatus?.("error");
    };

    this.ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data && typeof data === "object" && data.type) {
          this.emit(data as AgentEvent);
        }
      } catch {
        /* malformed frame from the server: drop it safely */
      }
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.onStatus?.("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 1.5, 8000);
      this.connect();
    }, this.retryDelay);
  }

  private cleanupSocket(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* ignore close errors on dead sockets */
      }
      this.ws = null;
    }
  }

  stop(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();
  }
}
