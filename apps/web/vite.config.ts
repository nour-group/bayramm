import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { prerenderLanding } from "./vite-prerender.ts";

export default defineConfig({
  // Лендинг в HTML первой загрузки и подсказки загрузки для public/boot.js (vite-prerender.ts)
  plugins: [react(), cloudflare(), prerenderLanding()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // React — своим куском: меняется реже кода и остаётся в кэше браузера между выкладками
            { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            // Общее у словарей и оболочки (богатый текст, регистр) — отдельно: иначе сборщик кладёт
            // его в кусок словаря, и оболочка тянет второй язык на каждом первом заходе
            { name: "i18n-kit", test: /[\\/]shared[\\/]src[\\/]i18n[\\/](rich|text-case)\.ts$/ },
          ],
        },
      },
    },
  },
});
