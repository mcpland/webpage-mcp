/* eslint-disable */
// js/similarity.worker.js
importScripts('../libs/ort.min.js'); // Adjust the path to match your file structure

// Global Worker status
let session = null;
let modelPathInternal = null;
let ortEnvConfigured = false;
let sessionOptions = null;
let modelInputNames = null; // Store the input name of the model

// Reused TypedArray buffer to reduce memory allocation
let reusableBuffers = {
  inputIds: null,
  attentionMask: null,
  tokenTypeIds: null,
};

// Performance Statistics
let workerStats = {
  totalInferences: 0,
  totalInferenceTime: 0,
  averageInferenceTime: 0,
  memoryAllocations: 0,
};

// Configure the ONNX Runtime environment (once only)
function configureOrtEnv(numThreads = 1, executionProviders = ['wasm']) {
  if (ortEnvConfigured) return;
  try {
    ort.env.wasm.numThreads = numThreads;
    ort.env.wasm.simd = true; // Enable SIMD where possible
    ort.env.wasm.proxy = false; // In a Worker, no proxy is usually needed
    ort.env.logLevel = 'warning'; // 'verbose', 'info', 'warning', 'error', 'fatal'
    ortEnvConfigured = true;

    sessionOptions = {
      executionProviders: executionProviders,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
      // executionMode: 'sequential' // Within a worker, a task is usually executed sequentially
    };
  } catch (error) {
    console.error('Worker: Failed to configure ORT environment', error);
    throw error; // Throw an error and let the main thread know
  }
}

async function initializeModel(modelPathOrData, numThreads, executionProviders) {
  try {
    configureOrtEnv(numThreads, executionProviders); // Make sure the environment is configured

    if (!modelPathOrData) {
      throw new Error('Worker: Model path or data is not provided.');
    }

    // Check if input is ArrayBuffer (cached model data) or string (URL path)
    if (modelPathOrData instanceof ArrayBuffer) {
      console.log(
        `Worker: Initializing model from cached ArrayBuffer (${modelPathOrData.byteLength} bytes)`,
      );
      session = await ort.InferenceSession.create(modelPathOrData, sessionOptions);
      modelPathInternal = '[Cached ArrayBuffer]'; // For debugging purposes
    } else {
      console.log(`Worker: Initializing model from URL: ${modelPathOrData}`);
      modelPathInternal = modelPathOrData; // Store model paths for debugging or reloading if needed
      session = await ort.InferenceSession.create(modelPathInternal, sessionOptions);
    }

    // Get the input name of the model, used to determine whether token_type_ids is needed
    modelInputNames = session.inputNames;
    console.log(`Worker: ONNX session created successfully for model: ${modelPathInternal}`);
    console.log(`Worker: Model input names:`, modelInputNames);

    return { status: 'success', message: 'Model initialized' };
  } catch (error) {
    console.error(`Worker: Model initialization failed:`, error);
    session = null; // Clean up session in case of partial initialization
    modelInputNames = null;
    // Serialize the error message because the Error object itself may not be able to postMessage directly
    throw new Error(`Worker: Model initialization failed - ${error.message}`);
  }
}

// Optimized buffer management functions
function getOrCreateBuffer(name, requiredLength, type = BigInt64Array) {
  if (!reusableBuffers[name] || reusableBuffers[name].length < requiredLength) {
    reusableBuffers[name] = new type(requiredLength);
    workerStats.memoryAllocations++;
  }
  return reusableBuffers[name];
}

