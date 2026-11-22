/**
 * SwarmAI Virtual File System & Tool Execution Engine
 * Provides persistent in-browser storage, real directory mounting (File System Access API),
 * and the 4 standard Agent tools: read_file, write_file, edit_file, run_command.
 */

export class AgentVFS {
  constructor() {
    this.storageKey = "swarm_ai_vfs_files";
    this.files = new Map();
    this.directoryHandle = null; // Native File System Access Handle if mounted
    this.onFilesChanged = null;

    this.initDefaultFiles();
  }

  initDefaultFiles() {
    const saved = localStorage.getItem(this.storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        for (const [path, content] of Object.entries(parsed)) {
          this.files.set(path, content);
        }
        return;
      } catch (e) {
        console.warn("Error restoring VFS:", e);
      }
    }

    // Default Seed Project Files
    this.files.set("package.json", JSON.stringify({
      name: "demo-project",
      version: "1.0.0",
      description: "Sample project inside SwarmAI Virtual Workspace",
      main: "src/index.js",
      scripts: {
        test: "node tests/test.js",
        start: "node src/index.js"
      }
    }, null, 2));

    this.files.set("src/index.js", `/**
 * Sample Application Entry Point
 */
import { calculateFibonacci, sumArray } from './math-utils.js';

console.log("Starting App...");
const fib10 = calculateFibonacci(10);
console.log("Fibonacci(10) =", fib10);

const total = sumArray([10, 20, 30, 40]);
console.log("Total Sum =", total);
`);

    this.files.set("src/math-utils.js", `export function calculateFibonacci(n) {
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    const c = a + b;
    a = b;
    b = c;
  }
  return b;
}

export function sumArray(arr) {
  return arr.reduce((acc, curr) => acc + curr, 0);
}
`);

    this.files.set("tests/test.js", `import { calculateFibonacci, sumArray } from '../src/math-utils.js';

console.log("[TEST] Running test suite...");
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log("  PASS: " + message);
    passed++;
  } else {
    console.error("  FAIL: " + message);
    failed++;
  }
}

assert(calculateFibonacci(0) === 0, "Fibonacci of 0 is 0");
assert(calculateFibonacci(1) === 1, "Fibonacci of 1 is 1");
assert(calculateFibonacci(10) === 55, "Fibonacci of 10 is 55");
assert(sumArray([1, 2, 3]) === 6, "Sum of [1,2,3] is 6");

console.log(\`[RESULT] \${passed} passed, \${failed} failed.\`);
`);

    this.files.set("README.md", `# Demo Project in SwarmAI VFS

This is a local in-browser virtual workspace.
You can use **Agent Mode** to modify files, fix bugs, or run tests directly!
`);

