/**
 * Standalone Node.js Runner for Cloudflare Coordinator
 * Enables 100% zero-dependency execution locally without needing wrangler login or cloudflare account.
 */
import http from "node:http";
import worker from "./src/index.js";

const PORT = process.env.PORT || 8787;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    
    // Read request body if present
    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    // Construct Web Fetch standard Request object
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
    }

    const standardRequest = new Request(url.toString(), {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : null
    });

    // Invoke Worker
    const response = await worker.fetch(standardRequest, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers.entries()) {
      res.setHeader(k, v);
    }

    const responseBody = await response.arrayBuffer();
    res.end(Buffer.from(responseBody));
  } catch (err) {
    console.error("Local Coordinator error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`⚡ [SwarmAI Coordinator] Local Edge Node running at http://127.0.0.1:${PORT}`);
  console.log(`   • Health check: http://127.0.0.1:${PORT}/api/health`);
  console.log(`   • Signaling:    http://127.0.0.1:${PORT}/api/swarm/join`);
});
