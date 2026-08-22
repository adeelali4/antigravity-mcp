/** `antigravity-mcp-server update` — update the globally installed package to the latest version. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { findGlobalBin, PKG_NAME, BIN_NAME } from "./init.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function getGlobalVersion() {
  try {
    const res = spawnSync(NPM, ["list", "-g", PKG_NAME, "--json"], { 
      encoding: "utf8", 
      timeout: 10000,
      shell: process.platform === "win32"
    });
    if (res.error) return null;
    const json = JSON.parse(res.stdout);
    return json.dependencies?.[PKG_NAME]?.version || null;
  } catch {
    return null;
  }
}

export function update() {
  return new Promise((resolve) => {
    const installed = HERE.includes(`${path.sep}node_modules${path.sep}`);
    if (!installed) {
      return resolve({
        state: "local",
        detail: "Running from a local source checkout, not an installed package. Use `git pull` instead of npm."
      });
    }

    const globalBin = findGlobalBin();
    if (!globalBin) {
      return resolve({
        state: "npx",
        detail: "Running via npx, which always fetches the latest version on each launch. Nothing to update."
      });
    }

    const versionBefore = getGlobalVersion();
    
    const child = spawn(NPM, ["install", "-g", `${PKG_NAME}@latest`], { 
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    
    child.on("error", (err) => {
      resolve({ state: "error", detail: `npm install failed to spawn: ${err.message}` });
    });
    
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ state: "error", detail: `npm install exited with code ${code}` });
      } else {
        const versionAfter = getGlobalVersion();
        resolve({ state: "success", versionBefore, versionAfter });
      }
    });
  });
}

export function printUpdate(res) {
  console.log("");
  if (res.state === "npx") {
    console.log(`  - ${res.detail}`);
    console.log(`\n  Tip: Run \`npx ${PKG_NAME} init\` to refresh client configs or \`npx ${PKG_NAME} reset --yes\` to clear the board if needed.\n`);
  } else if (res.state === "local") {
    console.log(`  - ${res.detail}`);
    console.log(`\n  Tip: After pulling updates, run \`${BIN_NAME} init\` to refresh client configs and \`${BIN_NAME} reset --yes\` if the board needs clearing.\n`);
  } else if (res.state === "error") {
    console.error(`  x Update failed: ${res.detail}\n`);
    return true;
  } else if (res.state === "success") {
    if (res.versionBefore && res.versionAfter) {
      if (res.versionBefore === res.versionAfter) {
        console.log(`  + Already up-to-date at ${res.versionAfter}.`);
      } else {
        console.log(`  + Updated from ${res.versionBefore} to ${res.versionAfter}.`);
      }
    } else {
      console.log(`  + Update completed successfully.`);
    }
    console.log("\n  Next steps:");
    console.log(`  1. Run \`${BIN_NAME} restart\` (or restart your MCP clients) to refresh servers and state.`);
    console.log(`  2. Run \`${BIN_NAME} init\` if required (to refresh client configs or register newly supported tools).`);
    console.log(`  3. Run \`${BIN_NAME} reset --yes\` if required (to wipe the board if recovering from stuck tasks or stale state).\n`);
  }
  return false;
}
