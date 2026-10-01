import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    rolldownOptions: {
      output: {
        // React — своим куском: он меняется реже кода панели и остаётся в кэше браузера между
        // выкладками. Экраны делит src/screens.ts, конфигурацию категорий — их общий кусок
        codeSplitting: {
          groups: [{ name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
});
