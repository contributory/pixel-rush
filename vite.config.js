import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Dev serving is owned by `deno task dev` (main.ts hosts Vite in
  // middleware mode + the /ws relay on a single port). `vite build` below is
  // still the way to produce the production bundle in dist/.
});
