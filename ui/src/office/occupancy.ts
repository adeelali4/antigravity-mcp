import type { Agent } from "../types";
import { getLocation, type Point } from "./layout";

/**
 * Which exact point within a location an agent should stand at, so two agents
 * at the same desk/meeting/lounge don't render on top of each other. Stable
 * per occupant set (sorted by id) so it only reshuffles when who's-there
 * actually changes, not every tick.
 */
export function resolveSeatPoint(locationId: string, agentId: string, agents: Record<string, Agent>): Point {
  const loc = getLocation(locationId);
  const seats = [loc.seat, ...(loc.extraSeats ?? [])];

  const occupantIds = Object.values(agents)
    .filter((a) => a.connectionStatus === "connected" && a.location === locationId)
    .map((a) => a.id)
    .sort((a, b) => a.localeCompare(b));

  const myIndex = occupantIds.indexOf(agentId);
  if (myIndex === -1) return loc.seat;
  return seats[myIndex % seats.length];
}
