import { readFile } from 'node:fs/promises';

import { evaluateQualityFixture } from './quality-evaluation.ts';

async function main(): Promise<void> {
  const fixturePath = process.argv[2];
  if (!fixturePath || process.argv.length !== 3) {
    throw new Error('usage: npm run quality:evaluate -- <fixture.json>');
  }
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
  process.stdout.write(`${JSON.stringify(evaluateQualityFixture(fixture), null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'quality evaluation failed'}\n`);
  process.exitCode = 1;
}
