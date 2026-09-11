import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadingContext, ReadingResult } from '../src/readings/types.ts';
import { buildPrompt } from '../src/ai/prompt.ts';
import { validateReadingResult } from '../src/ai/validate.ts';
import { GeminiProvider } from '../src/ai/gemini.ts';
import { AiProviderError } from '../src/ai/types.ts';
import { readAiConfig } from '../src/ai/config.ts';

const ids = {
  cards: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'],
  evidence: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
  question: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
} as const;

const context: ReadingContext = {
  relationshipCode: 'crush', currentSituation: '대화가 줄었어요',
  question: { id: ids.question, version: 2, text: '관계의 흐름은?', isCustom: false },
  cards: ids.cards.map((cardId, index) => ({
    cardId, code: `card-${index + 1}`, name: `카드 ${index + 1}`, arcana: 'major', imageUrl: null,
    positionIndex: index + 1, label: `위치 ${index + 1}`, description: null,
    candidates: [{ interpretationId: ids.evidence[index], version: index + 1, text: `근거 원문 ${index + 1}`, sourceKind: 'synthetic_test', sourceAttribution: 'test' }],
  })),
};

function validResult(): ReadingResult {
  return {
    cards: context.cards.map(card => ({ positionIndex: card.positionIndex, cardId: card.cardId, text: `${card.positionIndex}번 해석`, evidence: [{ interpretationId: card.candidates[0].interpretationId, version: card.candidates[0].version }] })),
    overallReading: '세 장의 흐름을 함께 살펴보세요.', summary: '천천히 관계의 흐름을 확인하세요.',
  };
}

test('validator accepts an exact grounded three-card result', () => {
  assert.deepEqual(validateReadingResult(validResult(), context, 'reading-result.v1'), validResult());
});

