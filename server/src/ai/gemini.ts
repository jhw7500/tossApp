import { readingResultSchema } from '../../../contracts/reading.schemas.ts';
import { buildPrompt } from './prompt.ts';
import { AiProviderError, type GenerateReadingInput, type GeneratedReading, type ReadingProvider } from './types.ts';
import { validateReadingResult } from './validate.ts';

type Fetch = typeof fetch;
interface GeminiOptions { apiKey: string; model: string; fetch?: Fetch; timeoutMs?: number; maxResponseBytes?: number; }
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const POLICY_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);
const invalidOutput = () => new AiProviderError('AI_OUTPUT_INVALID', true);

function safeUsage(value: unknown): GeneratedReading['usage'] {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const take = (name: string) => typeof source[name] === 'number' && Number.isSafeInteger(source[name]) && (source[name] as number) >= 0 ? source[name] as number : undefined;
  const usage = { inputTokens: take('promptTokenCount'), outputTokens: take('candidatesTokenCount'), totalTokens: take('totalTokenCount') };
  return Object.values(usage).some(item => item !== undefined) ? usage : null;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      void reader.cancel().catch(() => undefined);
      throw invalidOutput();
    }
    chunks.push(value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function discardResponse(response: Response, controller: AbortController): void {
  controller.abort();
  void response.body?.cancel().catch(() => undefined);
}

export class GeminiProvider implements ReadingProvider {
  readonly name = 'gemini';
  readonly aiGenerated = true;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: Fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GeminiOptions) {
    if (!options.apiKey) throw new AiProviderError('AI_CONFIG_INVALID', false, 'Gemini API key is required');
    if (!/^[a-zA-Z0-9._-]+$/.test(options.model)) throw new AiProviderError('AI_CONFIG_INVALID', false, 'Gemini model is invalid');
    this.apiKey = options.apiKey; this.model = options.model; this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000; this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
  }

  async generate(input: GenerateReadingInput): Promise<GeneratedReading> {
    const transportController = new AbortController();
    const timer = setTimeout(() => transportController.abort(), this.timeoutMs);
    try { return await this.generateWithinDeadline(input, transportController); }
    finally { clearTimeout(timer); }
  }

  private async generateWithinDeadline(input: GenerateReadingInput, transportController: AbortController): Promise<GeneratedReading> {
    const prompt = buildPrompt(input.context, input.promptVersion);
    if (input.contractVersion !== 'reading-result.v1') throw new AiProviderError('AI_CONFIG_INVALID', false, 'unsupported contract version');
    const signal = input.signal ? AbortSignal.any([input.signal, transportController.signal]) : transportController.signal;
    let response: Response;
    try {
      response = await this.fetchFn(`${ENDPOINT}${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt.systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: prompt.userJson }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: readingResultSchema, maxOutputTokens: 4096 },
        }),
      });
    } catch (cause) {
      if (transportController.signal.aborted) throw new AiProviderError('AI_TIMEOUT', true, 'AI provider timed out', { cause });
      if (input.signal?.aborted) throw new AiProviderError('AI_CANCELLED', true, 'AI provider request was cancelled', { cause });
      throw new AiProviderError('AI_UNAVAILABLE', true, 'AI provider request failed', { cause });
    }
    if (!response.ok) {
      discardResponse(response, transportController);
      if (response.status === 429) throw new AiProviderError('AI_RATE_LIMITED', true);
      if (response.status >= 500) throw new AiProviderError('AI_UNAVAILABLE', true);
      throw new AiProviderError(response.status === 401 || response.status === 403 ? 'AI_AUTH_INVALID' : 'AI_REQUEST_REJECTED', false);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      discardResponse(response, transportController);
      throw invalidOutput();
    }
    let bytes: Uint8Array;
    try { bytes = await readBounded(response, this.maxResponseBytes); }
    catch (cause) {
      if (cause instanceof AiProviderError) {
        transportController.abort();
        throw cause;
      }
      if (transportController.signal.aborted) throw new AiProviderError('AI_TIMEOUT', true, 'AI provider timed out', { cause });
      if (input.signal?.aborted) throw new AiProviderError('AI_CANCELLED', true, 'AI provider request was cancelled', { cause });
      throw new AiProviderError('AI_UNAVAILABLE', true, 'AI provider response failed', { cause });
    }
    let envelope: any;
    try { envelope = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalidOutput(); }
    const candidate = Array.isArray(envelope?.candidates) ? envelope.candidates[0] : undefined;
    if (envelope?.promptFeedback?.blockReason || POLICY_FINISH_REASONS.has(candidate?.finishReason)) {
      throw new AiProviderError('AI_REFUSED', false);
    }
    const parts = candidate?.content?.parts;
    if (candidate?.finishReason !== 'STOP' || !Array.isArray(parts) || !parts.length
      || parts.some((part: unknown) => !part || typeof part !== 'object' || typeof (part as { text?: unknown }).text !== 'string')) {
      throw invalidOutput();
    }
    const text = parts.map((part: { text: string }) => part.text).join('');
    if (!text) throw invalidOutput();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw invalidOutput(); }
    return { result: validateReadingResult(raw, input.context, input.contractVersion), usage: safeUsage(envelope.usageMetadata) };
  }
}
