import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { prerenderLanding } from "./vite-prerender.ts";

export default defineConfig({
  // Лендинг в HTML первой загрузки и подсказки загрузки для public/boot.js (vite-prerender.ts)
  plugins: [react(), cloudflare(), prerenderLanding()],
});
