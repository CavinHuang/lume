import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 3000, strictPort: true },
});
