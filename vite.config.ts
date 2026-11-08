import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Run the UI through Vite and API requests through the local Workers runtime. */
export default defineConfig({
  plugins: [react(), cloudflare({ viteEnvironment: { name: "worker" } })],
});