// Optimized batch inference functions
async function runBatchInference(batchData) {
  if (!session) {
    throw new Error("Worker: Session not initialized. Call 'initializeModel' first.");
  }

  const startTime = performance.now();

  try {
    const feeds = {};
    const batchSize = batchData.dims.input_ids[0];
    const seqLength = batchData.dims.input_ids[1];

    // Optimization: reuse buffers and reduce memory allocation
    const inputIdsLength = batchData.input_ids.length;
    const attentionMaskLength = batchData.attention_mask.length;

    // Reuse or create a BigInt64Array buffer
    const inputIdsBuffer = getOrCreateBuffer('inputIds', inputIdsLength);
    const attentionMaskBuffer = getOrCreateBuffer('attentionMask', attentionMaskLength);

    // Fill data in batches (avoid map operations)
    for (let i = 0; i < inputIdsLength; i++) {
      inputIdsBuffer[i] = BigInt(batchData.input_ids[i]);
    }
    for (let i = 0; i < attentionMaskLength; i++) {
      attentionMaskBuffer[i] = BigInt(batchData.attention_mask[i]);
    }

    feeds['input_ids'] = new ort.Tensor(
      'int64',
      inputIdsBuffer.slice(0, inputIdsLength),
      batchData.dims.input_ids,
    );
    feeds['attention_mask'] = new ort.Tensor(
      'int64',
      attentionMaskBuffer.slice(0, attentionMaskLength),
      batchData.dims.attention_mask,
    );

    // Handle token_type_ids - only provided if required by the model
    if (modelInputNames && modelInputNames.includes('token_type_ids')) {
      if (batchData.token_type_ids && batchData.dims.token_type_ids) {
        const tokenTypeIdsLength = batchData.token_type_ids.length;
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', tokenTypeIdsLength);

        for (let i = 0; i < tokenTypeIdsLength; i++) {
          tokenTypeIdsBuffer[i] = BigInt(batchData.token_type_ids[i]);
        }

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, tokenTypeIdsLength),
          batchData.dims.token_type_ids,
        );
      } else {
        // Create default all-zero token_type_ids
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', inputIdsLength);
        tokenTypeIdsBuffer.fill(0n, 0, inputIdsLength);

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, inputIdsLength),
          batchData.dims.input_ids,
        );
      }
    } else {
      console.log('Worker: Skipping token_type_ids as model does not require it');
    }

    // Perform batch inference
    const results = await session.run(feeds);
    const outputTensor = results.last_hidden_state || results[Object.keys(results)[0]];

    // Optimize data transfer using Transferable Objects
    const outputData = new Float32Array(outputTensor.data);

    // Update statistics
    workerStats.totalInferences += batchSize; // Batch computing multiple inferences
    const inferenceTime = performance.now() - startTime;
    workerStats.totalInferenceTime += inferenceTime;
    workerStats.averageInferenceTime = workerStats.totalInferenceTime / workerStats.totalInferences;

    return {
      status: 'success',
      output: {
        data: outputData,
        dims: outputTensor.dims,
        batchSize: batchSize,
        seqLength: seqLength,
      },
      transferList: [outputData.buffer],
      stats: {
        inferenceTime,
        totalInferences: workerStats.totalInferences,
        averageInferenceTime: workerStats.averageInferenceTime,
        memoryAllocations: workerStats.memoryAllocations,
        batchSize: batchSize,
      },
    };
  } catch (error) {
    console.error('Worker: Batch inference failed:', error);
    throw new Error(`Worker: Batch inference failed - ${error.message}`);
  }
}

