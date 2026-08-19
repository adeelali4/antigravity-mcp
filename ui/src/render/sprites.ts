import { PALETTE, hueColor, screenColorFor, statusColor } from "./palette";
import { label, labelPill, px, pxCircle, roundRect } from "./draw";
import type { Location } from "../office/layout";
import type { Facing } from "../simulation/MovementEngine";
import { WORLD_H, WORLD_W, CORRIDOR_Y } from "../office/layout";

// ---------------------------------------------------------------- room shell

export function drawRoom(ctx: CanvasRenderingContext2D) {
  const tile = 24;
  for (let y = 0; y < WORLD_H; y += tile) {
    for (let x = 0; x < WORLD_W; x += tile) {
      const even = ((x / tile) | 0) % 2 === ((y / tile) | 0) % 2;
      px(ctx, x, y, tile, tile, even ? PALETTE.floorA : PALETTE.floorB);
    }
  }
  // Corridor stripe -- the spine every walk path follows.
  px(ctx, 0, CORRIDOR_Y - 20, WORLD_W, 40, PALETTE.corridor);
  // Top wall band.
  px(ctx, 0, 0, WORLD_W, 28, PALETTE.wall);
  px(ctx, 0, 26, WORLD_W, 4, PALETTE.wallTrim);
}

// -------------------------------------------------------------------- desks

export function drawDesk(ctx: CanvasRenderingContext2D, loc: Location, agentName: string | null, connected: boolean) {
  const { x, y } = loc.seat;
  const facingUp = loc.facing === "up";
  const deskY = facingUp ? y + 14 : y - 14;
  const monitorY = deskY + (facingUp ? 10 : -10);
  const active = agentName !== null && connected;
  const known = agentName !== null;

  const woodColor = active ? PALETTE.deskWood : PALETTE.deskOffline;
  const woodDark = active ? PALETTE.deskWoodDark : "#3c3c44";
  const chairColor = active ? PALETTE.chair : PALETTE.chairOffline;

  // Chair (drawn first, behind the desk from the walking side).
  px(ctx, x - 9, y + (facingUp ? 16 : -20), 18, 14, chairColor);

  // Desk surface.
  px(ctx, x - 34, deskY - 8, 68, 16, woodColor);
  px(ctx, x - 34, deskY + 8, 68, 4, woodDark);

  // Monitor.
  const monFrame = active ? PALETTE.monitorFrame : PALETTE.monitorOffline;
  px(ctx, x - 14, monitorY - 12, 28, 20, monFrame);
  px(ctx, x - 4, monitorY + 8, 8, 5, monFrame);

  // Name tag: always shown if an agent has ever owned this desk, even offline.
  if (known) {
    // Clears the seated character's head either way -- the "up"-facing row
    // sits lower (chair/name below), the "down"-facing row's head extends
    // further up than its desk alone would suggest, so it needs more room.
    const tagY = facingUp ? y + 40 : y - 54;
    labelPill(
      ctx,
      agentName!,
      x,
      tagY,
      active ? PALETTE.textPrimary : PALETTE.textOffline,
      active ? "#1c2038" : "#20222c",
      11
    );
    if (!connected) {
      label(ctx, "offline", x, tagY + 15, PALETTE.textOffline, 9, "center", "normal");
    }
  }
}

/** Screen contents reflect the current occupant's status; called once per occupant with a status, else left dark. */
export function drawDeskScreen(ctx: CanvasRenderingContext2D, loc: Location, status: string, timeMs: number) {
  const { x } = loc.seat;
  const facingUp = loc.facing === "up";
  const monitorY = (facingUp ? loc.seat.y + 14 : loc.seat.y - 14) + (facingUp ? 10 : -10);
  const sx = x - 12,
    sy = monitorY - 10,
    sw = 24,
    sh = 16;
  px(ctx, sx, sy, sw, sh, screenColorFor(status));

  const t = timeMs / 260;
  if (status === "developing" || status === "working") {
    for (let i = 0; i < 3; i++) {
      const w = 6 + ((Math.sin(t + i) + 1) * 7) | 0;
      px(ctx, sx + 2, sy + 3 + i * 4, w, 2, PALETTE.accentGreen);
    }
  } else if (status === "testing") {
    const w = (Math.sin(t) + 1) * 0.5 * (sw - 4);
    px(ctx, sx + 2, sy + sh / 2 - 2, sw - 4, 4, "#5a5320");
    px(ctx, sx + 2, sy + sh / 2 - 2, w, 4, PALETTE.accentAmber);
  } else if (status === "reviewing") {
    pxCircle(ctx, sx + sw / 2, sy + sh / 2, 5, "transparent");
    ctx.strokeStyle = PALETTE.accentPurple;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx + sw / 2 - 2, sy + sh / 2 - 1, 4, 0, Math.PI * 2);
    ctx.stroke();
    px(ctx, sx + sw / 2 + 1, sy + sh / 2 + 2, 4, 2, PALETTE.accentPurple);
  } else if (status === "debugging" || status === "blocked") {
    ctx.strokeStyle = PALETTE.accentRed;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= sw - 4; i += 3) {
      ctx.lineTo(sx + 2 + i, sy + sh / 2 + Math.sin((i + t * 20) / 3) * 4);
    }
    ctx.stroke();
  } else {
    px(ctx, sx + 4, sy + sh / 2 - 1, sw - 8, 2, PALETTE.textDim);
  }
}

