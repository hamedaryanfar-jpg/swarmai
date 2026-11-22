/**
 * SwarmAI Edge Coordinator & WebRTC Signaling Worker
 * Runs on Cloudflare Workers edge runtime (V8 Isolates).
 * Includes Room-based WebRTC signaling, WebSocket upgrade, and R2 model streaming.
 */

// In-memory peer & message registry per isolate
const rooms = new Map(); // roomId -> Map(peerId -> { peerId, role, specs, lastSeen, signals: [] })

function cleanupStalePeers(room) {
  const now = Date.now();
  for (const [peerId, peer] of room.entries()) {
    if (now - peer.lastSeen > 60000) { // 60s timeout
      room.delete(peerId);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Set CORS headers for Web clients and IDE extensions
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Range, Authorization, X-Team-ID, X-Peer-ID",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, ETag",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 1. Health & Status Endpoint ---
    if (url.pathname === "/api/health") {
      let activePeersCount = 0;
      for (const room of rooms.values()) {
        activePeersCount += room.size;
      }

      return new Response(JSON.stringify({
        status: "online",
        system: "SwarmAI Edge Coordinator v1.0",
        region: request.cf?.colo || "EDGE-LOCAL",
        country: request.cf?.country || "LOCAL",
        city: request.cf?.city || "DevCity",
        activeRooms: rooms.size,
        activePeers: activePeersCount,
        timestamp: Date.now()
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // --- 2. WebSocket Real-time Signaling ---
    if (url.pathname === "/api/swarm/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket Upgrade", { status: 426, headers: corsHeaders });
      }

      const roomId = url.searchParams.get("roomId") || "public-mesh";
      const peerId = url.searchParams.get("peerId") || `peer-${Math.random().toString(36).substring(2, 9)}`;

      if (typeof WebSocketPair !== "undefined") {
        const pair = new WebSocketPair();
        const [clientWs, serverWs] = Object.values(pair);

        serverWs.accept();

        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Map());
        }
        const room = rooms.get(roomId);

        const peerData = {
          peerId,
          role: "worker",
          ws: serverWs,
          lastSeen: Date.now(),
          signals: []
        };
        room.set(peerId, peerData);

        // Notify others in room
        for (const [otherId, other] of room.entries()) {
          if (otherId !== peerId && other.ws && other.ws.readyState === WebSocket.OPEN) {
            other.ws.send(JSON.stringify({
              type: "peer_joined",
              peerId,
              totalPeers: room.size
            }));
          }
        }

        serverWs.addEventListener("message", (event) => {
          try {
            const msg = JSON.parse(event.data);
            peerData.lastSeen = Date.now();

            if (msg.type === "signal" && msg.toPeerId) {
              const targetPeer = room.get(msg.toPeerId);
              if (targetPeer && targetPeer.ws && targetPeer.ws.readyState === WebSocket.OPEN) {
                targetPeer.ws.send(JSON.stringify({
                  type: "signal",
                  fromPeerId: peerId,
                  signalType: msg.signalType,
                  payload: msg.payload
                }));
              }
            } else if (msg.type === "broadcast") {
              for (const [otherId, other] of room.entries()) {
                if (otherId !== peerId && other.ws && other.ws.readyState === WebSocket.OPEN) {
                  other.ws.send(JSON.stringify({
                    type: "broadcast",
                    fromPeerId: peerId,
                    payload: msg.payload
                  }));
                }
              }
            }
          } catch (e) {
            console.error("WS error:", e);
          }
        });

        serverWs.addEventListener("close", () => {
          room.delete(peerId);
          for (const [otherId, other] of room.entries()) {
            if (other.ws && other.ws.readyState === WebSocket.OPEN) {
              other.ws.send(JSON.stringify({
                type: "peer_left",
                peerId,
                totalPeers: room.size
              }));
            }
          }
        });

        return new Response(null, {
          status: 101,
          webSocket: clientWs,
          headers: corsHeaders
        });
      }
    }

    // --- 3. HTTP REST Signaling & Peer Registration (Fallback / Standard) ---
    // Register / Heartbeat / Join Room
    if (url.pathname === "/api/swarm/join" && request.method === "POST") {
      try {
        const body = await request.json();
        const roomId = body.roomId || "public-mesh";
        const peerId = body.peerId || `peer_${Math.random().toString(36).substring(2, 9)}`;
        const role = body.role || "worker";
        const specs = body.specs || {};

        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Map());
        }
        const room = rooms.get(roomId);
        cleanupStalePeers(room);

        // Assign Shards dynamically based on peer order
        const peerCount = room.size;
        const assignedShard = (peerCount % 2 === 0) ? "shard_0" : "shard_1";

        let peer = room.get(peerId);
        if (!peer) {
          peer = { peerId, role, specs, assignedShard, lastSeen: Date.now(), signals: [] };
          room.set(peerId, peer);
        } else {
          peer.lastSeen = Date.now();
          peer.specs = specs;
        }

        // Collect existing peers
        const activePeers = [];
        for (const [id, p] of room.entries()) {
          if (id !== peerId) {
            activePeers.push({
              peerId: p.peerId,
              role: p.role,
              assignedShard: p.assignedShard,
              specs: p.specs
            });
          }
        }

        return new Response(JSON.stringify({
          success: true,
          peerId,
          roomId,
          assignedShard,
          activePeers,
          totalPeers: room.size,
          geoRegion: request.cf?.city || "LocalEdge"
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // Send WebRTC Signal (Offer, Answer, ICE Candidate)
    if (url.pathname === "/api/swarm/signal" && request.method === "POST") {
      try {
        const body = await request.json();
        const { roomId = "public-mesh", fromPeerId, toPeerId, signalType, payload } = body;

        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Map());
        }
        const room = rooms.get(roomId);

        if (toPeerId) {
          // Direct signal to a specific peer
          const target = room.get(toPeerId);
          if (target) {
            target.signals.push({
              fromPeerId,
              signalType,
              payload,
              timestamp: Date.now()
            });
            return new Response(JSON.stringify({ acknowledged: true, queued: true }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          } else {
            return new Response(JSON.stringify({ error: "Target peer not found or offline" }), {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
        } else {
          // Broadcast to all other peers in room
          for (const [otherId, target] of room.entries()) {
            if (otherId !== fromPeerId) {
              target.signals.push({
                fromPeerId,
                signalType,
                payload,
                timestamp: Date.now()
              });
            }
          }
          return new Response(JSON.stringify({ acknowledged: true, broadcasted: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // Poll for pending signals
    if (url.pathname === "/api/swarm/poll" && request.method === "GET") {
      const roomId = url.searchParams.get("roomId") || "public-mesh";
      const peerId = url.searchParams.get("peerId");

      if (!peerId) {
        return new Response(JSON.stringify({ error: "Missing peerId param" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const room = rooms.get(roomId);
      if (!room || !room.has(peerId)) {
        return new Response(JSON.stringify({ signals: [], activePeers: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const peer = room.get(peerId);
      peer.lastSeen = Date.now();
      const signals = [...peer.signals];
      peer.signals = []; // drain queue

      const activePeers = [];
      for (const [id, p] of room.entries()) {
        if (id !== peerId) {
          activePeers.push({
            peerId: p.peerId,
            role: p.role,
            assignedShard: p.assignedShard
          });
        }
      }

      return new Response(JSON.stringify({
        signals,
        activePeers,
        totalPeers: room.size
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Leave room
    if (url.pathname === "/api/swarm/leave" && request.method === "POST") {
      try {
        const body = await request.json();
        const { roomId = "public-mesh", peerId } = body;
        const room = rooms.get(roomId);
        if (room && peerId) {
          room.delete(peerId);
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // --- 4. Model Shard Streaming (R2 with Local/Mock Fallback) ---
    if (url.pathname.startsWith("/model/")) {
      const fileName = url.pathname.replace("/model/", "");

      if (env && env.MODEL_STORAGE) {
        try {
          const object = await env.MODEL_STORAGE.get(fileName, {
            range: request.headers,
            onlyIf: request.headers,
          });

          if (object) {
            const headers = new Headers(corsHeaders);
            object.writeHttpMetadata(headers);
            headers.set("etag", object.httpEtag);
            headers.set("Cache-Control", "public, max-age=31536000, immutable");

            return new Response(object.body, {
              headers,
              status: object.body ? (request.headers.get("range") ? 206 : 200) : 304,
            });
          }
        } catch (e) {
          console.warn("R2 fetch error, using synthetic fallback:", e.message);
        }
      }

      // Synthetic weights / config fallback for development and offline testing
      if (fileName === "config.json") {
        return new Response(JSON.stringify({
          model_type: "swarm_transformer",
          architectures: ["SwarmQwenForCausalLM"],
          hidden_size: 1536,
          intermediate_size: 8960,
          num_attention_heads: 12,
          num_hidden_layers: 28,
          vocab_size: 151936,
          quantization: "int4_awq",
          shards: {
            shard_0: { layers: [0, 13], size_mb: 512 },
            shard_1: { layers: [14, 27], size_mb: 520 }
          }
        }, null, 2), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (fileName.endsWith(".bin") || fileName.endsWith(".weight")) {
        // Generate a valid sample tensor buffer (16KB) for handshake verification
        const sampleBuffer = new Uint8Array(16384);
        for (let i = 0; i < sampleBuffer.length; i++) {
          sampleBuffer[i] = (i * 17) & 0xff;
        }
        return new Response(sampleBuffer.buffer, {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${fileName}"`
          }
        });
      }

      return new Response(`File ${fileName} not found`, { status: 404, headers: corsHeaders });
    }

    // --- 5. Default Fallback & Static Asset Serving ---
    // If ASSETS binding exists (Unified Worker + Static Frontend), serve client UI!
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(JSON.stringify({
      message: "SwarmAI Edge Coordinator is operational.",
      endpoints: [
        "/api/health",
        "/api/swarm/join",
        "/api/swarm/signal",
        "/api/swarm/poll",
        "/api/swarm/ws",
        "/model/config.json",
        "/model/shard_0.bin"
      ]
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
};
