import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built output ships inside the published package (see package.json's
// "files") and is served by `antigravity-mcp-server ui` -- a plain static
// bundle, no server-side templating, so a relative base works from any port.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../ui-dist",
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: false },
});
