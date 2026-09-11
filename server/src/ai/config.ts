export interface AiConfig { provider: 'gemini'; model: string; apiKey: string; }
type Environment = Record<string, string | undefined>;

export function readAiConfig(env: Environment = process.env): AiConfig {
  const provider = env.AI_PROVIDER ?? 'gemini';
  if (provider !== 'gemini') throw new Error('AI_PROVIDER must be gemini');
  const model = env.AI_MODEL ?? 'gemini-3.1-flash-lite';
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('AI_MODEL is invalid');
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  return { provider, model, apiKey };
}
