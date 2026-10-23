import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import config from "../backend/src/bedrock_editor/app_constants.json";
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "application-title",
      transformIndexHtml: () => [
        {
          tag: "title",
          children: `${config.brand} ${config.edition} · ${config.caption}`,
          injectTo: "head",
        },
      ],
    },
  ],
  publicDir:
    mode === "installer"
      ? false
      : fileURLToPath(new URL("../resource_packs", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: config.development.frontend_port,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${config.development.backend_port}` },
  },
}));
