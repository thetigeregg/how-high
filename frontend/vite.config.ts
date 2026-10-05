import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      // API_TARGET points the dev server at another backend, e.g. a scratch one for testing.
      "/api": process.env.API_TARGET ?? "http://localhost:3000",
    },
  },
});
