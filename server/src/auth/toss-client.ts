import { readFile } from 'node:fs/promises';
import https from 'node:https';

export interface TossResponse { statusCode: number; body: string; }
export interface TossOptions {
  certPath: string;
  keyPath: string;
  request?: (input: { key: string; cert: Buffer; privateKey: Buffer }) => Promise<TossResponse>;
}

async function realRequest(input: { key: string; cert: Buffer; privateKey: Buffer }): Promise<TossResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => { if (!settled) { settled = true; reject(error); } };
    const succeed = (response: TossResponse): void => { if (!settled) { settled = true; resolve(response); } };
    const request = https.request({ hostname: 'apps-in-toss-api.toss.im', path: '/api-partner/v1/apps-in-toss/users/anon-key/verify', method: 'POST', headers: { 'x-anon-key': input.key }, cert: input.cert, key: input.privateKey, timeout: 5_000 }, (response) => {
      const chunks: Buffer[] = []; let size = 0; let completed = false;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024) request.destroy(new Error('Toss response too large')); else chunks.push(chunk); });
      response.once('error', (error: Error) => fail(error));
      response.once('aborted', () => fail(new Error('Toss response aborted')));
      response.once('close', () => { if (!completed) fail(new Error('Toss response closed before completion')); });
      response.once('end', () => { completed = true; succeed({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    request.on('timeout', () => request.destroy(new Error('Toss verification timed out')));
    request.on('error', (error: Error) => fail(error)); request.end();
  });
}

export async function verifyTossAnonymousKey(key: string, options: TossOptions): Promise<boolean> {
  const response = options.request
    ? await options.request({ key, cert: Buffer.alloc(0), privateKey: Buffer.alloc(0) })
    : await realRequest({ key, cert: await readFile(options.certPath), privateKey: await readFile(options.keyPath) });
  if (response.statusCode !== 200) throw new Error('Toss verification returned a non-200 response');
  try {
    const payload: unknown = JSON.parse(response.body);
    if (!payload || typeof payload !== 'object') throw new Error('Toss verification returned malformed JSON');
    const result = payload as Record<string, unknown>;
    if (result.resultType !== 'SUCCESS') throw new Error('Toss verification did not return SUCCESS');
    if (result.success === true || result.success === 'true') return true;
    if (result.success === false || result.success === 'false') return false;
    throw new Error('Toss verification returned an unexpected success value');
  } catch (error) { if (error instanceof SyntaxError) throw new Error('Toss verification returned malformed JSON'); throw error; }
}
