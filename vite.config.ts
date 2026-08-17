import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4173,
    watch: {
      ignored: [
        "**/__pycache__/**",
        "**/dist/**",
        "**/import_sheets.log",
        "**/import_sheets.pid",
        "**/token.json",
        "**/token1.json",
        "**/credentials.json",
        "**/credentials1.json",
        "**/profile.csv"
      ]
    },
    proxy: {
      "/api": "http://127.0.0.1:3001"
    }
  }
});
