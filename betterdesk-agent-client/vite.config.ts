import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import type { Plugin } from "vite";

// WebKitGTK (Linux) does not return CORS headers for the custom tauri://
// protocol, so any resource loaded with the `crossorigin` attribute fails
// silently — CSS is never applied, JS never executes, leaving a blank window.
// Vite adds `crossorigin` automatically on ES-module builds; strip it here.
function removeCrossoriginPlugin(): Plugin {
  return {
    name: "remove-crossorigin",
    transformIndexHtml(html: string) {
      return html.replace(/\s+crossorigin(?:="[^"]*")?/g, "");
    },
  };
}

export default defineConfig({
  plugins: [solidPlugin(), removeCrossoriginPlugin()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // Disable module-preload polyfill injection — it emits extra
    // <link rel="modulepreload" crossorigin> tags that also fail on WebKitGTK.
    modulePreload: false,
  },
});
