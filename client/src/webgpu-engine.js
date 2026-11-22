/**
 * SwarmAI WebGPU Tensor Engine
 * Provides native GPU acceleration using WGSL compute shaders,
 * INT8 tensor compression for P2P streaming, and CPU fallback.
 */

export class WebGPUEngine {
  constructor() {
    this.adapter = null;
    this.device = null;
    this.isSupported = false;
    this.deviceInfo = { name: "CPU Fallback", vendor: "Generic", type: "CPU" };
    this.gemmPipeline = null;
    this.actPipeline = null;
    this.tflops = 0;
  }

  async initialize() {
    if (typeof navigator !== "undefined" && navigator.gpu) {
      try {
        this.adapter = await navigator.gpu.requestAdapter({
          powerPreference: "high-performance"
        });

        if (this.adapter) {
          this.device = await this.adapter.requestDevice();
          this.isSupported = true;

          const info = this.adapter.info || {};
          this.deviceInfo = {
            name: info.device || info.description || "WebGPU Compatible GPU",
            vendor: info.vendor || "Hardware GPU",
            architecture: info.architecture || "Unified Architecture",
            type: "WebGPU Native"
          };

          await this.compileShaders();
          await this.benchmarkGPU();
          return true;
        }
      } catch (err) {
        console.warn("[WebGPU] Hardware init failed, switching to CPU fallback:", err.message);
      }
    }

    this.isSupported = false;
    this.deviceInfo = { name: "CPU Math Accelerator", vendor: "WebAssembly/JS", type: "CPU" };
    return false;
  }

