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
export type WsStatus = "open" | "closed" | "error";

export class WebSocketAgentEventSource extends BaseEventSource {
  private ws: WebSocket | null = null;
  constructor(private url: string, private onStatus?: (status: WsStatus) => void) {
    super();
  }
  start(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.onStatus?.("open");
    this.ws.onclose = () => this.onStatus?.("closed");
    this.ws.onerror = () => this.onStatus?.("error");
    this.ws.onmessage = (msg) => {
      try {
        this.emit(JSON.parse(msg.data) as AgentEvent);
      } catch {
        /* malformed frame from the server: drop it, don't crash the UI */
      }
    };
  }
  stop(): void {
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
      this.ws.close();
    }
    this.ws = null;
  }
}
