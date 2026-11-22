/**
 * SwarmAI Unified Local Server
 * Serves both the Edge Coordinator (API & Signaling) and the Client Playground
 * using standard Node.js built-in modules without external dependencies.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./cloudflare/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CLIENT_ROOT = path.join(__dirname, "client", "src");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".bin": "application/octet-stream"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  // Route 1: Cloudflare Edge Coordinator API routes
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/model/")) {
    try {
      let body = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }

      const workerReq = new Request(url.toString(), {
        method: req.method,
        headers,
        body: body && body.length > 0 ? body : null
      });

      const workerRes = await worker.fetch(workerReq, {});

      res.statusCode = workerRes.status;
      for (const [k, v] of workerRes.headers.entries()) {
        res.setHeader(k, v);
      }

      const resBuf = await workerRes.arrayBuffer();
      res.end(Buffer.from(resBuf));
      return;
    } catch (err) {
      console.error("Worker Route Error:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // Route 2: Static Client Files
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  let targetPath = path.join(CLIENT_ROOT, filePath);

  if (!fs.existsSync(targetPath)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end(`404 Not Found: ${filePath}`);
    return;
  }

  const ext = path.extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Access-Control-Allow-Origin", "*");

  const stream = fs.createReadStream(targetPath);
  stream.pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`⚡ SwarmAI Unified Server is Live!`);
  console.log(`======================================================`);
  console.log(`👉 Open Client UI:         http://localhost:${PORT}/`);
  console.log(`👉 Edge Coordinator API:   http://localhost:${PORT}/api/health`);
  console.log(`👉 Model Shard Config:     http://localhost:${PORT}/model/config.json`);
  console.log(`======================================================\n`);
});
