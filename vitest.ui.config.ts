import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** Test the React entry point and interactions in a DOM-like browser runtime. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "https://example.test/" } },
    include: ["test/ui/**/*.spec.ts", "test/ui/**/*.spec.tsx"],
    coverage: {
      provider: "istanbul",
      include: ["src/App.tsx", "src/theme.ts", "src/main.tsx"],
      reportsDirectory: "./coverage/ui",
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: { 100: true, perFile: true },
    },
  },
});
