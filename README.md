# ⚡ SwarmAI: Decentralized Edge-to-Client AI Coding Engine

**SwarmAI** is a zero-server-compute ($0 Compute), privacy-first AI coding companion.  
Instead of renting expensive cloud GPUs and risking confidential code leakage, SwarmAI shards transformer layers across developer devices using **WebGPU** and **WebRTC DataChannels**, coordinated through a lightweight **Cloudflare Worker** edge coordinator and **Cloudflare R2** zero-egress model storage.

---

## 🚀 Quickstart (One Command)

### Run the Unified Dev Server
Starts both the Edge Coordinator (API & WebRTC Signaling) and the Client Playground simultaneously on port `3000`:

```bash
npm start
# or: node server.js
```

Then open your browser at:
👉 **[http://localhost:3000](http://localhost:3000)**

### Run Automated End-to-End Tests
Verifies the edge coordinator, WebGPU GEMM compute & INT8 quantization, Agent VFS tools, and the 3 tripartite modes:

```bash
npm test
```

---

## 🛠️ Tripartite Operating Modes

| Mode | Trigger | Purpose & Tool Permissions |
| :--- | :---: | :--- |
| **💬 Chat Mode** | `/chat` | Pure consultation, algorithmic design, and tensor streaming across WebGPU peers. Read-only, zero file edits. |
| **📋 Plan Mode** | `/plan` | Indexes repository files, formulates an ordered execution checklist, and halts at a safety gate for developer approval. |
| **🤖 Agent Mode** | `/agent` | Autonomous ReAct loop (`read_file`, `write_file`, `edit_file`, `run_command` in terminal) with automatic self-healing. |

---

## 📂 Architecture & Key Components

```
├── server.js                        # Unified zero-dependency local runner (Coordinator + Static Server)
├── package.json                     # Root project scripts (start, coordinator, test)
├── cloudflare/
│   ├── src/index.js                 # Cloudflare Worker: Room Signaling, WebSocket & R2 Shard Streaming
│   ├── standalone-server.js         # Dedicated standalone runner for Coordinator
│   └── wrangler.toml                # Cloudflare deployment config (R2 bindings)
├── client/
│   └── src/
│       ├── index.html               # Modern developer UI (Mesh monitor, File explorer, Terminal)
│       ├── swarm-node.js            # Client application master controller
│       ├── webgpu-engine.js         # WGSL compute shaders (GEMM, SiLU) & INT8 compressor
│       ├── webrtc-mesh.js           # WebRTC DataChannel P2P mesh & signaling client
│       ├── agent-vfs.js             # Persistent Virtual File System, directory mounter, & tools
│       └── swarm-engine.js          # Tripartite ReAct loop coordinator
├── test/
│   └── e2e-test.js                  # 100% automated integration test suite
├── AGENT.md                         # Autonomous agent specification & tool schemas
├── PLAN.md                          # Master architectural blueprint, SWOT analysis & business model
└── README.md                        # Documentation and onboarding guide
```

---

## 🌐 Cloudflare Edge Deployment (Production)

To deploy the coordinator to Cloudflare's global edge network:

```bash
cd cloudflare
npm install
npx wrangler r2 bucket create swarm-ai-models
npx wrangler deploy
```

---

## 🧪 Tech Stack
- **Edge Coordinator:** Cloudflare Workers (V8 Isolates) + R2 Object Storage (Zero-Egress)
- **Local Acceleration:** WebGPU (WGSL compute pipelines) with CPU Wasm fallback
- **Peer-to-Peer:** WebRTC DataChannel (UDP/SCTP) with INT8 dynamic quantization
- **Workspace Sandbox:** Persistent VFS + Web File System Access API + JavaScript execution sandbox
