export const PALETTE = {
  floorA: "#2a2f45",
  floorB: "#262b40",
  wall: "#1b1f30",
  wallTrim: "#3a4166",
  corridor: "#333a58",
  deskWood: "#8a5a3b",
  deskWoodDark: "#6e4630",
  deskOffline: "#4a4a52",
  chair: "#4a5170",
  chairOffline: "#3a3d48",
  monitorFrame: "#1c1e2a",
  monitorOffline: "#26262e",
  screenIdle: "#1a2a3a",
  screenDev: "#0d3b2e",
  screenTest: "#3a3410",
  screenReview: "#2a1a3a",
  screenDebug: "#3a1414",
  screenBlocked: "#3a1414",
  screenSearch: "#1a2540",
  screenRead: "#0e3340",
  screenBash: "#3a2a0d",
  textPrimary: "#e8ecff",
  textDim: "#8b91b8",
  textOffline: "#5a5f78",
  meetingTable: "#5a4a6e",
  loungeAccent: "#7a4a3a",
  accentGreen: "#4ade80",
  accentAmber: "#facc15",
  accentPurple: "#c084fc",
  accentRed: "#f87171",
  accentBlue: "#60a5fa",
  accentCyan: "#22d3ee",
} as const;

export function hueColor(hue: number, s = 62, l = 56): string {
  return `hsl(${hue}, ${s}%, ${l}%)`;
}

export function statusColor(status: string): string {
  switch (status) {
    case "idle":
      return PALETTE.textDim;
    case "developing":
    case "working":
      return PALETTE.accentGreen;
    case "finding":
      return PALETTE.accentPurple;
    case "reading":
      return PALETTE.accentCyan;
    case "bashing":
      return PALETTE.accentAmber;
    case "searching":
      return PALETTE.accentBlue;
    case "delegating":
      return PALETTE.accentPurple;
    case "testing":
      return PALETTE.accentAmber;
    case "reviewing":
      return PALETTE.accentPurple;
    case "debugging":
      return PALETTE.accentRed;
    case "blocked":
      return PALETTE.accentRed;
    case "offline":
      return PALETTE.textOffline;
    default:
      return PALETTE.accentBlue; // unknown status: still gets a clear, calm treatment
  }
}

export function screenColorFor(status: string): string {
  switch (status) {
    case "developing":
    case "working":
      return PALETTE.screenDev;
    case "finding":
    case "searching":
      return PALETTE.screenSearch;
    case "reading":
      return PALETTE.screenRead;
    case "delegating":
      return PALETTE.screenReview;
    case "bashing":
      return PALETTE.screenBash;
    case "testing":
      return PALETTE.screenTest;
    case "reviewing":
      return PALETTE.screenReview;
    case "debugging":
      return PALETTE.screenDebug;
    case "blocked":
      return PALETTE.screenBlocked;
    default:
      return PALETTE.screenIdle;
  }
}
