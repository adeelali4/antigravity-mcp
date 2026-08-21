import type { AgentEvent } from "../types";
import { BaseEventSource } from "./EventSource";
import { PREDEFINED_DESK_COUNT, nextOverflowId } from "../office/layout";

const ROSTER: { id: string; name: string }[] = [
  { id: "claude", name: "Claude" },
  { id: "antigravity", name: "Antigravity" },
  { id: "copilot", name: "Copilot" },
  { id: "gemini", name: "Gemini" },
  { id: "cursor", name: "Cursor" },
  { id: "windsurf", name: "Windsurf" },
  { id: "opencode", name: "OpenCode" },
  { id: "aider", name: "Aider" },
  { id: "amp", name: "Amp" }, // 9th agent: demonstrates overflow past 8 desks
];

/** Representative model per demo agent, just so the hover tooltip has something real-looking to show. */
const MODEL_BY_ID: Record<string, string> = {
  claude: "claude-sonnet-5",
  antigravity: "gemini-3.1-pro-high",
  copilot: "gpt-5.1",
  gemini: "gemini-3.1-pro",
  cursor: "claude-sonnet-5",
  windsurf: "gpt-5",
  opencode: "claude-sonnet-5",
  aider: "gpt-5",
  amp: "claude-sonnet-5",
};

const DEV_TASKS = [
  "Implement authentication middleware",
  "Build the office simulation frontend",
  "Wire up the WebSocket event feed",
  "Refactor the movement engine",
  "Add retry logic to the API client",
  "Migrate the board schema",
  "Implement path locking for delegated tasks",
];
const TEST_TASKS = [
  "Write coverage for MovementEngine",
  "Run the delegation smoke suite",
  "Add tests for path conflicts",
  "Verify reconnect handling",
  "Load-test the event pipeline",
];
const REVIEW_TASKS = [
  "Review the pathfinding PR",
  "Review teammate's delegation changes",
  "Check the desk-assignment logic",
  "Review README updates",
];
const DEBUG_TASKS = [
  "Chase down a race in the store",
  "Debug a stuck animation state",
  "Investigate a flaky reconnect",
  "Track down a memory leak in the render loop",
];
const BLOCKED_TASKS = [
  "Waiting on API contract from teammate",
  "Blocked on missing credentials",
  "Waiting for code review",
  "Blocked on a flaky CI run",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function jitter(baseMs: number, spreadMs: number): number {
  return baseMs + Math.random() * spreadMs;
}

type Weighted<T> = [T, number];
function weightedPick<T>(options: Weighted<T>[]): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [value, w] of options) {
    if ((r -= w) <= 0) return value;
  }
  return options[0][0];
}

/**
 * Scripted + randomized demo data source. Implements the same
 * AgentEventSource interface a WebSocket feed would, so the rest of the app
 * never knows this isn't real.
 */
export class MockAgentEventSource extends BaseEventSource {
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private running = false;
  private connected = new Set<string>();
  private homeDesk = new Map<string, string>();

  start(): void {
    this.running = true;
    this.assignDesks();
    this.scheduleOpening();
  }

