import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import fs from "node:fs";
import path from "node:path";
import type { ViteDevServer } from "vite";

// In dev, serve local video files via http://localhost:1420/media/<abs-path>
// so GStreamer's souphttpsrc can speak to it directly (custom URI schemes
// like media:// don't work reliably with GStreamer in WebKitGTK dev mode).
function mediaServePlugin() {
  return {
    name: "media-serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/media/")) { next(); return; }
        const filePath = decodeURIComponent(req.url.slice("/media".length));

        let stat: fs.Stats;
        try { stat = fs.statSync(filePath); } catch {
          res.statusCode = 404; res.end("Not found"); return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeMap: Record<string, string> = {
          ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
          ".mov": "video/quicktime", ".avi": "video/x-msvideo",
          ".ogv": "video/ogg", ".ogg": "video/ogg",
        };
        const contentType = mimeMap[ext] ?? "application/octet-stream";
        const fileSize = stat.size;

        res.setHeader("Content-Type", contentType);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Access-Control-Allow-Origin", "*");

        const rangeHeader = req.headers["range"];
        if (rangeHeader) {
          const match = (rangeHeader as string).match(/bytes=(\d+)-(\d*)/);
          if (!match) { res.statusCode = 416; res.end(); return; }
          const start = parseInt(match[1], 10);
          const end = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1;
          const length = end - start + 1;
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
          res.setHeader("Content-Length", String(length));
          fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
          res.statusCode = 200;
          res.setHeader("Content-Length", String(fileSize));
          fs.createReadStream(filePath).pipe(res);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), mediaServePlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    proxy: {
      "/digger-api": {
        target: "http://localhost:8200",
        rewrite: (path) => path.replace(/^\/digger-api/, ""),
        ws: true,
      },
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: ["es2021", "chrome100"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        main: "index.html",
        output: "output.html",
      },
    },
  },
});
