/**
 * Flash Agent Web Worker
 * Runs inside the browser — zero server infrastructure.
 * Loads Transformers.js from CDN, runs NLI zero-shot classification locally.
 *
 * CSP requirements (add in Salesforce Site → Security Settings):
 *   script-src  cdn.jsdelivr.net
 *   connect-src cdn-lfs.huggingface.co huggingface.co
 */

/* global Transformers */

let clf = null;
let ready = false;

self.addEventListener('message', async (event) => {
  const { type, id, payload } = event.data;

  if (type === 'INIT') {
    try {
      // Load Transformers.js v2 UMD bundle via importScripts
      importScripts('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');

      // UMD exposes the library on the global scope in worker context
      const { pipeline, env } = self.Transformers || Transformers;

      // Prefer WASM backend; disable remote model fetching for security
      env.allowLocalModels = false;
      env.allowRemoteModels = true;

      self.postMessage({ type: 'LOADING', id, message: 'Downloading NLI model (~40MB)…' });

      clf = await pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-small', {
        progress_callback: (info) => {
          if (info.status === 'progress') {
            self.postMessage({
              type: 'PROGRESS',
              id,
              progress: Math.round(info.progress),
              file: info.file,
            });
          }
        },
      });

      ready = true;
      self.postMessage({ type: 'READY', id });
    } catch (err) {
      self.postMessage({ type: 'ERROR', id, error: String(err) });
    }
  }

  if (type === 'CLASSIFY') {
    if (!ready || !clf) {
      self.postMessage({ type: 'ERROR', id, error: 'Classifier not initialized' });
      return;
    }
    try {
      const { text, labels } = payload;
      const t0 = performance.now();
      const result = await clf(text, labels);
      const latency = Math.round(performance.now() - t0);
      self.postMessage({ type: 'RESULT', id, result, latency });
    } catch (err) {
      self.postMessage({ type: 'ERROR', id, error: String(err) });
    }
  }
});
