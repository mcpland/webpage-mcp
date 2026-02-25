/**
 * SIMD-optimized mathematical computation engine
 * Uses WebAssembly + SIMD instructions to accelerate vector calculations
 */

interface SIMDMathWasm {
  free(): void;
  cosine_similarity(vec_a: Float32Array, vec_b: Float32Array): number;
  batch_similarity(vectors: Float32Array, query: Float32Array, vector_dim: number): Float32Array;
  similarity_matrix(
    vectors_a: Float32Array,
    vectors_b: Float32Array,
    vector_dim: number,
  ): Float32Array;
}

interface WasmModule {
  SIMDMath: new () => SIMDMathWasm;
  memory: WebAssembly.Memory;
  default: (module_or_path?: any) => Promise<any>;
}

export class SIMDMathEngine {
  private wasmModule: WasmModule | null = null;
  private simdMath: SIMDMathWasm | null = null;
  private isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  private alignedBufferPool: Map<number, Float32Array[]> = new Map();
  private maxPoolSize = 5;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitialize().finally(() => {
      this.isInitializing = false;
    });

    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      console.log('SIMDMathEngine: Initializing WebAssembly module...');

      const wasmUrl = chrome.runtime.getURL('workers/simd_math.js');
      const wasmModule = await import(wasmUrl);

      const wasmInstance = await wasmModule.default();

      this.wasmModule = {
        SIMDMath: wasmModule.SIMDMath,
        memory: wasmInstance.memory,
        default: wasmModule.default,
      };

      this.simdMath = new this.wasmModule.SIMDMath();

