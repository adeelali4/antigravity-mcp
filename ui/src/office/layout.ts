/**
 * Deterministic office layout: every location (desk, meeting seat, lounge
 * seat, overflow desk) has a fixed pixel position, computed from an index --
 * never hardcoded per named agent. Adding an agent never reshuffles anyone
 * else's desk.
 *
 * Coordinates are in "world" pixels on a fixed logical canvas (see render/
 * constants). A single horizontal corridor is the only thing every location
 * connects to, which keeps pathfinding trivial: walk to the corridor, walk
 * along it, walk into the destination. See office/pathfinding.ts.
 */

export const WORLD_W = 960;
export const WORLD_H = 600;
export const CORRIDOR_Y = 330;

export const PREDEFINED_DESK_COUNT = 8;
const DESK_COLS = 4;
const DESK_ROW_TOP_Y = 120;
const DESK_ROW_BOTTOM_Y = 230;
const DESK_START_X = 140;
const DESK_GAP_X = 180;

const OVERFLOW_ROW_Y = 520;
const OVERFLOW_START_X = 140;
const OVERFLOW_GAP_X = 130;

export type LocationKind = "desk" | "meeting" | "lounge" | "overflow";

export interface Point {
  x: number;
  y: number;
}

export interface Location {
  id: string;
  kind: LocationKind;
  label: string;
  /** Where the sprite sits/stands when "at" this location. */
  seat: Point;
  /** Where the sprite steps to before joining the corridor. */
  dock: Point;
  /** For desk/overflow: which way the character faces while seated. */
  facing: "up" | "down" | "left" | "right";
  /** Multi-occupant locations (meeting, lounge, and desk-visitor slots) offer more than one seat. */
  extraSeats?: Point[];
}

function deskLocation(index: number): Location {
  const col = index % DESK_COLS;
  const row = Math.floor(index / DESK_COLS) % 2;
  const x = DESK_START_X + col * DESK_GAP_X;
  const y = row === 0 ? DESK_ROW_TOP_Y : DESK_ROW_BOTTOM_Y;
  const facing = row === 0 ? "down" : "up";
  // Both rows sit above the corridor -- the step-out point always moves
  // toward it (south), regardless of which way the seated sprite faces.
  const dockY = y + 46;
  return {
    id: `desk-${index}`,
    kind: "desk",
    label: `Desk ${index + 1}`,
    seat: { x, y },
    dock: { x, y: dockY },
    facing,
    // A visitor standing spot beside the desk, for two-agent interactions.
    extraSeats: [{ x: x + 34, y }],
  };
}

function overflowLocation(index: number): Location {
  const x = OVERFLOW_START_X + index * OVERFLOW_GAP_X;
  const y = OVERFLOW_ROW_Y;
  return {
    id: `overflow-${index}`,
    kind: "overflow",
    label: `Extra Desk ${index + 1}`,
    seat: { x, y },
    dock: { x, y: y - 40 },
    facing: "up",
    extraSeats: [{ x: x + 30, y }],
  };
}

const MEETING: Location = {
  id: "meeting",
  kind: "meeting",
  label: "Meeting Room",
  seat: { x: 700, y: 470 },
  dock: { x: 700, y: 400 },
  facing: "down",
  extraSeats: [
    { x: 650, y: 490 },
    { x: 750, y: 490 },
    { x: 650, y: 450 },
    { x: 750, y: 450 },
  ],
};

const LOUNGE: Location = {
  id: "lounge",
  kind: "lounge",
  label: "Coffee Lounge",
  seat: { x: 860, y: 200 },
  dock: { x: 860, y: 260 },
  facing: "down",
  extraSeats: [
    { x: 900, y: 180 },
    { x: 900, y: 230 },
  ],
};

const staticLocations = new Map<string, Location>();
for (let i = 0; i < PREDEFINED_DESK_COUNT; i++) staticLocations.set(`desk-${i}`, deskLocation(i));
staticLocations.set(MEETING.id, MEETING);
staticLocations.set(LOUNGE.id, LOUNGE);

const overflowCache = new Map<string, Location>();

/** Overflow desks are generated on demand -- the layout never "breaks" past 8 agents. */
export function getLocation(id: string): Location {
  const known = staticLocations.get(id);
  if (known) return known;
  if (id.startsWith("overflow-")) {
    let loc = overflowCache.get(id);
    if (!loc) {
      const index = Number(id.slice("overflow-".length)) || overflowCache.size;
      loc = overflowLocation(index);
      overflowCache.set(id, loc);
    }
    return loc;
  }
  // Unknown location id from bad data: fall back to the meeting room rather than crashing.
  return MEETING;
}

export function listDeskLocations(): Location[] {
  return Array.from({ length: PREDEFINED_DESK_COUNT }, (_, i) => deskLocation(i));
}

export function nextOverflowId(usedCount: number): string {
  return `overflow-${usedCount}`;
}