// -------------------------------------------------------------- shared rooms

export function drawMeetingRoom(ctx: CanvasRenderingContext2D, loc: Location) {
  const { x, y } = loc.seat;
  pxCircle(ctx, x, y - 10, 46, PALETTE.meetingTable);
  ctx.strokeStyle = "#3f3350";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y - 10, 46, 0, Math.PI * 2);
  ctx.stroke();
  label(ctx, "MEETING ROOM", x, y - 70, PALETTE.textDim, 11);
}

export function drawLounge(ctx: CanvasRenderingContext2D, loc: Location) {
  const { x, y } = loc.seat;
  roundRect(ctx, x - 46, y - 30, 92, 40, 8);
  ctx.fillStyle = PALETTE.loungeAccent;
  ctx.fill();
  px(ctx, x + 40, y - 46, 18, 24, "#2b2b33");
  px(ctx, x + 44, y - 40, 10, 6, PALETTE.accentAmber);
  label(ctx, "COFFEE LOUNGE", x, y - 56, PALETTE.textDim, 11);
}

// -------------------------------------------------------------------- agent

export interface CharacterStyle {
  hue: number;
  facing: Facing;
  walking: boolean;
  status: string;
  opacity: number;
  highlighted: boolean;
  inInteraction: boolean;
}

export function drawCharacter(ctx: CanvasRenderingContext2D, x: number, y: number, timeMs: number, s: CharacterStyle) {
  ctx.save();
  ctx.globalAlpha = s.opacity;

  const shirt = hueColor(s.hue);
  const skin = "#e8b98a";
  const seated = !s.walking;
  const bob = s.walking
    ? Math.sin(timeMs / 110) * 2.4
    : Math.sin(timeMs / 480) * 1.2 * (s.status === "blocked" ? 0.2 : 1);

  const baseY = y - (seated ? 6 : 0) + bob;
  const legOffset = s.walking ? Math.sin(timeMs / 110) * 4 : 0;

  // Shadow.
  ctx.globalAlpha = s.opacity * 0.35;
  pxCircle(ctx, x, y + 3, 11, "#000000");
  ctx.globalAlpha = s.opacity;

  // Legs.
  const legH = seated ? 8 : 12;
  px(ctx, x - 7, baseY - legH + 2, 6, legH, "#2f3350");
  px(ctx, x + 1, baseY - legH + 2 - legOffset * 0, 6, legH, "#2f3350");
  if (s.walking) {
    px(ctx, x - 7 + legOffset, baseY - legH + 2, 6, legH, "#2f3350");
    px(ctx, x + 1 - legOffset, baseY - legH + 2, 6, legH, "#2f3350");
  }

  // Torso.
  const torsoH = seated ? 14 : 16;
  px(ctx, x - 9, baseY - legH - torsoH + 2, 18, torsoH, shirt);

  // Arms (a little motion while developing/testing, to read as "active").
  const armJitter =
    s.status === "developing" || s.status === "working" || s.status === "testing" ? Math.sin(timeMs / 90) * 2 : 0;
  px(ctx, x - 12, baseY - legH - torsoH + 6 + armJitter, 4, 8, shirt);
  px(ctx, x + 8, baseY - legH - torsoH + 6 - armJitter, 4, 8, shirt);

  // Head.
  const headY = baseY - legH - torsoH - 8;
  pxCircle(ctx, x, headY, 8, skin);
  if (s.facing === "down") {
    px(ctx, x - 3, headY - 1, 2, 2, "#2a2a2a");
    px(ctx, x + 1, headY - 1, 2, 2, "#2a2a2a");
  } else if (s.facing === "left") {
    px(ctx, x - 4, headY - 1, 2, 2, "#2a2a2a");
  } else if (s.facing === "right") {
    px(ctx, x + 2, headY - 1, 2, 2, "#2a2a2a");
  } // facing "up": back of head, no face

  drawStatusBadge(ctx, x, headY - 16, s.status, timeMs);

  if (s.inInteraction) {
    ctx.strokeStyle = PALETTE.accentBlue;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, headY - 16, 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (s.highlighted) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y - 8, 24, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawStatusBadge(ctx: CanvasRenderingContext2D, x: number, y: number, status: string, timeMs: number) {
  const color = statusColor(status);
  switch (status) {
    case "idle":
      return; // relaxed: no badge needed, the seated pose already reads as idle
    case "developing":
    case "working":
      label(ctx, "</>", x, y, color, 10);
      return;
    case "testing":
      label(ctx, "✓", x, y, color, 12);
      return;
    case "reviewing":
      label(ctx, "⌕", x, y, color, 11);
      return;
    case "debugging":
      label(ctx, "⚠", x, y, color, 11);
      return;
    case "blocked": {
      const pulse = 0.6 + Math.sin(timeMs / 200) * 0.4;
      ctx.globalAlpha *= pulse;
      label(ctx, "!", x, y, color, 13);
      ctx.globalAlpha /= pulse;
      return;
    }
    case "offline":
      return;
    default:
      // Unknown/future status: still visible, still calm -- never a blank or broken badge.
      label(ctx, "?", x, y, color, 11);
      return;
  }
}

export function drawInteractionLink(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number) {
  ctx.save();
  ctx.strokeStyle = PALETTE.accentBlue;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(ax, ay - 30);
  ctx.lineTo(bx, by - 30);
  ctx.stroke();
  ctx.restore();
}
