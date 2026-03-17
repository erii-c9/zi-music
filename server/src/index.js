import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import cors from "cors";
import express from "express";
import morgan from "morgan";
import { getBilibiliStreamHeaders, getTrack, searchVideos } from "./lib/bilibili.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDistPath = path.resolve(__dirname, "../../web/dist");

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(morgan("dev"));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "zi-music-server",
      time: new Date().toISOString()
    });
  });

  app.get("/api/search", async (req, res) => {
    const query = String(req.query.q || "").trim();
    const page = Number.parseInt(String(req.query.page || "1"), 10) || 1;

    if (!query) {
      return res.status(400).json({ error: "Missing required query parameter q" });
    }

    try {
      const payload = await searchVideos(query, page);
      res.json(payload);
    } catch (error) {
      res.status(502).json({
        error: "Search failed",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/api/tracks/:bvid", async (req, res) => {
    try {
      const track = await getTrack(req.params.bvid);
      res.json(track);
    } catch (error) {
      res.status(502).json({
        error: "Track lookup failed",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/api/stream/:bvid", async (req, res) => {
    try {
      const track = await getTrack(req.params.bvid);
      const upstream = await fetch(track.audioUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
          Referer: "https://www.bilibili.com/",
          ...getBilibiliStreamHeaders(req.headers.range)
        }
      });

      if (!upstream.ok && upstream.status !== 206) {
        return res.status(502).json({
          error: "Audio stream request failed",
          detail: `Upstream status ${upstream.status}`
        });
      }

      res.status(upstream.status);

      [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "cache-control",
        "etag",
        "last-modified"
      ].forEach((header) => {
        const value = upstream.headers.get(header);
        if (value) {
          res.setHeader(header, value);
        }
      });

      const contentType = upstream.headers.get("content-type");
      if (!contentType || contentType === "application/octet-stream") {
        res.setHeader("content-type", "audio/mp4");
      }

      if (!upstream.body) {
        return res.end();
      }

      Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
      res.status(502).json({
        error: "Audio streaming failed",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  if (process.env.NODE_ENV === "production") {
    app.use(express.static(webDistPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(webDistPath, "index.html"));
    });
  }

  return app;
}

export function startServer(port = process.env.PORT || 3001) {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Zi Music server running at http://localhost:${port}`);
      resolve(server);
    });

    server.on("error", (error) => {
      reject(error);
    });
  });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  startServer().catch((error) => {
    console.error("Failed to start Zi Music server:", error);
    process.exit(1);
  });
}
