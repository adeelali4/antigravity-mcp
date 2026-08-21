import type { Agent } from "../types";
import { getLocation, type Point } from "../office/layout";
import { buildPath } from "../office/pathfinding";
import { resolveSeatPoint } from "../office/occupancy";

export type Facing = "up" | "down" | "left" | "right";
export type AnimPhase = "entering" | "active" | "leaving" | "gone";

export interface AnimAgent {
  id: string;
  x: number;
  y: number;
  facing: Facing;
  walking: boolean;
  opacity: number;
  phase: AnimPhase;
  path: Point[];
  routedLocation: string | null;
  routedSeat: Point | null;
}

const WALK_SPEED = 130; // px/sec
const ARRIVE_EPS = 1.5;
const ENTER_MS = 220;
const LEAVE_MS = 420;

/**
 * The simulation/animation layer. Owns per-agent pixel position and walk
 * state, completely separate from the logical Agent records in the store --
 * it only *reacts* to location/connection changes, it never writes back to
 * the store. Runs on a plain rAF tick, independent of React's render cycle.
 */
export class MovementEngine {
  private anim = new Map<string, AnimAgent>();
  private animList: AnimAgent[] = [];
  private enterTimers = new Map<string, number>();
  private leaveTimers = new Map<string, number>();

  /** Reconcile animation state against the latest agent records. Cheap; call on every store update. */
  sync(agents: Record<string, Agent>): void {
    const seen = new Set<string>();

    for (const agent of Object.values(agents)) {
      seen.add(agent.id);
      const existing = this.anim.get(agent.id);

      if (agent.connectionStatus === "disconnected") {
        if (existing && existing.phase !== "leaving" && existing.phase !== "gone") {
          existing.phase = "leaving";
          existing.path = [];
          existing.walking = false;
          this.leaveTimers.set(agent.id, 0);
        }
        continue;
      }

      const seat = resolveSeatPoint(agent.location, agent.id, agents);

      if (!existing) {
        // First appearance: pop in already seated, no long walk from nowhere.
        const newAgent: AnimAgent = {
          id: agent.id,
          x: seat.x,
          y: seat.y,
          facing: getLocation(agent.location).facing,
          walking: false,
          opacity: 0,
          phase: "entering",
          path: [],
          routedLocation: agent.location,
          routedSeat: seat,
        };
        this.anim.set(agent.id, newAgent);
        this.animList.push(newAgent);
        this.enterTimers.set(agent.id, 0);
        continue;
      }

      if (existing.phase === "leaving" || existing.phase === "gone") {
        // Reconnected before the fade finished (or after): revive in place.
        existing.phase = "entering";
        existing.opacity = 0;
        this.enterTimers.set(agent.id, 0);
        this.leaveTimers.delete(agent.id);
      }

      const seatChanged =
        existing.routedLocation !== agent.location ||
        !existing.routedSeat ||
        existing.routedSeat.x !== seat.x ||
        existing.routedSeat.y !== seat.y;

      if (seatChanged) {
        // Recompute from wherever the sprite currently is -- never from its
        // old target -- so a mid-walk retarget redirects instead of teleporting.
        existing.path = buildPath({ x: existing.x, y: existing.y }, agent.location, seat);
        existing.routedLocation = agent.location;
        existing.routedSeat = seat;
      }
    }

    // Agents that vanished from the store entirely (shouldn't normally happen,
    // disconnect keeps the record) get the same graceful fade as a disconnect.
    for (const id of this.anim.keys()) {
      if (!seen.has(id)) {
        const existing = this.anim.get(id)!;
        if (existing.phase !== "leaving" && existing.phase !== "gone") {
          existing.phase = "leaving";
          existing.path = [];
          this.leaveTimers.set(id, 0);
        }
      }
    }
  }

  tick(dtMs: number): void {
    const dt = Math.min(dtMs, 64) / 1000; // clamp so a tab-switch stutter can't cause a huge jump

    for (const [id, a] of this.anim) {
      if (a.phase === "entering") {
        const t = (this.enterTimers.get(id) ?? 0) + dtMs;
        this.enterTimers.set(id, t);
        a.opacity = Math.min(1, t / ENTER_MS);
        if (t >= ENTER_MS) a.phase = "active";
      } else if (a.phase === "leaving") {
        const t = (this.leaveTimers.get(id) ?? 0) + dtMs;
        this.leaveTimers.set(id, t);
        a.opacity = Math.max(0, 1 - t / LEAVE_MS);
        if (t >= LEAVE_MS) a.phase = "gone";
        continue;
      } else {
        a.opacity = 1;
      }

      if (a.path.length > 0) {
        const target = a.path[0];
        const dx = target.x - a.x;
        const dy = target.y - a.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= ARRIVE_EPS) {
          a.x = target.x;
          a.y = target.y;
          a.path.shift();
          if (a.path.length === 0) a.walking = false;
        } else {
          const step = WALK_SPEED * dt;
          const ratio = Math.min(1, step / dist);
          a.x += dx * ratio;
          a.y += dy * ratio;
          a.walking = true;
          a.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
        }
      }
    }

    let needsCleanup = false;
    for (const [id, a] of this.anim) {
      if (a.phase === "gone") {
        this.anim.delete(id);
        needsCleanup = true;
      }
    }
    if (needsCleanup) {
      this.animList = this.animList.filter(a => a.phase !== "gone");
    }
  }

  getSnapshot(): readonly AnimAgent[] {
    return this.animList;
  }

  get(id: string): AnimAgent | undefined {
    return this.anim.get(id);
  }
}
