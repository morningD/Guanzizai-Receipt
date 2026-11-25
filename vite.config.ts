import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import { createAppUpdateHandler } from "./server/app-update";
import { createLocalMaterialsMiddleware, diagnostics } from "./server/local-materials";

function localMaterialsPlugin(): Plugin {
  const middleware = createLocalMaterialsMiddleware();
  const update = createAppUpdateHandler();
  const trackedUpdate: typeof update = (request, response) =>
    diagnostics.track(request, response, "/api/app-update", () => update(request, response));
  return {
    name: "local-materials",
    configureServer(server) {
      server.middlewares.use("/api/app-update", trackedUpdate);
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/app-update", trackedUpdate);
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: mode === "portable" ? [{
      find: "./legacy-data",
      replacement: fileURLToPath(new URL("./src/portable-data.ts", import.meta.url)),
    }] : [],
  },
  plugins: [react(), localMaterialsPlugin()],
  test: { exclude: [...configDefaults.exclude, "**/guanzizai-receipt-dev/**"] },
  server: {
    host: "127.0.0.1",
    port: 8030,
    // 数据/材料目录不入模块图，watch 事件只会空耗——降噪
    watch: {
      ignored: ["**/data/**", "**/01_报销材料/**", "**/.guanzizai/**", "**/elab_research/**", "**/Downloads/**", "**/guanzizai-receipt-dev/**"],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 8030,
  },
}));
