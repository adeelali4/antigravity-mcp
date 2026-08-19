# antigravity-mcp-server UI

The frontend source for `antigravity-mcp-server ui` — a retro pixel-art office visualizing connected agents, driven by the shared board in `../src/store.js`.

This is its own mini npm project (own `package.json`, React/Vite/Zustand as dev-time deps) so the *published* `antigravity-mcp-server` package never needs a frontend build toolchain — it ships the pre-built static output (`../ui-dist`, produced by `npm run build` here) and serves it directly. End users never see this directory.

## Working on it

```bash
npm install
npm run dev            # Vite dev server on :5173, HMR
```

For live data during development, also run the real server from the parent package:

```bash
cd .. && node src/cli.js ui --port 49321
```

The dev server defaults to `ws://localhost:49321` for its live-mode connection attempt (see `DEFAULT_UI_PORT` in `src/App.tsx`) — override with `VITE_BRIDGE_URL` if you're running the real server on a different port.

```bash
npm run build           # -> ../ui-dist, what actually ships
```

From the parent package, `npm run ui:build` does the install + build in one step, and runs automatically before `npm publish` (see its `prepublishOnly` script) — the published tarball always has a fresh build, never a stale one.

## Architecture

```
Agent Data / Events        src/events/         MockAgentEventSource, WebSocketAgentEventSource
        |                                       -- both implement AgentEventSource; either is a
        v                                          drop-in for the other, nothing downstream cares
Agent State Store           src/store/          agentStore.ts (Zustand) -- pure event -> state
        |                                          reducer, sticky desk assignment, no rendering
        v                                          or animation logic
Simulation / Movement       src/simulation/     MovementEngine -- owns per-agent pixel position
        |                   src/office/            and walk state; reacts to location changes,
        v                                          never writes back to the store
Office Rendering            src/render/         OfficeCanvas.tsx -- one canvas, imperative rAF
        |                                          loop, reads engine + store snapshots directly
        v                                          (no React re-render per animation frame)
Agent Animations            src/render/sprites.ts  procedural pixel-art draw functions per status
```

The live data path (`../src/uiServer.js` + `../src/ui/bridgeState.js`) is just another producer of the same `AgentEvent` stream the mock source produces — this frontend has no idea whether it's talking to the demo timer or a real WebSocket.

## Debug controls

The collapsible "Debug controls" panel (bottom-right) dispatches events into the same pipeline the mock/live sources use — connect/disconnect an agent, set any status (including a `mystery-state` button to prove the unknown-status fallback), set a task, send an agent to the meeting room/lounge/a desk, or start/end an interaction with another agent. In Live mode, real data overwrites manual changes within a second or two (the server polls the board every 1s) — that's expected, live data is authoritative.

## What's real vs. simulated in Live mode

- **Real:** who's connected (via a 15s heartbeat each MCP server instance sends), their status/task from `presence_set`, active delegated tasks and who delegated them, interaction links between a delegator and its assignee while a task runs.
- **Simulated even in Live mode:** desk layout, walking between locations, the meeting room/lounge (the coordination server has no concept of physical location — those are entirely a visualization convenience). Real agents stay at their assigned desk; only the demo script sends characters wandering the office.
