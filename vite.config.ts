import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig(({ command }) => ({
  // GitHub Pages sert ce repo sous /Rise-and-Rule/, pas à la racine du
  // domaine — uniquement en build (le dev server reste à "/", plus simple
  // en local).
  base: command === "build" ? "/Rise-and-Rule/" : "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
