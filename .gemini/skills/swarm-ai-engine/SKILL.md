---
name: swarm-ai-engine
description: Complete blueprint, deployment guide, and debugging utilities for the SwarmAI decentralized coding engine using Cloudflare Workers, R2, WebGPU, and WebRTC.
---

# SwarmAI Engine Skill

This skill provides step-by-step procedures, architectural patterns, and debugging guides for developing, deploying, and maintaining the **SwarmAI** distributed AI coding system.

---

## When to Use This Skill
- Setting up or deploying the Cloudflare Worker coordinator (`wrangler.toml` and Worker scripts).
- Configuring Cloudflare R2 bucket storage for sharded model weights.
- Implementing or debugging WebRTC P2P signaling and direct DataChannel tensor transfers.
- Configuring WebGPU runtimes (WebLLM / Transformers.js / ONNX Runtime Web) on client devices.
- Setting up Private Team Swarms (Workspace isolation and local office LAN peering).

---

## Technical Stack Overview

| Component | Technology | Role |
| :--- | :--- | :--- |
| **Edge Coordinator** | Cloudflare Workers (JavaScript/ESM) | Signaling, Geo-clustering, Node presence, Token routing |
| **Model Weight Store** | Cloudflare R2 (S3-compatible) | 4-bit quantized shards, zero egress fees |
| **Client Tensor Engine** | WebGPU + WebAssembly (C++) | Local GPU execution of transformer layers |
| **P2P Communication** | WebRTC DataChannel (SCTP/UDP) | Inter-device hidden state and activation streaming |
| **Local Persistence** | IndexedDB / Cache API | Instant caching of model shards and async gradient buffer |

---

## Step-by-Step Procedures

### 1. Cloudflare Coordinator Setup
To initialize and deploy the edge coordinator:

```bash
cd cloudflare
npm install
npx wrangler r2 bucket create swarm-ai-models
npx wrangler deploy
```

Key environment bindings in `wrangler.toml`:
* `r2_buckets`: Binding named `MODEL_STORAGE` pointing to `swarm-ai-models`.
* `kv_namespaces`: Binding named `SWARM_NODES` for maintaining real-time peer presence.

### 2. Model Sharding Specification (2-Way Coarse Split)
When sharding an open-weights coding model (e.g., `Qwen2.5-Coder-1.5B-Instruct`):

1. **Quantization:** Quantize model weights to 4-bit (AWQ or Q4_K_M). Total size: ~1.05 GB.
2. **Chunk Division:**
   - `shard_0.bin`: Embedding layer + Layers 0 through 13 (~520 MB).
   - `shard_1.bin`: Layers 14 through 27 + Final RMSNorm & LM Head (~530 MB).
   - `tokenizer.json` & `config.json`: Metadata (~2 MB).
3. **Upload to R2:**
   ```bash
   npx wrangler r2 object put swarm-ai-models/v1/shard_0.bin --file=./weights/shard_0.bin
   npx wrangler r2 object put swarm-ai-models/v1/shard_1.bin --file=./weights/shard_1.bin
   npx wrangler r2 object put swarm-ai-models/v1/config.json --file=./weights/config.json
   ```

### 3. WebRTC Direct DataChannel Pipeline
The tensor exchange between Peer A (Layers 0–13) and Peer B (Layers 14–27):

```javascript
// Peer A sends activation tensor to Peer B
const hiddenState = computeLayers0To13(inputTokens);
const quantizedVector = compressToInt8(hiddenState);

// Direct P2P transmission over WebRTC DataChannel
dataChannel.send(quantizedVector);

// Peer B receives, decompresses, and runs remaining layers
dataChannel.onmessage = (event) => {
  const dequantizedState = decompressFromInt8(event.data);
  const logits = computeLayers14To27(dequantizedState);
  const nextToken = sampleLogits(logits);
  emitNextToken(nextToken);
};
```

---

## Verification & Health Check Checklist
- [ ] Verify WebGPU support: `navigator.gpu != undefined` in Chrome/Edge/Safari.
- [ ] Verify WebRTC STUN/TURN connection between two separate machines.
- [ ] Check Cloudflare Worker response time on `/api/health`: should be < 15ms.
- [ ] Confirm R2 Range Request streaming returns HTTP 206 Partial Content.
