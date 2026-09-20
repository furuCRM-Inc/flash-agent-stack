import { pipeline, type ZeroShotClassificationOutput } from '@huggingface/transformers';

// Singleton — model loads once, all requests share it
let _classifier: Awaited<ReturnType<typeof pipeline>> | null = null;

const MODEL = 'Xenova/nli-deberta-v3-small';

export async function getClassifier() {
  if (!_classifier) {
    console.log(`[FlashAgent] Loading NLI model: ${MODEL} …`);
    _classifier = await pipeline('zero-shot-classification', MODEL, {
      // Cache to ~/.cache/huggingface (or TRANSFORMERS_CACHE env)
      cache_dir: process.env.MODEL_CACHE_DIR,
    });
    console.log('[FlashAgent] Model ready.');
  }
  return _classifier;
}

/**
 * Classify `text` against `labels` using zero-shot NLI.
 * Returns labels sorted descending by score (highest confidence first).
 */
export async function classify(
  text: string,
  labels: string[],
  hypothesisTemplate = 'This example is {}.'
): Promise<ZeroShotClassificationOutput> {
  const clf = await getClassifier();
  const result = await clf(text, labels, { hypothesis_template: hypothesisTemplate });
  // Transformers.js returns array for batched, single object for single input
  return Array.isArray(result) ? result[0] : result as ZeroShotClassificationOutput;
}
