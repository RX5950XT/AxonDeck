import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// 打包版用 file://，index.html 的 ../../assets/icon*.png 指到倉庫的 assets。
// Vite 的文件在 http://127.0.0.1:5173/，同一條相對路徑會被收成 /assets/… 而 404。
function devBrandIcons() {
  const files = {
    "/assets/icon.png": path.join(repoRoot, "assets/icon.png"),
    "/assets/icon_64.png": path.join(repoRoot, "assets/icon_64.png"),
  };
  return {
    name: "dev-brand-icons",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = String(req.url || "").split("?")[0];
        const file = files[url];
        if (!file) return next();
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-cache");
        const stream = fs.createReadStream(file);
        stream.on("error", () => next());
        stream.pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [devBrandIcons()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
