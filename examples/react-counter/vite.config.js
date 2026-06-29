import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base './' so built assets load when the dist/ folder is served from the
// wpd working directory (relative, not root-absolute, asset urls).
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { sourcemap: true },
});