  async compileShaders() {
    if (!this.device) return;

    // WGSL Matrix Multiplication (GEMM) Shader
    const gemmCode = `
      struct Uniforms {
        M: u32,
        K: u32,
        N: u32,
        alpha: f32,
      };

      @group(0) @binding(0) var<storage, read> A : array<f32>;
      @group(0) @binding(1) var<storage, read> B : array<f32>;
      @group(0) @binding(2) var<storage, read_write> C : array<f32>;
      @group(0) @binding(3) var<uniform> u : Uniforms;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) id : vec3<u32>) {
        let row = id.x;
        let col = id.y;
        if (row >= u.M || col >= u.N) {
          return;
        }

        var sum : f32 = 0.0;
        for (var k = 0u; k < u.K; k = k + 1u) {
          sum = sum + A[row * u.K + k] * B[k * u.N + col];
        }
        C[row * u.N + col] = sum * u.alpha;
      }
    `;

    const gemmModule = this.device.createShaderModule({ code: gemmCode });
    this.gemmPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: gemmModule, entryPoint: "main" }
    });

    // WGSL RMSNorm + SiLU Activation Shader
    const actCode = `
      struct ActUniforms {
        size: u32,
        eps: f32,
      };

      @group(0) @binding(0) var<storage, read_write> X : array<f32>;
      @group(0) @binding(1) var<uniform> u : ActUniforms;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id : vec3<u32>) {
        let idx = id.x;
        if (idx >= u.size) { return; }
        let val = X[idx];
        // SiLU activation: x * sigmoid(x) = x / (1.0 + exp(-x))
        let sig = 1.0 / (1.0 + exp(-val));
        X[idx] = val * sig;
      }
    `;

    const actModule = this.device.createShaderModule({ code: actCode });
    this.actPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: actModule, entryPoint: "main" }
    });
  }

  /**
   * Performs matrix multiplication C = A x B
   * A: [M x K], B: [K x N], C: [M x N]
   */
  async matmul(A, B, M, K, N, alpha = 1.0) {
    if (this.isSupported && this.device && this.gemmPipeline) {
      return await this.matmulWebGPU(A, B, M, K, N, alpha);
    }
    return this.matmulCPU(A, B, M, K, N, alpha);
  }

  async matmulWebGPU(A, B, M, K, N, alpha) {
    const device = this.device;

    const bufferA = device.createBuffer({
      size: A.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Float32Array(bufferA.getMappedRange()).set(A);
    bufferA.unmap();

    const bufferB = device.createBuffer({
      size: B.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Float32Array(bufferB.getMappedRange()).set(B);
    bufferB.unmap();

    const outByteLength = M * N * 4;
    const bufferC = device.createBuffer({
      size: outByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const uniformArray = new ArrayBuffer(16);
    const uView = new DataView(uniformArray);
    uView.setUint32(0, M, true);
    uView.setUint32(4, K, true);
    uView.setUint32(8, N, true);
    uView.setFloat32(12, alpha, true);

    const uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint8Array(uniformBuffer.getMappedRange()).set(new Uint8Array(uniformArray));
    uniformBuffer.unmap();

    const bindGroup = device.createBindGroup({
      layout: this.gemmPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: bufferA } },
        { binding: 1, resource: { buffer: bufferB } },
        { binding: 2, resource: { buffer: bufferC } },
        { binding: 3, resource: { buffer: uniformBuffer } }
      ]
    });

    const stagingBuffer = device.createBuffer({
      size: outByteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    const commandEncoder = device.createCommandEncoder();
    const pass = commandEncoder.beginComputePass();
    pass.setPipeline(this.gemmPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(M / 8), Math.ceil(N / 8));
    pass.end();

    commandEncoder.copyBufferToBuffer(bufferC, 0, stagingBuffer, 0, outByteLength);
    device.queue.submit([commandEncoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(stagingBuffer.getMappedRange().slice(0));
    stagingBuffer.unmap();

    // Cleanup GPU resources
    bufferA.destroy();
    bufferB.destroy();
    bufferC.destroy();
    uniformBuffer.destroy();
    stagingBuffer.destroy();

    return result;
  }

  matmulCPU(A, B, M, K, N, alpha = 1.0) {
    const C = new Float32Array(M * N);
    for (let i = 0; i < M; i++) {
      const iK = i * K;
      const iN = i * N;
      for (let k = 0; k < K; k++) {
        const aVal = A[iK + k];
        const kN = k * N;
        for (let j = 0; j < N; j++) {
          C[iN + j] += aVal * B[kN + j];
        }
      }
    }
    if (alpha !== 1.0) {
      for (let idx = 0; idx < C.length; idx++) {
        C[idx] *= alpha;
      }
    }
    return C;
  }

  /**
   * Applies SiLU activation: x * sigmoid(x)
   */
  async applyActivation(tensor) {
    if (this.isSupported && this.device && this.actPipeline) {
      const device = this.device;
      const byteLength = tensor.byteLength;

      const bufferX = device.createBuffer({
        size: byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      new Float32Array(bufferX.getMappedRange()).set(tensor);
      bufferX.unmap();

      const uniformBuf = device.createBuffer({
        size: 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      const dv = new DataView(uniformBuf.getMappedRange());
      dv.setUint32(0, tensor.length, true);
      dv.setFloat32(4, 1e-5, true);
      uniformBuf.unmap();

      const bindGroup = device.createBindGroup({
        layout: this.actPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: bufferX } },
          { binding: 1, resource: { buffer: uniformBuf } }
        ]
      });

      const staging = device.createBuffer({
        size: byteLength,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.actPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(tensor.length / 64));
      pass.end();

      encoder.copyBufferToBuffer(bufferX, 0, staging, 0, byteLength);
      device.queue.submit([encoder.finish()]);

      await staging.mapAsync(GPUMapMode.READ);
      const res = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();

      bufferX.destroy();
      uniformBuf.destroy();
      staging.destroy();
      return res;
    }

    // CPU fallback
    const out = new Float32Array(tensor.length);
    for (let i = 0; i < tensor.length; i++) {
      const v = tensor[i];
      out[i] = v / (1.0 + Math.exp(-v));
    }
    return out;
  }

  /**
   * INT8 Quantization for WebRTC P2P DataChannel transmission
   * Compresses 32-bit floats into 8-bit integers with dynamic range scaling.
   */
  compressToInt8(float32Array) {
    const len = float32Array.length;
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < len; i++) {
      const v = float32Array[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    const range = max - min || 1e-8;
    const scale = range / 254.0;
    const int8 = new Int8Array(len);

    for (let i = 0; i < len; i++) {
      const normalized = (float32Array[i] - min) / scale;
      int8[i] = Math.round(normalized) - 127;
    }

    return {
      int8Buffer: int8.buffer,
      scale,
      min,
      length: len
    };
  }

  /**
   * INT8 Dequantization
   */
  decompressFromInt8(int8Buffer, scale, min, length) {
    const int8 = new Int8Array(int8Buffer);
    const float32 = new Float32Array(length);

    for (let i = 0; i < length; i++) {
      const unscaled = (int8[i] + 127) * scale + min;
      float32[i] = unscaled;
    }

    return float32;
  }

  async benchmarkGPU() {
    const N = 256;
    const A = new Float32Array(N * N).fill(0.5);
    const B = new Float32Array(N * N).fill(0.2);

    const t0 = performance.now();
    await this.matmul(A, B, N, N, N);
    const dt = performance.now() - t0;

    // 2 * N^3 floating point operations
    const ops = 2 * Math.pow(N, 3);
    const gflops = (ops / (dt / 1000.0)) / 1e9;
    this.tflops = Math.round(gflops * 10) / 10;
    console.log(`[WebGPU] Benchmark complete: ~${this.tflops} GFLOPS (Latency: ${dt.toFixed(2)}ms)`);
  }
}