    this.save();
  }

  save() {
    const obj = {};
    for (const [path, content] of this.files.entries()) {
      obj[path] = content;
    }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(obj));
    } catch (e) {
      console.warn("VFS save quota exceeded:", e);
    }
    if (this.onFilesChanged) {
      this.onFilesChanged(this.listFiles());
    }
  }

  listFiles() {
    return Array.from(this.files.keys()).sort();
  }

  async mountLocalFolder() {
    if (typeof window.showDirectoryPicker === "function") {
      try {
        this.directoryHandle = await window.showDirectoryPicker();
        await this.scanDirectory(this.directoryHandle, "");
        this.save();
        return { success: true, folderName: this.directoryHandle.name };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: "File System Access API not supported in this browser." };
  }

  async scanDirectory(dirHandle, pathPrefix = "") {
    for await (const entry of dirHandle.values()) {
      const entryPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      if (entry.kind === "file") {
        const file = await entry.getFile();
        if (file.size < 500000) { // Limit to 500KB per file
          const text = await file.text();
          this.files.set(entryPath, text);
        }
      } else if (entry.kind === "directory") {
        await this.scanDirectory(entry, entryPath);
      }
    }
  }

  // --- AGENT TOOL 1: read_file ---
  async readFile(path, startLine, endLine) {
    const normalized = path.replace(/^\.\//, "");
    if (!this.files.has(normalized)) {
      return { error: `File '${path}' does not exist in workspace.` };
    }

    const content = this.files.get(normalized);
    const lines = content.split("\n");

    if (startLine !== undefined && endLine !== undefined) {
      const start = Math.max(0, startLine - 1);
      const end = Math.min(lines.length, endLine);
      const slice = lines.slice(start, end).join("\n");
      return { content: slice, totalLines: lines.length, linesShown: [start + 1, end] };
    }

    return { content, totalLines: lines.length };
  }

  // --- AGENT TOOL 2: write_file ---
  async writeFile(path, content) {
    const normalized = path.replace(/^\.\//, "");
    this.files.set(normalized, content);
    this.save();
    return { success: true, path: normalized, bytesWritten: content.length };
  }

  // --- AGENT TOOL 3: edit_file ---
  async editFile(path, target, replacement) {
    const normalized = path.replace(/^\.\//, "");
    if (!this.files.has(normalized)) {
      return { error: `File '${path}' does not exist.` };
    }

    const content = this.files.get(normalized);
    if (!content.includes(target)) {
      return {
        error: `Target string was not found in '${path}'. Make sure exact characters and whitespace match.`,
        fileContentSnippet: content.substring(0, 300)
      };
    }

    const updated = content.replaceAll(target, replacement);
    this.files.set(normalized, updated);
    this.save();
    return { success: true, path: normalized, message: "Target replaced successfully." };
  }

  // --- AGENT TOOL 4: run_command ---
  async runCommand(command) {
    const cmd = command.trim();
    const parts = cmd.split(/\s+/);
    const base = parts[0];

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    switch (base) {
      case "pwd":
        stdout = "/workspace/project\n";
        break;

      case "ls": {
        const files = this.listFiles();
        stdout = files.join("  ") + "\n";
        break;
      }

      case "cat": {
        const target = parts[1];
        if (!target) {
          stderr = "cat: missing file argument\n";
          exitCode = 1;
        } else {
          const res = await this.readFile(target);
          if (res.error) {
            stderr = `cat: ${res.error}\n`;
            exitCode = 1;
          } else {
            stdout = res.content + "\n";
          }
        }
        break;
      }

      case "echo": {
        stdout = parts.slice(1).join(" ").replace(/^['"]|['"]$/g, "") + "\n";
        break;
      }

      case "touch": {
        const target = parts[1];
        if (target && !this.files.has(target)) {
          this.files.set(target, "");
          this.save();
          stdout = `Created file ${target}\n`;
        }
        break;
      }

      case "rm": {
        const target = parts[1];
        if (this.files.has(target)) {
          this.files.delete(target);
          this.save();
          stdout = `Removed ${target}\n`;
        } else {
          stderr = `rm: cannot remove '${target}': No such file\n`;
          exitCode = 1;
        }
        break;
      }

      case "npm": {
        const sub = parts[1];
        if (sub === "test") {
          return await this.executeTestRunner();
        } else if (sub === "run") {
          const script = parts[2];
          if (script === "test") return await this.executeTestRunner();
          stdout = `Running custom script '${script}'... Done.\n`;
        } else {
          stdout = `npm v10.2.0 (simulated)\nAdded 0 packages.\n`;
        }
        break;
      }

      case "node": {
        const script = parts[1];
        if (!script) {
          stdout = "Node.js v20.0.0 (SwarmAI Client Virtual Environment)\n";
        } else {
          return await this.executeNodeScript(script);
        }
        break;
      }

      case "git": {
        const sub = parts[1];
        if (sub === "status") {
          stdout = "On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges to be committed: none\n";
        } else if (sub === "diff") {
          stdout = "diff --git a/src/math-utils.js b/src/math-utils.js\n(workspace is clean)\n";
        } else {
          stdout = `git: '${sub}' executed successfully.\n`;
        }
        break;
      }

      default:
        stderr = `command not found: ${base}\n`;
        exitCode = 127;
        break;
    }

    return { command, stdout, stderr, exitCode };
  }

  async executeTestRunner() {
    const testFile = this.files.get("tests/test.js");
    if (!testFile) {
      return { command: "npm test", stdout: "", stderr: "tests/test.js not found\n", exitCode: 1 };
    }
    return await this.executeNodeScript("tests/test.js");
  }

  async executeNodeScript(filePath) {
    const normalized = filePath.replace(/^\.\//, "");
    if (!this.files.has(normalized)) {
      return { command: `node ${filePath}`, stdout: "", stderr: `Error: Cannot find module '${filePath}'\n`, exitCode: 1 };
    }

    let logs = [];
    let errLogs = [];

    // Simple in-browser safe module simulator
    try {
      const code = this.files.get(normalized);
      // Strip import/export statements for in-browser evaluation and bind available utils
      const mathCode = this.files.get("src/math-utils.js") || "";
      const mathScope = {};
      
      const cleanMath = mathCode.replace(/export function\s+(\w+)/g, "mathScope.$1 = function");
      const evalMath = new Function("mathScope", cleanMath);
      evalMath(mathScope);

      const customConsole = {
        log: (...args) => logs.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")),
        error: (...args) => errLogs.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")),
        warn: (...args) => logs.push("[WARN] " + args.join(" "))
      };

      let executableCode = code
        .replace(/import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"];?/g, (match, names) => {
          return `const { ${names} } = mathScope;`;
        })
        .replace(/export\s+/g, "");

      const runFn = new Function("console", "mathScope", executableCode);
      runFn(customConsole, mathScope);

      const stdout = logs.join("\n") + (logs.length > 0 ? "\n" : "");
      const stderr = errLogs.join("\n") + (errLogs.length > 0 ? "\n" : "");

      return {
        command: `node ${filePath}`,
        stdout,
        stderr,
        exitCode: errLogs.length > 0 && !stdout.includes("FAIL: 0") ? 1 : 0
      };
    } catch (err) {
      return {
        command: `node ${filePath}`,
        stdout: logs.join("\n"),
        stderr: err.toString() + "\n",
        exitCode: 1
      };
    }
  }
}