async function runInference(inputData) {
  if (!session) {
    throw new Error("Worker: Session not initialized. Call 'initializeModel' first.");
  }

  const startTime = performance.now();

  try {
    const feeds = {};

    // Optimization: reuse buffers and reduce memory allocation
    const inputIdsLength = inputData.input_ids.length;
    const attentionMaskLength = inputData.attention_mask.length;

    // Reuse or create a BigInt64Array buffer
    const inputIdsBuffer = getOrCreateBuffer('inputIds', inputIdsLength);
    const attentionMaskBuffer = getOrCreateBuffer('attentionMask', attentionMaskLength);

    // Populate data (avoid map operations)
    for (let i = 0; i < inputIdsLength; i++) {
      inputIdsBuffer[i] = BigInt(inputData.input_ids[i]);
    }
    for (let i = 0; i < attentionMaskLength; i++) {
      attentionMaskBuffer[i] = BigInt(inputData.attention_mask[i]);
    }

    feeds['input_ids'] = new ort.Tensor(
      'int64',
      inputIdsBuffer.slice(0, inputIdsLength),
      inputData.dims.input_ids,
    );
    feeds['attention_mask'] = new ort.Tensor(
      'int64',
      attentionMaskBuffer.slice(0, attentionMaskLength),
      inputData.dims.attention_mask,
    );

    // Handle token_type_ids - only provided if required by the model
    if (modelInputNames && modelInputNames.includes('token_type_ids')) {
      if (inputData.token_type_ids && inputData.dims.token_type_ids) {
        const tokenTypeIdsLength = inputData.token_type_ids.length;
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', tokenTypeIdsLength);

        for (let i = 0; i < tokenTypeIdsLength; i++) {
          tokenTypeIdsBuffer[i] = BigInt(inputData.token_type_ids[i]);
        }

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, tokenTypeIdsLength),
          inputData.dims.token_type_ids,
        );
      } else {
        // Create default all-zero token_type_ids
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', inputIdsLength);
        tokenTypeIdsBuffer.fill(0n, 0, inputIdsLength);

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, inputIdsLength),
          inputData.dims.input_ids,
        );
      }
    } else {
      console.log('Worker: Skipping token_type_ids as model does not require it');
    }

    const results = await session.run(feeds);
    const outputTensor = results.last_hidden_state || results[Object.keys(results)[0]];

    // Optimize data transfer using Transferable Objects
    const outputData = new Float32Array(outputTensor.data);

    // Update statistics
    workerStats.totalInferences++;
    const inferenceTime = performance.now() - startTime;
    workerStats.totalInferenceTime += inferenceTime;
    workerStats.averageInferenceTime = workerStats.totalInferenceTime / workerStats.totalInferences;

    return {
      status: 'success',
      output: {
        data: outputData, // Return Float32Array directly
        dims: outputTensor.dims,
      },
      transferList: [outputData.buffer], // Mark as transferable
      stats: {
        inferenceTime,
        totalInferences: workerStats.totalInferences,
        averageInferenceTime: workerStats.averageInferenceTime,
        memoryAllocations: workerStats.memoryAllocations,
      },
    };
  } catch (error) {
    console.error('Worker: Inference failed:', error);
    throw new Error(`Worker: Inference failed - ${error.message}`);
  }
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;

  try {
    switch (type) {
      case 'init':
        // Support both modelPath (URL string) and modelData (ArrayBuffer)
        const modelInput = payload.modelData || payload.modelPath;
        await initializeModel(modelInput, payload.numThreads, payload.executionProviders);
        self.postMessage({ id, type: 'init_complete', status: 'success' });
        break;
      case 'infer':
        const result = await runInference(payload);
        // Optimize data transfer using Transferable Objects
        self.postMessage(
          {
            id,
            type: 'infer_complete',
            status: 'success',
            payload: result.output,
            stats: result.stats,
          },
          result.transferList || [],
        );
        break;
      case 'batchInfer':
        const batchResult = await runBatchInference(payload);
        // Optimize data transfer using Transferable Objects
        self.postMessage(
          {
            id,
            type: 'batchInfer_complete',
            status: 'success',
            payload: batchResult.output,
            stats: batchResult.stats,
          },
          batchResult.transferList || [],
        );
        break;
      case 'getStats':
        self.postMessage({
          id,
          type: 'stats_complete',
          status: 'success',
          payload: workerStats,
        });
        break;
      case 'clearBuffers':
        // Clean the buffer and release memory
        reusableBuffers = {
          inputIds: null,
          attentionMask: null,
          tokenTypeIds: null,
        };
        workerStats.memoryAllocations = 0;
        self.postMessage({
          id,
          type: 'clear_complete',
          status: 'success',
          payload: { message: 'Buffers cleared' },
        });
        break;
      default:
        console.warn(`Worker: Unknown message type: ${type}`);
        self.postMessage({
          id,
          type: 'error',
          status: 'error',
          payload: { message: `Unknown message type: ${type}` },
        });
    }
  } catch (error) {
    // Make sure to send the error as a normal object, as the Error object itself may not serialize correctly
    self.postMessage({
      id,
      type: `${type}_error`, // Such as 'init_error' or 'infer_error'
      status: 'error',
      payload: {
        message: error.message,
        stack: error.stack, // Optional, for debugging
        name: error.name,
      },
    });
  }
};