  stop(): void {
    this.running = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private after(ms: number, fn: () => void) {
    if (!this.running) return;
    const t = setTimeout(() => {
      if (this.running) fn();
    }, ms);
    this.timers.push(t);
  }

  private assignDesks() {
    const used = new Set<string>();
    for (const { id } of ROSTER) {
      let desk: string | null = null;
      for (let i = 0; i < PREDEFINED_DESK_COUNT; i++) {
        if (!used.has(`desk-${i}`)) {
          desk = `desk-${i}`;
          break;
        }
      }
      if (!desk) {
        let n = 0;
        while (used.has(nextOverflowId(n))) n++;
        desk = nextOverflowId(n);
      }
      used.add(desk);
      this.homeDesk.set(id, desk);
    }
  }

  private connect(id: string, name: string) {
    this.connected.add(id);
    this.emit({ type: "AGENT_CONNECTED", agentId: id, name, location: this.homeDesk.get(id) });
    this.after(jitter(400, 400), () => this.startAgentLoop(id));
  }

  private disconnect(id: string) {
    this.connected.delete(id);
    this.emit({ type: "AGENT_DISCONNECTED", agentId: id });
  }

  private scheduleOpening() {
    // Stagger initial connects so the office fills in visibly rather than all at once.
    ROSTER.slice(0, 6).forEach(({ id, name }, i) => {
      this.after(jitter(300, 200) + i * 700, () => this.connect(id, name));
    });
    // Two agents join a bit later, to demonstrate a mid-session connect.
    this.after(6000, () => this.connect(ROSTER[6].id, ROSTER[6].name));
    this.after(9000, () => this.connect(ROSTER[7].id, ROSTER[7].name));

    // A disconnect/reconnect cycle, to demonstrate that flow explicitly.
    this.after(14000, () => this.disconnect("copilot"));
    this.after(21000, () => this.connect("copilot", "Copilot"));

    // The 9th agent connects later still, landing in the overflow area.
    this.after(17000, () => this.connect(ROSTER[8].id, ROSTER[8].name));
  }

  /** Each connected agent runs its own indefinite behavior loop until it disconnects. */
  private startAgentLoop(id: string) {
    const step = () => {
      if (!this.running || !this.connected.has(id)) return;

      const action = weightedPick<
        "develop" | "test" | "review" | "debug" | "idle" | "blocked" | "lounge" | "meeting" | "visit"
      >([
        ["develop", 24],
        ["test", 14],
        ["review", 10],
        ["debug", 10],
        ["idle", 14],
        ["blocked", 6],
        ["lounge", 8],
        ["meeting", 8],
        ["visit", 10],
      ]);

      const home = this.homeDesk.get(id)!;

      switch (action) {
        case "develop":
          this.goHome(id, home);
          this.setStatus(id, "developing", pick(DEV_TASKS));
          this.after(jitter(4000, 5000), step);
          return;
        case "test":
          this.goHome(id, home);
          this.setStatus(id, "testing", pick(TEST_TASKS));
          this.after(jitter(3000, 3000), step);
          return;
        case "review":
          this.goHome(id, home);
          this.setStatus(id, "reviewing", pick(REVIEW_TASKS));
          this.after(jitter(3000, 3000), step);
          return;
        case "debug":
          this.goHome(id, home);
          this.setStatus(id, "debugging", pick(DEBUG_TASKS));
          this.after(jitter(3500, 4000), step);
          return;
        case "blocked":
          this.goHome(id, home);
          this.setStatus(id, "blocked", pick(BLOCKED_TASKS));
          this.after(jitter(3000, 3000), step);
          return;
        case "idle":
          this.goHome(id, home);
          this.setStatus(id, "idle", null);
          this.after(jitter(3000, 4000), step);
          return;
        case "lounge":
        case "meeting": {
          const loc = action === "lounge" ? "lounge" : "meeting";
          this.emit({ type: "AGENT_LOCATION_CHANGED", agentId: id, location: loc });
          this.after(jitter(2500, 3000), () => {
            if (!this.connected.has(id)) return;
            this.emit({ type: "AGENT_LOCATION_CHANGED", agentId: id, location: home });
            this.after(jitter(1000, 500), step);
          });
          return;
        }
        case "visit": {
          const other = pick(Array.from(this.connected).filter((x) => x !== id));
          if (!other) {
            this.after(jitter(2000, 2000), step);
            return;
          }
          const otherHome = this.homeDesk.get(other)!;
          this.emit({ type: "AGENT_LOCATION_CHANGED", agentId: id, location: otherHome });
          this.after(600, () => {
            if (!this.connected.has(id) || !this.connected.has(other)) return;
            this.emit({ type: "AGENT_INTERACTION_STARTED", agentId: id, withAgentId: other, kind: "pairing" });
            this.emit({ type: "AGENT_INTERACTION_STARTED", agentId: other, withAgentId: id, kind: "pairing" });
            this.after(jitter(2500, 2500), () => {
              this.emit({ type: "AGENT_INTERACTION_ENDED", agentId: id });
              if (this.connected.has(other)) this.emit({ type: "AGENT_INTERACTION_ENDED", agentId: other });
              this.emit({ type: "AGENT_LOCATION_CHANGED", agentId: id, location: home });
              this.after(jitter(1000, 500), step);
            });
          });
          return;
        }
      }
    };

    step();
  }

  private goHome(id: string, home: string) {
    this.emit({ type: "AGENT_LOCATION_CHANGED", agentId: id, location: home });
  }

  private setStatus(id: string, status: string, task: string | null) {
    this.emit({ type: "AGENT_STATUS_CHANGED", agentId: id, status });
    this.emit({ type: "AGENT_TASK_CHANGED", agentId: id, task, model: task ? MODEL_BY_ID[id] ?? null : null });
  }
}
