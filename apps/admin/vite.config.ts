import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { tgBotUsername } from "./telegram.config.ts";

export default defineConfig({
  plugins: [react(), cloudflare()],
  define: {
    // Бот виджета входа — по окружению сборки (telegram.config.ts)
    "import.meta.env.VITE_TG_BOT_USERNAME": JSON.stringify(
      tgBotUsername(process.env.CLOUDFLARE_ENV, process.env.VITE_TG_BOT_USERNAME),
    ),
  },
});
