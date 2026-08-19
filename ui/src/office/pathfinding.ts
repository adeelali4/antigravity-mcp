import { CORRIDOR_Y, getLocation, type Point } from "./layout";

/**
 * Every location touches the same horizontal corridor, so a path is always:
 * current position -> corridor (same x) -> corridor (target's x) -> target's
 * dock -> target's seat. This is deliberately simple rather than a general
 * graph search -- it scales to any number of desks/overflow slots for free,
 * and produces clean retro grid-style walking.
 */
export function buildPath(from: Point, toLocationId: string, seatOffset?: Point): Point[] {
  const dest = getLocation(toLocationId);
  const seat = seatOffset ?? dest.seat;
  const dock = seatOffset ? { x: seatOffset.x, y: dest.dock.y } : dest.dock;

  const waypoints: Point[] = [];
  const onCorridor = Math.abs(from.y - CORRIDOR_Y) < 1;

  if (!onCorridor) waypoints.push({ x: from.x, y: CORRIDOR_Y });
  waypoints.push({ x: dock.x, y: CORRIDOR_Y });
  waypoints.push(dock);
  waypoints.push(seat);

  // Drop any leading waypoint that is (near) identical to the start, so a
  // same-desk redirect doesn't produce a zero-length hop.
  return waypoints.filter((p, i) => {
    const prev = i === 0 ? from : waypoints[i - 1];
    return Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5;
  });
}
