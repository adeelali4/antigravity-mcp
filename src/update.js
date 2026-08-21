/** `antigravity-mcp-server update` — update the globally installed package to the latest version. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { findGlobalBin, PKG_NAME } from "./init.js";

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
    console.log(`  - ${res.detail}\n`);
  } else if (res.state === "local") {
    console.log(`  - ${res.detail}\n`);
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
    console.log("\n  Restart your MCP clients to pick up the new version.\n");
  }
  return false;
}
