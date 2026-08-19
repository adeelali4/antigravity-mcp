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

- **Real:** who's connected (via a 15s heartbeat each MCP server instance sends), their status/task from `presence_set`, active delegated tasks and who delegated them. While a delegated task is genuinely running, **both** the delegator and the worker walk to the meeting room and show an interaction link — not just a static line, an actual trip there and back when the task finishes.
- **Simulated even in Live mode:** desk layout and the lounge (nothing routes anyone there from real data). The coordination server has no concept of physical location at all — the meeting-room visit for real interactions is the bridge's own interpretation ("these two are collaborating" → send them somewhere together), not something the server tracks.
- **A task's `status` field can go stale.** It only gets reconciled when something actively polls that task again (`ag_task_status`/`ag_task_wait`/`coop_status`) — a task whose process already died can sit at `"running"` in the board forever if nobody ever checks on it again. The bridge (`src/ui/bridgeState.js`) verifies the process is actually still alive (`isAlive(pid)`) before treating a task as real, live activity, rather than trusting the stored status blindly.
- **`presence_set`'s own status/detail can also go stale**, independent of the task fix above: a short-lived headless `agy`/`copilot` invocation calls `presence_set("working", ...)` when it starts, then the process exits the moment its single response completes — there's no natural point where it calls `presence_set("idle")` again. That status/detail text stays frozen at whatever it last said. This is bounded by the 45s connection-staleness window (`STALE_MS` in `bridgeState.js`): once nothing has touched that identity in 45s, it correctly flips to offline regardless of what the frozen status said. In the roughly-under-a-minute window before that, a just-finished short delegation can still show its last status/task text — a real echo of "something recently happened here," not a bug, but worth knowing if it looks like lag.

## Getting Copilot CLI to show up live

Delegating to Copilot (`copilot_delegate`) works out of the box — `init` registers this server into Copilot's own config (`~/.copilot/mcp-config.json`) and `copilot_delegate` already passes `--allow-all-tools`, so a delegated Copilot task can call `coop_status`/`presence_set` on itself same as `agy` does.

For **your own interactive/direct Copilot sessions** to report live presence, Copilot needs explicit permission to call the `coop` server — it has no persistent settings-file equivalent to `agy`'s `permissions.allow` (its `--allow-tool`/`--allow-all-tools` flags are session-scoped only). Add `--allow-tool='coop'` to how you invoke it, e.g. `copilot -p "..." --allow-tool='coop'`, or approve the permission prompt when Copilot asks in an interactive session. Without that, Copilot runs fine, it just won't be visible in the office until something delegates to it.