      this.isInitialized = true;
      console.log('SIMDMathEngine: WebAssembly module initialized successfully');
    } catch (error) {
      console.error('SIMDMathEngine: Failed to initialize WebAssembly module:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Get aligned buffer (16-byte aligned, suitable for SIMD)
   */
  private getAlignedBuffer(size: number): Float32Array {
    if (!this.alignedBufferPool.has(size)) {
      this.alignedBufferPool.set(size, []);
    }

    const pool = this.alignedBufferPool.get(size)!;
    if (pool.length > 0) {
      return pool.pop()!;
    }

    // Create 16-byte aligned buffer
    const buffer = new ArrayBuffer(size * 4 + 15);
    const alignedOffset = (16 - (buffer.byteLength % 16)) % 16;
    return new Float32Array(buffer, alignedOffset, size);
  }

  /**
   * Release aligned buffer back to pool
   */
  private releaseAlignedBuffer(buffer: Float32Array): void {
    const size = buffer.length;
    const pool = this.alignedBufferPool.get(size);
    if (pool && pool.length < this.maxPoolSize) {
      buffer.fill(0); // Clear to zero
      pool.push(buffer);
    }
  }

  /**
   * Check if vector is already aligned
   */
  private isAligned(array: Float32Array): boolean {
    return array.byteOffset % 16 === 0;
  }

  /**
   * Ensure vector alignment, create aligned copy if not aligned
   */
  private ensureAligned(array: Float32Array): { aligned: Float32Array; needsRelease: boolean } {
    if (this.isAligned(array)) {
      return { aligned: array, needsRelease: false };
    }

    const aligned = this.getAlignedBuffer(array.length);
    aligned.set(array);
    return { aligned, needsRelease: true };
  }

  /**
   * SIMD-optimized cosine similarity calculation
   */
  async cosineSimilarity(vecA: Float32Array, vecB: Float32Array): Promise<number> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.simdMath) {
      throw new Error('SIMD math engine not initialized');
    }

    // Ensure vector alignment
    const { aligned: alignedA, needsRelease: releaseA } = this.ensureAligned(vecA);
    const { aligned: alignedB, needsRelease: releaseB } = this.ensureAligned(vecB);

    try {
      const result = this.simdMath.cosine_similarity(alignedA, alignedB);
      return result;
    } finally {
      // Release temporary buffers
      if (releaseA) this.releaseAlignedBuffer(alignedA);
      if (releaseB) this.releaseAlignedBuffer(alignedB);
    }
  }

  /**
   * Batch similarity calculation
   */
  async batchSimilarity(vectors: Float32Array[], query: Float32Array): Promise<number[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.simdMath) {
      throw new Error('SIMD math engine not initialized');
    }

    const vectorDim = query.length;
    const numVectors = vectors.length;

    // Pack all vectors into contiguous memory layout
    const packedVectors = this.getAlignedBuffer(numVectors * vectorDim);
    const { aligned: alignedQuery, needsRelease: releaseQuery } = this.ensureAligned(query);

    try {
      // Copy vector data
      let offset = 0;
      for (const vector of vectors) {
        packedVectors.set(vector, offset);
        offset += vectorDim;
      }

      // Batch calculation
      const results = this.simdMath.batch_similarity(packedVectors, alignedQuery, vectorDim);
      return Array.from(results);
    } finally {
      this.releaseAlignedBuffer(packedVectors);
      if (releaseQuery) this.releaseAlignedBuffer(alignedQuery);
    }
  }

  /**
   * Similarity matrix calculation
   */
  async similarityMatrix(vectorsA: Float32Array[], vectorsB: Float32Array[]): Promise<number[][]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.simdMath || vectorsA.length === 0 || vectorsB.length === 0) {
      return [];
    }

    const vectorDim = vectorsA[0].length;
    const numA = vectorsA.length;
    const numB = vectorsB.length;

    // Pack vectors
    const packedA = this.getAlignedBuffer(numA * vectorDim);
    const packedB = this.getAlignedBuffer(numB * vectorDim);

    try {
      // Copy data
      let offsetA = 0;
      for (const vector of vectorsA) {
        packedA.set(vector, offsetA);
        offsetA += vectorDim;
      }

      let offsetB = 0;
      for (const vector of vectorsB) {
        packedB.set(vector, offsetB);
        offsetB += vectorDim;
      }

      // Calculate matrix
      const flatResults = this.simdMath.similarity_matrix(packedA, packedB, vectorDim);

      // Convert to 2D array
      const matrix: number[][] = [];
      for (let i = 0; i < numA; i++) {
        const row: number[] = [];
        for (let j = 0; j < numB; j++) {
          row.push(flatResults[i * numB + j]);
        }
        matrix.push(row);
      }

      return matrix;
    } finally {
      this.releaseAlignedBuffer(packedA);
      this.releaseAlignedBuffer(packedB);
    }
  }

  /**
   * Check SIMD support
   */
  static async checkSIMDSupport(): Promise<boolean> {
    try {
      console.log('SIMDMathEngine: Checking SIMD support...');

      // Get browser information
      const userAgent = navigator.userAgent;
      const browserInfo = SIMDMathEngine.getBrowserInfo();
      console.log('Browser info:', browserInfo);
      console.log('User Agent:', userAgent);

      // Check WebAssembly basic support
      if (typeof WebAssembly !== 'object') {
        console.log('WebAssembly not supported');
        return false;
      }
      console.log('✅ WebAssembly basic support: OK');

      // Check WebAssembly.validate method
      if (typeof WebAssembly.validate !== 'function') {
        console.log('❌ WebAssembly.validate not available');
        return false;
      }
      console.log('✅ WebAssembly.validate: OK');

      // Test basic WebAssembly module validation
      const basicWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const basicValid = WebAssembly.validate(basicWasm);
      console.log('✅ Basic WASM validation:', basicValid);

      // Check WebAssembly SIMD support - using correct SIMD test module
      console.log('Testing SIMD WASM module...');

      // Method 1: Use standard SIMD detection bytecode
      let wasmSIMDSupported = false;
      try {
        // This is a minimal SIMD module containing v128.const instruction
        const simdWasm = new Uint8Array([
          0x00,
          0x61,
          0x73,
          0x6d, // WASM magic
          0x01,
          0x00,
          0x00,
          0x00, // version
          0x01,
          0x05,
          0x01, // type section
          0x60,
          0x00,
          0x01,
          0x7b, // function type: () -> v128
          0x03,
          0x02,
          0x01,
          0x00, // function section
          0x0a,
          0x0a,
          0x01, // code section
          0x08,
          0x00, // function body
          0xfd,
          0x0c, // v128.const
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x0b, // end
        ]);
        wasmSIMDSupported = WebAssembly.validate(simdWasm);
        console.log('Method 1 - Standard SIMD test result:', wasmSIMDSupported);
      } catch (error) {
        console.log('Method 1 failed:', error);
      }

      // Method 2: If method 1 fails, try simpler SIMD instruction
      if (!wasmSIMDSupported) {
        try {
          // Test using i32x4.splat instruction
          const simpleSimdWasm = new Uint8Array([
            0x00,
            0x61,
            0x73,
            0x6d, // WASM magic
            0x01,
            0x00,
            0x00,
            0x00, // version
            0x01,
            0x06,
            0x01, // type section
            0x60,
            0x01,
            0x7f,
            0x01,
            0x7b, // function type: (i32) -> v128
            0x03,
            0x02,
            0x01,
            0x00, // function section
            0x0a,
            0x07,
            0x01, // code section
            0x05,
            0x00, // function body
            0x20,
            0x00, // local.get 0
            0xfd,
            0x0d, // i32x4.splat
            0x0b, // end
          ]);
          wasmSIMDSupported = WebAssembly.validate(simpleSimdWasm);
          console.log('Method 2 - Simple SIMD test result:', wasmSIMDSupported);
        } catch (error) {
          console.log('Method 2 failed:', error);
        }
      }

      // Method 3: If previous methods fail, try detecting specific SIMD features
      if (!wasmSIMDSupported) {
        try {
          // Check if SIMD feature flags are supported
          const featureTest = WebAssembly.validate(
            new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
          );

          if (featureTest) {
            // In Chrome, if basic WebAssembly works and version >= 91, SIMD is usually available
            const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
            if (chromeMatch && parseInt(chromeMatch[1]) >= 91) {
              console.log('Method 3 - Chrome version check: SIMD should be available');
              wasmSIMDSupported = true;
            }
          }
        } catch (error) {
          console.log('Method 3 failed:', error);
        }
      }

      // Output final result
      if (!wasmSIMDSupported) {
        console.log('❌ SIMD not supported. Browser requirements:');
        console.log('- Chrome 91+, Firefox 89+, Safari 16.4+, Edge 91+');
        console.log('Your browser should support SIMD. Possible issues:');
        console.log('1. Extension context limitations');
        console.log('2. Security policies');
        console.log('3. Feature flags disabled');
      } else {
        console.log('✅ SIMD supported!');
      }

      return wasmSIMDSupported;
    } catch (error: any) {
      console.error('SIMD support check failed:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack,
        });
      }
      return false;
    }
  }

  /**
   * Get browser information
   */
  static getBrowserInfo(): { name: string; version: string; supported: boolean } {
    const userAgent = navigator.userAgent;
    let browserName = 'Unknown';
    let version = 'Unknown';
    let supported = false;

    // Chrome
    if (userAgent.includes('Chrome/')) {
      browserName = 'Chrome';
      const match = userAgent.match(/Chrome\/(\d+)/);
      if (match) {
        version = match[1];
        supported = parseInt(version) >= 91;
      }
    }
    // Firefox
    else if (userAgent.includes('Firefox/')) {
      browserName = 'Firefox';
      const match = userAgent.match(/Firefox\/(\d+)/);
      if (match) {
        version = match[1];
        supported = parseInt(version) >= 89;
      }
    }
    // Safari
    else if (userAgent.includes('Safari/') && !userAgent.includes('Chrome/')) {
      browserName = 'Safari';
      const match = userAgent.match(/Version\/(\d+\.\d+)/);
      if (match) {
        version = match[1];
        const versionNum = parseFloat(version);
        supported = versionNum >= 16.4;
      }
    }
    // Edge
    else if (userAgent.includes('Edg/')) {
      browserName = 'Edge';
      const match = userAgent.match(/Edg\/(\d+)/);
      if (match) {
        version = match[1];
        supported = parseInt(version) >= 91;
      }
    }

    return { name: browserName, version, supported };
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      isInitializing: this.isInitializing,
      bufferPoolStats: Array.from(this.alignedBufferPool.entries()).map(([size, buffers]) => ({
        size,
        pooled: buffers.length,
        maxPoolSize: this.maxPoolSize,
      })),
    };
  }

  dispose(): void {
    if (this.simdMath) {
      try {
        this.simdMath.free();
      } catch (error) {
        console.warn('Failed to free SIMD math instance:', error);
      }
      this.simdMath = null;
    }

    this.alignedBufferPool.clear();
    this.wasmModule = null;
    this.isInitialized = false;
    this.isInitializing = false;
    this.initPromise = null;
  }
}