for (const [name, mutate] of [
  ['evidence from another card', (result: ReadingResult) => { result.cards[0].evidence[0] = result.cards[1].evidence[0]; }],
  ['an unavailable evidence version', (result: ReadingResult) => { result.cards[0].evidence[0].version = 99; }],
  ['a duplicate position', (result: ReadingResult) => { result.cards[1].positionIndex = 1; }],
  ['text beyond 800 Unicode code points', (result: ReadingResult) => { result.cards[0].text = '가'.repeat(801); }],
  ['whitespace-only text', (result: ReadingResult) => { result.cards[0].text = '   '; }],
] as const) test(`validator rejects ${name}`, () => {
  const result = validResult(); mutate(result);
  assert.throws(() => validateReadingResult(result, context, 'reading-result.v1'), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_OUTPUT_INVALID' && error.retryable);
});

test('validator rejects unknown fields and unknown contract versions', () => {
  assert.throws(() => validateReadingResult({ ...validResult(), provider: 'gemini' }, context, 'reading-result.v1'), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_OUTPUT_INVALID' && error.retryable);
  assert.throws(() => validateReadingResult(validResult(), context, 'reading-result.v2'), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_CONFIG_INVALID' && !error.retryable);
});

test('prompt keeps instructions separate from JSON context and rejects unknown versions', () => {
  const prompt = buildPrompt(context, 'tarot-grounded.v1');
  assert.match(prompt.systemInstruction, /후보 원문/);
  assert.deepEqual(JSON.parse(prompt.userJson), context);
  assert.equal(prompt.userJson.includes('nickname'), false);
  assert.throws(() => buildPrompt(context, 'tarot-grounded.v2'), /unsupported prompt version/i);
});

test('AI config defaults to the verified model and requires a worker-side key', () => {
  assert.deepEqual(readAiConfig({ GEMINI_API_KEY: 'secret' }), { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: 'secret' });
  assert.throws(() => readAiConfig({ AI_PROVIDER: 'fixture', GEMINI_API_KEY: 'secret' }), /AI_PROVIDER/);
  assert.throws(() => readAiConfig({}), /GEMINI_API_KEY/);
});

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

test('Gemini adapter sends the verified Generate Content envelope and accepts STOP JSON', async () => {
  let request: Request | undefined;
  const provider = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', fetch: async (input, init) => {
    request = new Request(input, init);
    return response({ candidates: [{ content: { parts: [{ text: JSON.stringify(validResult()) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  }});
  const generated = await provider.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' });
  assert.equal(provider.aiGenerated, true);
  assert.deepEqual(generated, { result: validResult(), usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
  assert.equal(request?.redirect, 'error');
  assert.match(request?.url ?? '', /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.1-flash-lite:generateContent$/);
  const payload = JSON.parse(await request!.text());
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.equal(payload.generationConfig.maxOutputTokens, 4096);
  assert.deepEqual(JSON.parse(payload.contents[0].parts[0].text), context);
  assert.equal(JSON.stringify(payload).includes('secret'), false);
});

for (const [name, body] of [
  ['empty', { candidates: [] }],
  ['malformed JSON', { candidates: [{ content: { parts: [{ text: '{' }] }, finishReason: 'STOP' }] }],
  ['truncated output', { candidates: [{ content: { parts: [{ text: JSON.stringify(validResult()) }] }, finishReason: 'MAX_TOKENS' }] }],
  ['malformed parts shape', { candidates: [{ content: { parts: {} }, finishReason: 'STOP' }] }],
] as const) test(`Gemini adapter rejects ${name} output`, async () => {
  const provider = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', fetch: async () => response(body) });
  await assert.rejects(provider.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_OUTPUT_INVALID' && error.retryable);
});

test('Gemini adapter keeps explicit policy refusals nonretryable', async () => {
  const provider = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', fetch: async () => response({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }) });
  await assert.rejects(provider.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_REFUSED' && !error.retryable);
});

test('Gemini adapter keeps candidate policy stops nonretryable', async () => {
  const provider = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', fetch: async () => response({ candidates: [{ finishReason: 'SAFETY' }] }) });
  await assert.rejects(provider.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_REFUSED' && !error.retryable);
});

test('Gemini adapter rejects unsupported versions without invoking the provider', async () => {
  let calls = 0;
  const provider = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', fetch: async () => { calls += 1; return response({}); } });
  await assert.rejects(provider.generate({ context, promptVersion: 'tarot-grounded.v2', contractVersion: 'reading-result.v1' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_CONFIG_INVALID' && !error.retryable);
  await assert.rejects(provider.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v2' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_CONFIG_INVALID' && !error.retryable);
  assert.equal(calls, 0);
});

test('Gemini adapter cancels early-rejected HTTP and declared-oversize bodies', async () => {
  const fixtures: ResponseInit[] = [{ status: 503 }, { status: 200, headers: { 'content-length': '999' } }];
  for (const fixture of fixtures) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const provider = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', maxResponseBytes: 32, fetch: async () => new Response(body, fixture) });
    await assert.rejects(provider.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' }), AiProviderError);
    assert.equal(cancelled, true);
  }
});

test('Gemini adapter maps rate limits as retryable without exposing the body', async () => {
  const provider = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', fetch: async () => new Response('private provider detail', { status: 429 }) });
  await assert.rejects(provider.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_RATE_LIMITED' && error.retryable && !error.message.includes('private'));
});

test('Gemini adapter maps an asynchronous response-body transport failure safely', async () => {
  const brokenBody = new ReadableStream({ pull() { throw new Error('private socket detail'); } });
  const provider = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', fetch: async () => new Response(brokenBody, { status: 200 }) });
  await assert.rejects(provider.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_UNAVAILABLE' && error.retryable && !error.message.includes('private'));
});

test('Gemini adapter aborts a hanging transport and rejects oversized responses', async () => {
  const hanging = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', timeoutMs: 5, fetch: async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })) });
  await assert.rejects(hanging.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_TIMEOUT' && error.retryable);
  const oversized = new GeminiProvider({ apiKey: 'secret', model: 'gemini-3.1-flash-lite', maxResponseBytes: 32, fetch: async () => response({ padding: 'x'.repeat(100) }) });
  await assert.rejects(oversized.generate({ context, promptVersion: 'tarot-grounded.v1', contractVersion: 'reading-result.v1' }), (error: unknown) => error instanceof AiProviderError && error.code === 'AI_OUTPUT_INVALID' && error.retryable);
});
