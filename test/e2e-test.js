/**
 * SwarmAI Automated End-to-End Integration Test Suite
 */
import assert from "node:assert";
import worker from "../cloudflare/src/index.js";
import { WebGPUEngine } from "../client/src/webgpu-engine.js";
import { AgentVFS } from "../client/src/agent-vfs.js";
import { SwarmEngine } from "../client/src/swarm-engine.js";

// Mock localStorage for Node test environment
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

let passed = 0;
let total = 0;

async function test(name, fn) {
  total++;
  process.stdout.write(`• Testing: ${name}... `);
  try {
    await fn();
    console.log(`\x1b[32mPASS\x1b[0m`);
    passed++;
  } catch (err) {
    console.log(`\x1b[31mFAIL\x1b[0m`);
    console.error(err);
  }
}

async function runAll() {
  console.log("\n=======================================================");
  console.log("⚡ Starting SwarmAI Verification Test Suite");
  console.log("=======================================================\n");

  // TEST 1: Coordinator /api/health
  await test("Coordinator: Health check endpoint", async () => {
    const res = await worker.fetch(new Request("http://localhost/api/health"), {});
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, "online");
    assert.ok(data.system.includes("SwarmAI Edge Coordinator"));
  });

  // TEST 2: Coordinator Peer Join & Signaling
  await test("Coordinator: Room join & dynamic shard assignment", async () => {
    const res1 = await worker.fetch(new Request("http://localhost/api/swarm/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: "e2e-mesh", peerId: "peer_alpha", specs: { gpu: "TestGPU" } })
    }), {});
    const data1 = await res1.json();
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data1.peerId, "peer_alpha");
    assert.strictEqual(data1.assignedShard, "shard_0");

    // Second peer should get shard_1
    const res2 = await worker.fetch(new Request("http://localhost/api/swarm/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: "e2e-mesh", peerId: "peer_beta" })
    }), {});
    const data2 = await res2.json();
    assert.strictEqual(data2.assignedShard, "shard_1");
  });

  // TEST 3: Coordinator Signal Exchange & Polling
  await test("Coordinator: Signal queueing and delivery", async () => {
    // Send signal from alpha to beta
    const sigRes = await worker.fetch(new Request("http://localhost/api/swarm/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: "e2e-mesh",
        fromPeerId: "peer_alpha",
        toPeerId: "peer_beta",
        signalType: "offer",
        payload: { sdp: "dummy-sdp-test" }
      })
    }), {});
    const sigData = await sigRes.json();
    assert.strictEqual(sigData.acknowledged, true);

    // Poll signals for beta
    const pollRes = await worker.fetch(new Request("http://localhost/api/swarm/poll?roomId=e2e-mesh&peerId=peer_beta"), {});
    const pollData = await pollRes.json();
    assert.strictEqual(pollData.signals.length, 1);
    assert.strictEqual(pollData.signals[0].signalType, "offer");
    assert.strictEqual(pollData.signals[0].fromPeerId, "peer_alpha");
  });

  // TEST 4: Model Shard Config
  await test("Coordinator: Model metadata and synthetic shard streaming", async () => {
    const confRes = await worker.fetch(new Request("http://localhost/model/config.json"), {});
    const config = await confRes.json();
    assert.strictEqual(config.model_type, "swarm_transformer");
    assert.ok(config.shards.shard_0);
    assert.ok(config.shards.shard_1);

    const binRes = await worker.fetch(new Request("http://localhost/model/shard_0.bin"), {});
    assert.strictEqual(binRes.status, 200);
    const buf = await binRes.arrayBuffer();
    assert.ok(buf.byteLength > 1000);
  });

  // TEST 5: WebGPU Math Engine & INT8 Quantization
  await test("WebGPU Engine: GEMM MatMul & INT8 Compression/Decompression", async () => {
    const engine = new WebGPUEngine();
    await engine.initialize();

    // 2x2 MatMul: [[1, 2], [3, 4]] x [[5, 6], [7, 8]]
    // Row 0: 1*5 + 2*7 = 19; 1*6 + 2*8 = 22
    // Row 1: 3*5 + 4*7 = 43; 3*6 + 4*8 = 50
    const A = new Float32Array([1, 2, 3, 4]);
    const B = new Float32Array([5, 6, 7, 8]);
    const C = await engine.matmul(A, B, 2, 2, 2);

    assert.strictEqual(Math.round(C[0]), 19);
    assert.strictEqual(Math.round(C[1]), 22);
    assert.strictEqual(Math.round(C[2]), 43);
    assert.strictEqual(Math.round(C[3]), 50);

    // INT8 Quantization test
    const rawFloats = new Float32Array([0.1, -0.8, 1.5, 0.0, -1.2]);
    const compressed = engine.compressToInt8(rawFloats);
    assert.strictEqual(compressed.length, 5);

    const restored = engine.decompressFromInt8(compressed.int8Buffer, compressed.scale, compressed.min, compressed.length);
    for (let i = 0; i < rawFloats.length; i++) {
      assert.ok(Math.abs(rawFloats[i] - restored[i]) < 0.05, `Quantization drift too high at idx ${i}`);
    }
  });

  // TEST 6: Agent VFS Tools
  await test("Agent VFS: Tool execution (read_file, write_file, edit_file, run_command)", async () => {
    const vfs = new AgentVFS();

    // 1. read_file
    const read = await vfs.readFile("package.json");
    assert.ok(!read.error);
    assert.ok(read.content.includes("demo-project"));

    // 2. run_command (npm test)
    const testCmd = await vfs.runCommand("npm test");
    assert.strictEqual(testCmd.exitCode, 0);
    assert.ok(testCmd.stdout.includes("PASS"));

    // 3. edit_file
    const editRes = await vfs.editFile("src/math-utils.js", "if (n <= 1) return n;", "// Optimized check\n  if (n <= 1) return n;");
    assert.strictEqual(editRes.success, true);

    const verifyRead = await vfs.readFile("src/math-utils.js");
    assert.ok(verifyRead.content.includes("// Optimized check"));

    // 4. re-run test
    const retest = await vfs.runCommand("npm test");
    assert.strictEqual(retest.exitCode, 0);
  });

  // TEST 7: Swarm Engine Tripartite Execution
  await test("Swarm Engine: Chat, Plan, and Agent modes", async () => {
    const webgpu = new WebGPUEngine();
    await webgpu.initialize();

    // Mock mesh for headless test
    const mockMesh = {
      assignedShard: "shard_0",
      activePeers: new Map(),
      forwardTensorToPeers: () => 1
    };

    const vfs = new AgentVFS();
    const engine = new SwarmEngine(webgpu, mockMesh, vfs);

    // A. Chat Mode
    engine.setMode("chat");
    let chatOutput = "";
    await engine.handlePrompt("Explain Fibonacci", (chunk) => { chatOutput += chunk; }, () => {});
    assert.ok(chatOutput.includes("Fibonacci") || chatOutput.includes("Complexity"));

    // B. Plan Mode
    engine.setMode("plan");
    let planOutput = "";
    await engine.handlePrompt("Plan math optimization", (chunk) => { planOutput += chunk; }, () => {});
    assert.ok(planOutput.includes("Execution Blueprint"));
    assert.ok(planOutput.includes("Step 1:"));

    // C. Agent Mode
    engine.setMode("agent");
    let agentOutput = "";
    await engine.handlePrompt("Autonomously optimize math-utils.js", (chunk) => { agentOutput += chunk; }, () => {});
    assert.ok(agentOutput.includes("Autonomous ReAct loop finished successfully"));
  });

  console.log("\n=======================================================");
  console.log(`Results: ${passed} / ${total} tests passed (${Math.round((passed / total) * 100)}%)`);
  console.log("=======================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error("Test Suite Fatal Error:", err);
  process.exit(1);
});
