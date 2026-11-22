/**
 * SwarmAI Client Node Master Controller
 * Connects WebGPUEngine, WebRTCMesh, AgentVFS, and SwarmEngine with the interactive UI.
 */
import { WebGPUEngine } from "./webgpu-engine.js";
import { WebRTCMesh } from "./webrtc-mesh.js";
import { AgentVFS } from "./agent-vfs.js";
import { SwarmEngine } from "./swarm-engine.js";

class SwarmNodeApp {
  constructor() {
    // Dynamically detect coordinator URL: same origin if deployed on Cloudflare or server.js, else localhost:8787
    const hostOrigin = (typeof window !== "undefined" && window.location && window.location.origin && window.location.origin.startsWith("http"))
      ? window.location.origin
      : "http://127.0.0.1:8787";

    this.coordinatorUrl = hostOrigin;
    this.webgpu = new WebGPUEngine();
    this.mesh = new WebRTCMesh(this.coordinatorUrl);
    this.vfs = new AgentVFS();
    this.engine = new SwarmEngine(this.webgpu, this.mesh, this.vfs);

    this.activeTab = "terminal";
    this.currentEditingFile = null;

    this.init();
  }

  async init() {
    this.bindUI();
    this.renderFileList();

    // 1. Initialize WebGPU
    const gpuOk = await this.webgpu.initialize();
    this.updateGpuUI(gpuOk);

    // 2. Initialize VFS callbacks
    this.vfs.onFilesChanged = () => this.renderFileList();

    // 3. Initialize Mesh callbacks
    this.mesh.onLogMessage = (log) => this.appendSwarmLog(log);
    this.mesh.onPeerListUpdate = (peers) => this.renderPeers(peers);
    this.mesh.onStatusChange = (status) => this.updateMeshStatus(status);
    this.mesh.onTensorReceived = (data) => this.handleRemoteTensor(data);

    // 4. Check Coordinator Health and Auto-join Room
    await this.connectCoordinator();
    await this.mesh.joinRoom("mesh-team-1", {
      gpu: this.webgpu.deviceInfo.name,
      tflops: this.webgpu.tflops
    });

    // 5. Setup Engine callbacks
    this.engine.onToolCall = (toolData) => this.handleToolCallEvent(toolData);
  }

  updateGpuUI(isOk) {
    const dot = document.getElementById("gpu-dot");
    const nameEl = document.getElementById("gpu-name");
    const badge = document.getElementById("gpu-perf-badge");
    const vendorEl = document.getElementById("gpu-vendor");
    const typeEl = document.getElementById("gpu-type");

    if (isOk) {
      dot.className = "dot dot-green";
      nameEl.innerText = this.webgpu.deviceInfo.name;
      badge.innerText = `~${this.webgpu.tflops} GFLOPS`;
      badge.style.background = "var(--green-glow)";
      badge.style.color = "var(--green)";
      vendorEl.innerText = this.webgpu.deviceInfo.vendor;
      typeEl.innerText = "WebGPU Accelerated";
    } else {
      dot.className = "dot dot-amber";
      nameEl.innerText = "CPU Math Acceleration";
      badge.innerText = "WASM Fallback";
      vendorEl.innerText = "Native Host";
      typeEl.innerText = "CPU Float32";
    }
  }

  async connectCoordinator() {
    const edgeDot = document.getElementById("edge-dot");
    const edgeStatus = document.getElementById("edge-status");

    try {
      const res = await fetch(`${this.coordinatorUrl}/api/health`).catch(() => null);
      if (res && res.ok) {
        const data = await res.json();
        edgeDot.className = "dot dot-green";
        edgeStatus.innerText = `Edge Coordinator: ${data.city || data.region} (${data.country})`;
      } else {
        edgeDot.className = "dot dot-amber";
        edgeStatus.innerText = "Coordinator: Local P2P Broadcast Mesh";
      }
    } catch {
      edgeDot.className = "dot dot-amber";
      edgeStatus.innerText = "Coordinator: Local P2P Broadcast Mesh";
    }
  }

