import { useEffect, useMemo, useState } from "react";
import { useAgentStore } from "./store/agentStore";
import { MovementEngine } from "./simulation/MovementEngine";
import { MockAgentEventSource } from "./events/mockScenarios";
import { WebSocketAgentEventSource } from "./events/EventSource";
import { OfficeCanvas } from "./render/OfficeCanvas";
import { Sidebar } from "./ui/Sidebar";
import { AgentDetailPanel } from "./ui/AgentDetailPanel";
import { DebugControls } from "./ui/DebugControls";

// The production build is served by the same process that runs the
// WebSocket endpoint (one port, see src/uiServer.js), so same-origin is the
// correct default -- it keeps working if the port is overridden, and if the
// page is loaded remotely over the LAN. Dev mode (`vite dev` on its own port,
// separate from the real server) falls back to the documented default port.
const DEFAULT_UI_PORT = 49321;
const BRIDGE_URL =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ??
  (import.meta.env.DEV
    ? `ws://${window.location.hostname}:${DEFAULT_UI_PORT}`
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`);
const LIVE_CONNECT_TIMEOUT_MS = 2500;

type ConnectionMode = "connecting" | "live" | "demo";

export default function App() {
  const agents = useAgentStore((s) => s.agents);
  const handleEvent = useAgentStore((s) => s.handleEvent);
  const reset = useAgentStore((s) => s.reset);
  const engine = useMemo(() => new MovementEngine(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("connecting");

  // Try the real bridge first; if it doesn't open within the timeout (bridge
  // not running, or nothing has ever talked to antigravity-mcp-server yet),
  // fall back to the demo source so the simulation is never just blank.
  useEffect(() => {
    let cancelled = false;
    let decided = false;
    let fallbackTimer: ReturnType<typeof setTimeout>;
    let demo: MockAgentEventSource | null = null;

    const live = new WebSocketAgentEventSource(BRIDGE_URL, (status) => {
      if (decided || cancelled) return;
      if (status === "open") {
        decided = true;
        clearTimeout(fallbackTimer);
        reset();
        setMode("live");
      } else {
        goDemo();
      }
    });

    function goDemo() {
      if (decided || cancelled) return;
      decided = true;
      clearTimeout(fallbackTimer);
      live.stop();
      reset();
      demo = new MockAgentEventSource();
      demo.subscribe(handleEvent);
      demo.start();
      setMode("demo");
    }

    live.subscribe(handleEvent);
    live.start();
    fallbackTimer = setTimeout(goDemo, LIVE_CONNECT_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      live.stop();
      demo?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agentList = Object.values(agents);
  const selected = selectedId ? agents[selectedId] ?? null : null;
  const otherAgentName = selected?.interaction ? agents[selected.interaction.withAgentId]?.name ?? null : null;

  // If the selected agent disconnects/vanishes, don't leave the panel pointing at nothing odd.
  useEffect(() => {
    if (selectedId && !agents[selectedId]) setSelectedId(null);
  }, [agents, selectedId]);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Agent Office</h1>
          <p>Who's online, where they are, what they're doing.</p>
        </div>
        <ModeBadge mode={mode} />
      </header>

      <div className="app-body">
        <main className="app-office">
          <OfficeCanvas engine={engine} selectedId={selectedId} onSelect={setSelectedId} />
          {selected && (
            <AgentDetailPanel agent={selected} otherAgentName={otherAgentName} onClose={() => setSelectedId(null)} />
          )}
        </main>
        <Sidebar agents={agentList} selectedId={selectedId} onSelect={setSelectedId} />
      </div>

      <DebugControls agents={agentList} dispatch={handleEvent} />
    </div>
  );
}

function ModeBadge({ mode }: { mode: ConnectionMode }) {
  const label = mode === "live" ? "Live" : mode === "demo" ? "Demo" : "Connecting…";
  const detail =
    mode === "live"
      ? "watching antigravity-mcp-server"
      : mode === "demo"
      ? "simulated data — no bridge detected"
      : "";
  return (
    <div className={`mode-badge ${mode}`}>
      <span className="mode-dot" />
      {label}
      {detail && <span className="mode-detail">{detail}</span>}
    </div>
  );
}
