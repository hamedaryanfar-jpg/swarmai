/**
 * SwarmAI WebRTC P2P Mesh & Signaling Engine
 * Manages peer discovery via Cloudflare Coordinator, RTCPeerConnection negotiation,
 * RTCDataChannel tensor transmission, and BroadcastChannel local pairing.
 */

export class WebRTCMesh {
  constructor(coordinatorUrl = "http://127.0.0.1:8787") {
    this.coordinatorUrl = coordinatorUrl;
    this.roomId = "mesh-default";
    this.peerId = `node_${Math.random().toString(36).substring(2, 8)}`;
    this.role = "worker";
    this.assignedShard = "shard_0";
    this.activePeers = new Map(); // peerId -> { peerConnection, dataChannel, latency, role, shard }
    
    this.pollInterval = null;
    this.pingInterval = null;
    this.isConnected = false;
    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      tensorsForwarded: 0,
      avgLatencyMs: 0
    };

    // Callbacks
    this.onStatusChange = null;
    this.onPeerListUpdate = null;
    this.onTensorReceived = null;
    this.onLogMessage = null;

    // Cross-tab fallback channel
    this.localBroadcast = new BroadcastChannel(`swarm_mesh_${this.roomId}`);
    this.setupLocalBroadcast();
  }

  log(msg, type = "info") {
    console.log(`[SwarmMesh] ${msg}`);
    if (this.onLogMessage) {
      this.onLogMessage({ msg, type, timestamp: Date.now() });
    }
  }

  async joinRoom(roomId, specs = {}) {
    this.roomId = roomId || this.roomId;
    this.log(`Connecting to Cloudflare Coordinator for Room '${this.roomId}'...`);

    // Reset local broadcast channel for new room
    if (this.localBroadcast) {
      this.localBroadcast.close();
    }
    this.localBroadcast = new BroadcastChannel(`swarm_mesh_${this.roomId}`);
    this.setupLocalBroadcast();

    try {
      const response = await fetch(`${this.coordinatorUrl}/api/swarm/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          role: this.role,
          specs
        })
      });

      if (!response.ok) {
        throw new Error(`Coordinator returned HTTP ${response.status}`);
      }

      const data = await response.json();
      this.assignedShard = data.assignedShard || "shard_0";
      this.isConnected = true;
      this.log(`Joined Mesh! Assigned: ${this.assignedShard.toUpperCase()} (${data.totalPeers} total peers).`);

      // Initiate connection to existing peers
      if (Array.isArray(data.activePeers)) {
        for (const peer of data.activePeers) {
          this.initiatePeerConnection(peer.peerId, true);
        }
      }

      // Start signaling poll loop
      this.startPolling();
      this.startHeartbeat();

      if (this.onStatusChange) {
        this.onStatusChange({ connected: true, peerId: this.peerId, roomId: this.roomId, shard: this.assignedShard });
      }

      return data;
    } catch (err) {
      this.log(`Coordinator offline (${err.message}). Using Autonomous P2P Local Mesh.`, "warn");
      this.isConnected = true;
      // Announce on local broadcast
      this.localBroadcast.postMessage({
        type: "ANNOUNCE",
        fromPeerId: this.peerId,
        shard: this.assignedShard
      });

      if (this.onStatusChange) {
        this.onStatusChange({ connected: true, peerId: this.peerId, roomId: this.roomId, shard: this.assignedShard, mode: "Local Mesh" });
      }

      return { success: true, localOnly: true };
    }
  }

  setupLocalBroadcast() {
    this.localBroadcast.onmessage = (event) => {
      const data = event.data;
      if (!data || data.fromPeerId === this.peerId) return;

      if (data.type === "ANNOUNCE") {
        this.log(`Local peer discovered via Broadcast: ${data.fromPeerId}`);
        // Assign opposite shard for balanced 2-way sharding
        const remoteShard = data.shard === "shard_0" ? "shard_1" : "shard_0";
        this.activePeers.set(data.fromPeerId, {
          peerId: data.fromPeerId,
          role: "worker",
          shard: remoteShard,
          latency: 4, // local bus latency < 5ms
          channel: "broadcast"
        });
        this.notifyPeerList();

        // Respond with ack
        this.localBroadcast.postMessage({
          type: "ANNOUNCE_ACK",
          fromPeerId: this.peerId,
          shard: this.assignedShard
        });
      } else if (data.type === "ANNOUNCE_ACK") {
        this.activePeers.set(data.fromPeerId, {
          peerId: data.fromPeerId,
          role: "worker",
          shard: data.shard,
          latency: 4,
          channel: "broadcast"
        });
        this.notifyPeerList();
      } else if (data.type === "TENSOR_DATA") {
        this.handleIncomingTensor(data.fromPeerId, data.payload);
      }
    };
  }

  startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);

    this.pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${this.coordinatorUrl}/api/swarm/poll?roomId=${encodeURIComponent(this.roomId)}&peerId=${encodeURIComponent(this.peerId)}`);
        if (!res.ok) return;

        const data = await res.json();
        if (Array.isArray(data.signals)) {
          for (const sig of data.signals) {
            await this.handleIncomingSignal(sig);
          }
        }

        // Sync peer list
        if (Array.isArray(data.activePeers)) {
          for (const p of data.activePeers) {
            if (!this.activePeers.has(p.peerId)) {
              this.initiatePeerConnection(p.peerId, false);
            }
          }
        }
      } catch (err) {
        // quiet poll fail
      }
    }, 1500);
  }

  startHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);

    this.pingInterval = setInterval(() => {
      const now = Date.now();
      for (const [peerId, peer] of this.activePeers.entries()) {
        if (peer.dataChannel && peer.dataChannel.readyState === "open") {
          peer.dataChannel.send(JSON.stringify({ type: "PING", t: now }));
        }
      }
    }, 4000);
  }

  async sendSignal(toPeerId, signalType, payload) {
    try {
      await fetch(`${this.coordinatorUrl}/api/swarm/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: this.roomId,
          fromPeerId: this.peerId,
          toPeerId,
          signalType,
          payload
        })
      });
    } catch (e) {
      this.log(`Signal dispatch error: ${e.message}`, "warn");
    }
  }

  async initiatePeerConnection(targetPeerId, isInitiator) {
    if (this.activePeers.has(targetPeerId) && this.activePeers.get(targetPeerId).peerConnection) {
      return;
    }

    this.log(`Initiating WebRTC handshake with Peer ${targetPeerId} (Initiator: ${isInitiator})`);

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    });

    const peerInfo = {
      peerId: targetPeerId,
      peerConnection: pc,
      dataChannel: null,
      latency: 0,
      role: "worker",
      shard: this.assignedShard === "shard_0" ? "shard_1" : "shard_0"
    };

    this.activePeers.set(targetPeerId, peerInfo);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(targetPeerId, "candidate", event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      this.log(`Peer ${targetPeerId} connection state: ${pc.connectionState}`);
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        this.activePeers.delete(targetPeerId);
        this.notifyPeerList();
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel("swarm-tensors", { ordered: true });
      this.setupDataChannel(targetPeerId, dc);
      peerInfo.dataChannel = dc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal(targetPeerId, "offer", offer);
    } else {
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        this.setupDataChannel(targetPeerId, dc);
        peerInfo.dataChannel = dc;
      };
    }
  }

  setupDataChannel(peerId, dc) {
    dc.onopen = () => {
      this.log(`⚡ WebRTC DataChannel OPENED with Peer ${peerId}!`, "success");
      this.notifyPeerList();
    };

    dc.onclose = () => {
      this.log(`DataChannel closed with Peer ${peerId}`);
      this.notifyPeerList();
    };

    dc.onmessage = (event) => {
      try {
        if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          if (msg.type === "PING") {
            dc.send(JSON.stringify({ type: "PONG", t: msg.t }));
          } else if (msg.type === "PONG") {
            const rtt = Date.now() - msg.t;
            const peer = this.activePeers.get(peerId);
            if (peer) {
              peer.latency = rtt;
              this.stats.avgLatencyMs = rtt;
              this.notifyPeerList();
            }
          } else if (msg.type === "TENSOR_ACTIVATION") {
            this.handleIncomingTensor(peerId, msg.data);
          }
        }
      } catch (e) {
        console.error("DC message error:", e);
      }
    };
  }

  async handleIncomingSignal(sig) {
    const { fromPeerId, signalType, payload } = sig;
    let peer = this.activePeers.get(fromPeerId);

    if (!peer || !peer.peerConnection) {
      await this.initiatePeerConnection(fromPeerId, false);
      peer = this.activePeers.get(fromPeerId);
    }

    const pc = peer.peerConnection;

    if (signalType === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.sendSignal(fromPeerId, "answer", answer);
    } else if (signalType === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } else if (signalType === "candidate") {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload));
      } catch (err) {
        // ignore duplicate candidate
      }
    }
  }

  /**
   * Broadcasts or forwards activation tensor across P2P Mesh
   */
  forwardTensorToPeers(tensorPacket) {
    let sentCount = 0;
    const packetStr = JSON.stringify({
      type: "TENSOR_ACTIVATION",
      fromPeerId: this.peerId,
      shard: this.assignedShard,
      data: tensorPacket,
      timestamp: Date.now()
    });

    const byteLen = packetStr.length;
    this.stats.bytesSent += byteLen;
    this.stats.tensorsForwarded += 1;

    // Send via WebRTC DataChannels
    for (const [peerId, peer] of this.activePeers.entries()) {
      if (peer.dataChannel && peer.dataChannel.readyState === "open") {
        peer.dataChannel.send(packetStr);
        sentCount++;
      }
    }

    // Also dispatch to local broadcast channel
    if (this.localBroadcast) {
      this.localBroadcast.postMessage({
        type: "TENSOR_DATA",
        fromPeerId: this.peerId,
        payload: tensorPacket
      });
      sentCount++;
    }

    this.log(`Forwarded activation tensor (${Math.round(byteLen / 1024)} KB) to ${sentCount} peer(s).`);
    return sentCount;
  }

  handleIncomingTensor(fromPeerId, payload) {
    this.stats.bytesReceived += JSON.stringify(payload).length;
    this.log(`Received tensor activation from Peer ${fromPeerId}`, "info");

    if (this.onTensorReceived) {
      this.onTensorReceived({ fromPeerId, payload });
    }
  }

  notifyPeerList() {
    if (this.onPeerListUpdate) {
      const peers = [];
      for (const [id, p] of this.activePeers.entries()) {
        peers.push({
          peerId: id,
          shard: p.shard || "shard_1",
          latency: p.latency || 5,
          connected: (p.dataChannel && p.dataChannel.readyState === "open") || p.channel === "broadcast"
        });
      }
      this.onPeerListUpdate(peers);
    }
  }

  disconnect() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const peer of this.activePeers.values()) {
      if (peer.peerConnection) peer.peerConnection.close();
    }
    this.activePeers.clear();
    if (this.localBroadcast) this.localBroadcast.close();
  }
}