  updateMeshStatus(status) {
    document.getElementById("my-peer-id").innerText = status.peerId;
    document.getElementById("room-display").innerText = status.roomId;
    const shardBadge = document.getElementById("my-shard-badge");
    shardBadge.innerText = (status.shard || "shard_0").toUpperCase();
  }

  renderPeers(peers) {
    const container = document.getElementById("peer-list-container");
    const countEl = document.getElementById("peer-count");
    countEl.innerText = peers.length;

    if (peers.length === 0) {
      container.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); padding: 4px 0;">Looking for nearby peers...</div>`;
      return;
    }

    container.innerHTML = "";
    let totalLat = 0;

    for (const p of peers) {
      totalLat += p.latency;
      const item = document.createElement("div");
      item.className = "peer-item";
      item.innerHTML = `
        <div>
          <span class="dot dot-green"></span>
          <code>${p.peerId}</code>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <span class="peer-tag">${p.shard.toUpperCase()}</span>
          <span style="font-size: 0.72rem; color: var(--text-muted);">${p.latency}ms</span>
        </div>
      `;
      container.appendChild(item);
    }

    const avgLat = Math.round(totalLat / peers.length);
    document.getElementById("mesh-avg-latency").innerText = `${avgLat} ms`;
    document.getElementById("tensors-forwarded-count").innerText = this.mesh.stats.tensorsForwarded;
  }

  appendSwarmLog(log) {
    const history = document.getElementById("swarm-logs-history");
    const line = document.createElement("div");
    const time = new Date(log.timestamp).toLocaleTimeString();
    line.style.color = log.type === "warn" ? "var(--amber)" : log.type === "success" ? "#56d364" : "#8b949e";
    line.innerHTML = `<span style="color: #6e7681;">[${time}]</span> ${log.msg}`;
    history.appendChild(line);
    history.scrollTop = history.scrollHeight;
  }

  handleRemoteTensor(data) {
    document.getElementById("tensors-forwarded-count").innerText = this.mesh.stats.tensorsForwarded;
    this.appendSwarmLog({
      msg: `⚡ Received and processed tensor from ${data.fromPeerId} over DataChannel`,
      type: "success",
      timestamp: Date.now()
    });
  }

  renderFileList() {
    const list = document.getElementById("vfs-file-list");
    list.innerHTML = "";
    const files = this.vfs.listFiles();

    for (const file of files) {
      const item = document.createElement("div");
      item.className = "file-item";
      const icon = file.endsWith(".js") ? "📜" : file.endsWith(".json") ? "⚙️" : file.endsWith(".md") ? "📝" : "📄";
      item.innerHTML = `<span class="file-icon">${icon}</span><span>${file}</span>`;
      item.addEventListener("click", () => this.openFileModal(file));
      list.appendChild(item);
    }
  }

  openFileModal(filePath) {
    this.currentEditingFile = filePath;
    const modal = document.getElementById("file-modal");
    const title = document.getElementById("modal-file-title");
    const editor = document.getElementById("modal-editor-content");

    title.innerText = filePath;
    editor.value = this.vfs.files.get(filePath) || "";
    modal.style.display = "flex";
  }

  closeFileModal() {
    document.getElementById("file-modal").style.display = "none";
    this.currentEditingFile = null;
  }

  bindUI() {
    // Mode Switcher Buttons
    const modes = [
      { id: "mode-chat-btn", mode: "chat", title: "💬 Chat Mode" },
      { id: "mode-plan-btn", mode: "plan", title: "📋 Plan Mode" },
      { id: "mode-agent-btn", mode: "agent", title: "🤖 Agent Mode" }
    ];

    modes.forEach(({ id, mode, title }) => {
      document.getElementById(id).addEventListener("click", () => {
        modes.forEach(m => document.getElementById(m.id).classList.remove("active"));
        document.getElementById(id).classList.add("active");
        this.engine.setMode(mode);
        document.getElementById("current-mode-header").innerText = title;
      });
    });

    // Send Button & Textarea
    const promptInput = document.getElementById("prompt-input");
    const sendBtn = document.getElementById("send-btn");

    const doSend = () => {
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = "";
      this.sendPrompt(text);
    };

    sendBtn.addEventListener("click", doSend);
    promptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    // Prompt chips
    document.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const p = chip.dataset.prompt;
        this.sendPrompt(p);
      });
    });

    // Room joiner
    document.getElementById("join-room-btn").addEventListener("click", async () => {
      const room = document.getElementById("room-input").value.trim();
      if (room) {
        await this.mesh.joinRoom(room, {
          gpu: this.webgpu.deviceInfo.name,
          tflops: this.webgpu.tflops
        });
      }
    });

    // Mount folder
    document.getElementById("mount-folder-btn").addEventListener("click", async () => {
      const res = await this.vfs.mountLocalFolder();
      if (res.success) {
        alert(`Mounted local folder: ${res.folderName}`);
      } else {
        alert(`Folder mount: ${res.error}`);
      }
    });

    // Bottom Drawer Tabs & Minimize
    const drawer = document.getElementById("bottom-drawer");
    document.getElementById("drawer-toggle-btn").addEventListener("click", () => {
      drawer.classList.toggle("minimized");
    });

    document.getElementById("tab-terminal-btn").addEventListener("click", () => {
      document.getElementById("tab-terminal-btn").classList.add("active");
      document.getElementById("tab-logs-btn").classList.remove("active");
      document.getElementById("tab-terminal-content").style.display = "block";
      document.getElementById("tab-logs-content").style.display = "none";
      drawer.classList.remove("minimized");
    });

    document.getElementById("tab-logs-btn").addEventListener("click", () => {
      document.getElementById("tab-logs-btn").classList.add("active");
      document.getElementById("tab-terminal-btn").classList.remove("active");
      document.getElementById("tab-logs-content").style.display = "block";
      document.getElementById("tab-terminal-content").style.display = "none";
      drawer.classList.remove("minimized");
    });

    // Interactive Terminal Shell
    const termInput = document.getElementById("terminal-cmd-input");
    termInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        const cmd = termInput.value.trim();
        if (!cmd) return;
        termInput.value = "";
        await this.runTerminalCommand(cmd);
      }
    });

    // File Editor Modal Buttons
    document.getElementById("modal-close-btn").addEventListener("click", () => this.closeFileModal());
    document.getElementById("modal-cancel-btn").addEventListener("click", () => this.closeFileModal());
    document.getElementById("modal-save-btn").addEventListener("click", () => {
      if (this.currentEditingFile) {
        const content = document.getElementById("modal-editor-content").value;
        this.vfs.writeFile(this.currentEditingFile, content);
        this.closeFileModal();
      }
    });
  }

  async runTerminalCommand(cmd) {
    const history = document.getElementById("terminal-history");
    const cmdLine = document.createElement("div");
    cmdLine.innerHTML = `<span class="terminal-prompt">workspace$</span> <span style="color: white;">${this.escapeHtml(cmd)}</span>`;
    history.appendChild(cmdLine);

    const res = await this.vfs.runCommand(cmd);

    if (res.stdout) {
      const out = document.createElement("pre");
      out.className = "terminal-line";
      out.innerText = res.stdout;
      history.appendChild(out);
    }

    if (res.stderr) {
      const err = document.createElement("pre");
      err.className = "terminal-error";
      err.innerText = res.stderr;
      history.appendChild(err);
    }

    const drawer = document.getElementById("tab-terminal-content");
    drawer.scrollTop = drawer.scrollHeight;
  }

  async sendPrompt(text) {
    const chatFeed = document.getElementById("chat-feed");

    // 1. Append User Message
    const userDiv = document.createElement("div");
    userDiv.className = "message user";
    userDiv.innerText = text;
    chatFeed.appendChild(userDiv);

    // 2. Append Assistant Message Container
    const assistantDiv = document.createElement("div");
    assistantDiv.className = "message assistant";
    assistantDiv.innerHTML = `<span style="color: var(--text-muted);">Thinking & coordinating across mesh...</span>`;
    chatFeed.appendChild(assistantDiv);
    chatFeed.scrollTop = chatFeed.scrollHeight;

    let fullMarkdown = "";
    let isFirstChunk = true;

    await this.engine.handlePrompt(
      text,
      (chunk) => {
        if (isFirstChunk) {
          assistantDiv.innerHTML = "";
          isFirstChunk = false;
        }
        fullMarkdown += chunk;
        assistantDiv.innerHTML = this.renderMarkdown(fullMarkdown);

        // If in Plan Mode, inject "Approve & Execute" button
        if (this.engine.currentMode === "plan" && fullMarkdown.includes("Safety Gate:")) {
          if (!assistantDiv.querySelector(".plan-action-btn")) {
            const btn = document.createElement("button");
            btn.className = "plan-action-btn";
            btn.innerHTML = `🚀 Approve & Execute in Agent Mode`;
            btn.addEventListener("click", () => {
              document.getElementById("mode-agent-btn").click();
              this.sendPrompt(`Execute approved plan for: ${text}`);
            });
            assistantDiv.appendChild(btn);
          }
        }

        // If in Chat Mode and code was generated, inject "Save to Workspace" button
        if (this.engine.currentMode === "chat" && this.engine.lastGeneratedCode && fullMarkdown.includes("```")) {
          if (!assistantDiv.querySelector(".save-action-btn")) {
            const btn = document.createElement("button");
            btn.className = "plan-action-btn save-action-btn";
            btn.style.background = "var(--accent)";
            btn.innerHTML = `💾 Save ${this.engine.lastGeneratedCode.filename} to Workspace (Agent Mode)`;
            btn.addEventListener("click", () => {
              document.getElementById("mode-agent-btn").click();
              this.sendPrompt(`fileshi bede`);
            });
            assistantDiv.appendChild(btn);
          }
        }

        chatFeed.scrollTop = chatFeed.scrollHeight;
      },
      () => {
        chatFeed.scrollTop = chatFeed.scrollHeight;
      }
    );
  }

  handleToolCallEvent(toolData) {
    const history = document.getElementById("terminal-history");
    const logLine = document.createElement("div");
    logLine.style.color = "var(--purple)";
    logLine.innerHTML = `⚡ <strong>Agent Tool Call:</strong> <code>${toolData.tool}</code> (${JSON.stringify(toolData.params)})`;
    history.appendChild(logLine);

    this.appendSwarmLog({
      msg: `Agent invoked tool: ${toolData.tool}`,
      type: "info",
      timestamp: Date.now()
    });
  }

  renderMarkdown(text) {
    // Lightweight safe Markdown renderer
    let html = this.escapeHtml(text);

    // Code blocks
    html = html.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code class="language-${lang}">${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // Headers
    html = html.replace(/^#### (.*$)/gim, '<h4 style="margin: 8px 0 4px; color: var(--text-bright);">$1</h4>');
    html = html.replace(/^### (.*$)/gim, '<h3 style="margin: 12px 0 6px; color: var(--text-bright);">$1</h3>');

    // Blockquotes
    html = html.replace(/^> (.*$)/gim, '<blockquote style="border-left: 3px solid var(--accent); padding-left: 10px; color: #8b949e; margin: 6px 0;">$1</blockquote>');

    // Lists
    html = html.replace(/^\s*-\s+(.*$)/gim, '<li style="margin-left: 20px;">$1</li>');

    // Line breaks
    html = html.replace(/\n/g, "<br>");
    html = html.replace(/<\/pre><br>/g, "</pre>");

    return html;
  }

  escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

// Instantiate on DOM ready
window.addEventListener("DOMContentLoaded", () => {
  window.swarmApp = new SwarmNodeApp();
});
