import { classify } from './classifier.js';
import type {
  NoulQuestion, ChoiceQuestion, ScoreQuestion,
  NoulAnswer, ChoiceAnswer, ScoreAnswer
} from '../types.js';

/**
 * Noul: binary probability estimation.
 * We frame the question as a single NLI hypothesis and take the entailment score.
 */
export async function evaluateNoul(
  context: string,
  question: NoulQuestion
): Promise<NoulAnswer> {
  const result = await classify(context, [question.instructions, 'This is not relevant.']);
  // First label score = entailment probability for the positive hypothesis
  const noul = result.scores[0];
  return { type: 'noul', noul };
}

/**
 * Choice: multi-class classification across criteria values.
 * Returns the winning key, its confidence, and full probability map.
 */
export async function evaluateChoice(
  context: string,
  question: ChoiceQuestion
): Promise<ChoiceAnswer> {
  const keys = Object.keys(question.criteria);
  const labels = keys.map(k => question.criteria[k]);

  const result = await classify(context, labels);

  // result.labels is sorted desc by score — map back to keys
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < result.labels.length; i++) {
    const labelIndex = labels.indexOf(result.labels[i]);
    probabilities[keys[labelIndex]] = result.scores[i];
  }

  const winningLabel = result.labels[0];
  const winningIndex = labels.indexOf(winningLabel);
  const winningKey = keys[winningIndex];
  const confidence = result.scores[0];

  return { type: 'choice', choice: winningKey, confidence, probabilities };
}

/**
 * Score: weighted average across ordered levels.
 * Levels are indexed "0", "1", "2", ... and we compute Σ(index × probability).
 */
export async function evaluateScore(
  context: string,
  question: ScoreQuestion
): Promise<ScoreAnswer> {
  const sortedKeys = Object.keys(question.levels).sort((a, b) => Number(a) - Number(b));
  const labels = sortedKeys.map(k => question.levels[k]);

  const result = await classify(context, labels);

  // Build an ordered probability array matching sortedKeys order
  const probs = sortedKeys.map(k => {
    const label = question.levels[k];
    const pos = result.labels.indexOf(label);
    return pos >= 0 ? result.scores[pos] : 0;
  });

  // Softmax normalization (already normalized by transformers, but be safe)
  const sum = probs.reduce((a, b) => a + b, 0);
  const normalized = probs.map(p => (sum > 0 ? p / sum : 1 / probs.length));

  // Weighted average: Σ(level_index × probability)
  const score = sortedKeys.reduce((acc, k, i) => acc + Number(k) * normalized[i], 0);
  const confidence = Math.max(...normalized);

  return { type: 'score', score, confidence };
}
