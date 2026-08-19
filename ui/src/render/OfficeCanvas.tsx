import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "../store/agentStore";
import { MovementEngine } from "../simulation/MovementEngine";
import { WORLD_W, WORLD_H, getLocation, listDeskLocations } from "../office/layout";
import { drawRoom, drawDesk, drawDeskScreen, drawMeetingRoom, drawLounge, drawCharacter, drawInteractionLink } from "./sprites";
import type { Agent } from "../types";

interface HoverInfo {
  agent: Agent;
  screenX: number;
  screenY: number;
}

interface Props {
  engine: MovementEngine;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function OfficeCanvas({ engine, selectedId, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // Re-sync the movement engine whenever agent records change -- imperative,
  // not tied to React's render, so this can't fall behind or double-fire.
  useEffect(() => {
    const sync = () => engine.sync(useAgentStore.getState().agents);
    sync();
    return useAgentStore.subscribe(sync);
  }, [engine]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      engine.tick(dt);
      draw(ctx, now);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  function draw(ctx: CanvasRenderingContext2D, timeMs: number) {
    const { agents, deskAssignments } = useAgentStore.getState();

    ctx.clearRect(0, 0, WORLD_W, WORLD_H);
    drawRoom(ctx);

    const overflowIds = Array.from(new Set(Object.values(deskAssignments))).filter((id) => id.startsWith("overflow-"));
    const deskLocations = [...listDeskLocations(), ...overflowIds.map(getLocation)];

    // Owner lookup so a desk keeps its name/dim state even while its agent is offline.
    const ownerByDesk = new Map<string, Agent>();
    for (const agent of Object.values(agents)) {
      const desk = deskAssignments[agent.id];
      if (desk) ownerByDesk.set(desk, agent);
    }

    for (const loc of deskLocations) {
      const owner = ownerByDesk.get(loc.id) ?? null;
      drawDesk(ctx, loc, owner?.name ?? null, owner?.connectionStatus === "connected");
      if (owner && owner.connectionStatus === "connected" && owner.location === loc.id) {
        drawDeskScreen(ctx, loc, owner.status, timeMs);
      }
    }

    drawMeetingRoom(ctx, getLocation("meeting"));
    drawLounge(ctx, getLocation("lounge"));

    const snapshot = engine.getSnapshot();

    // Interaction links, drawn under the characters.
    const drawnPairs = new Set<string>();
    for (const anim of snapshot) {
      const agent = agents[anim.id];
      if (!agent?.interaction) continue;
      const other = engine.get(agent.interaction.withAgentId);
      if (!other) continue;
      const key = [anim.id, agent.interaction.withAgentId].sort().join("|");
      if (drawnPairs.has(key)) continue;
      drawnPairs.add(key);
      drawInteractionLink(ctx, anim.x, anim.y, other.x, other.y);
    }

    // Draw back-to-front by y so nearer sprites overlap farther ones sensibly.
    const ordered = [...snapshot].sort((a, b) => a.y - b.y);
    for (const anim of ordered) {
      const agent = agents[anim.id];
      if (!agent) continue;
      drawCharacter(ctx, anim.x, anim.y, timeMs, {
        hue: agent.hue,
        facing: anim.facing,
        walking: anim.walking,
        status: agent.status,
        opacity: anim.opacity,
        highlighted: selectedId === agent.id,
        inInteraction: agent.interaction !== null,
      });
    }
  }

  function pickAgentAt(clientX: number, clientY: number): Agent | null {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scale = WORLD_W / rect.width;
    const x = (clientX - rect.left) * scale;
    const y = (clientY - rect.top) * scale;

    const { agents } = useAgentStore.getState();
    let best: { agent: Agent; dist: number } | null = null;
    for (const anim of engine.getSnapshot()) {
      const agent = agents[anim.id];
      if (!agent) continue;
      const dist = Math.hypot(anim.x - x, anim.y - y - 6);
      if (dist < 26 && (!best || dist < best.dist)) best = { agent, dist };
    }
    return best?.agent ?? null;
  }

  return (
    <div className="office-canvas-wrap" ref={containerRef}>
      <canvas
        ref={canvasRef}
        width={WORLD_W}
        height={WORLD_H}
        className="office-canvas"
        onClick={(e) => onSelect(pickAgentAt(e.clientX, e.clientY)?.id ?? null)}
        onMouseMove={(e) => {
          const agent = pickAgentAt(e.clientX, e.clientY);
          setHover(agent ? { agent, screenX: e.clientX, screenY: e.clientY } : null);
        }}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
        <div
          className="office-tooltip"
          style={{ left: hover.screenX + 14, top: hover.screenY - 10 }}
        >
          <strong>{hover.agent.name}</strong>
          <span className="office-tooltip-status">{hover.agent.status}</span>
          {hover.agent.currentTask && <div className="office-tooltip-task">{hover.agent.currentTask}</div>}
        </div>
      )}
    </div>
  );
}
