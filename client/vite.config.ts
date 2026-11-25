import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";

// Helius key stays on this machine: the dev server adds it to proxied requests,
// so the browser only ever talks to /helius on this page's own address.
const keyFile = process.env.HELIUS_KEY_FILE ?? "/mnt/c/Users/glyde/Documents/helius-key.txt";
const heliusKey = existsSync(keyFile)
  ? (() => { const t = readFileSync(keyFile, "utf8").replace(/^\uFEFF/, "").trim(); return /api-key=([A-Za-z0-9-]+)/.exec(t)?.[1] ?? t; })()
  : "";
const withKey = (path: string) => {
  const p = path.replace(/^\/helius/, "") || "/";
  return p + (p.includes("?") ? "&" : "?") + `api-key=${heliusKey}`;
};

export default defineConfig({
  root: "app",
  resolve: { preserveSymlinks: true },
  server: {
    // app/ is linked to the Windows Documents copy; poll so edits there reload the page.
    watch: { usePolling: true, interval: 1000 },
    port: 5173, host: true, strictPort: true, fs: { allow: ["..", "../.."] },
    // Same-origin routes to the local services, so the browser only ever talks to this page's address.
    proxy: {
      "/relayer": { target: "http://127.0.0.1:8787", rewrite: (p) => p.replace(/^\/relayer/, "") },
      "/faucet": { target: "http://127.0.0.1:8788", rewrite: (p) => p.replace(/^\/faucet/, "") },
      "/helius": { target: "https://devnet.helius-rpc.com", changeOrigin: true, secure: true, ws: true, rewrite: withKey },
    },
  },
  define: { "process.env": {}, global: "globalThis" },
  build: { outDir: "../dist-app", emptyOutDir: true, target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
