import { defineConfig } from "wxt";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

function resolveCdpPort(): number {
  const port = Number(process.env.WXT_CHROMIUM_PORT ?? "9222");
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 9222;
}

export default defineConfig({
  extensionApi: "chrome",
  webExt: {
    // Keep WXT's dev Chrome reachable by browser automation agents via CDP.
    chromiumPort: resolveCdpPort(),
    chromiumArgs: [
      `--remote-debugging-port=${resolveCdpPort()}`,
      "--remote-allow-origins=*",
    ],
  },
  manifest: {
    name: "resume-agent",
    description: "AI-powered resume assistant with form fill",
    version: "0.1.0",
    permissions: ["activeTab", "scripting", "storage", "sidePanel", "tabs"],
    host_permissions: ["<all_urls>"],
    side_panel: {
      default_path: "sidepanel/index.html",
    },
    commands: {
      "toggle-picker": {
        suggested_key: {
          default: "Ctrl+Shift+E",
          mac: "Command+Shift+E",
        },
        description: "DOM 요소 picker 토글",
      },
    },
  },
  vite: () => ({
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": resolve(import.meta.dirname) },
    },
  }),
});
