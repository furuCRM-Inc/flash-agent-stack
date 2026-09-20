// Jev-compatible question definitions

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  levels: Record<string, string>; // "0" → description, "1" → description, ...
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface SystemOneRequest {
  model: string;
  state: string; // JSON-stringified context
  questions: Record<string, Question>;
}

// Jev-compatible answer types

export interface NoulAnswer {
  type: 'noul';
  noul: number; // 0.0–1.0
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string; // winning key
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: {
    input_tokens: number;
    output_tokens: 0; // always 0 — no text generated
  };
}

// OpenAI-compatible chat completions (for broad agent integration)

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: 'stop';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
