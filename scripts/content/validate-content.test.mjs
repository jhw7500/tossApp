import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const CLI_PATH = 'scripts/content/validate-content.mjs';
const VALID_FIXTURE = 'content/fixtures/synthetic-test.csv';
const INVALID_FIXTURE = 'content/fixtures/invalid-missing-active.csv';

function runCli(...args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
}

test('a valid fixture exits zero, reports limits, and leaves input unchanged', async () => {
  const before = await readFile(VALID_FIXTURE);
  const run = runCli(VALID_FIXTURE);
  const after = await readFile(VALID_FIXTURE);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /검증 통과/);
  assert.match(run.stdout, /카드 3개/);
  assert.match(run.stdout, /64 KiB/);
  assert.match(run.stdout, /전체 context 성공을 보장하지 않습니다/);
  assert.match(run.stdout, /DB를 변경하지 않았습니다/);
  assert.deepEqual(after, before);
});

test('an invalid fixture exits one with its source location', () => {
  const run = runCli(INVALID_FIXTURE);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /invalid-missing-active\.csv:2:is_active_version/);
  assert.match(run.stderr, /활성 버전이 정확히 하나/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

test('missing arguments return a bounded usage error', () => {
  const run = runCli();

  assert.equal(run.status, 1);
  assert.equal(run.stderr, '사용법: node scripts/content/validate-content.mjs <csv-file>\n');
});

test('invalid UTF-8 is rejected without a stack trace', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tarororo-content-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'invalid-utf8.csv');
  await writeFile(path, Buffer.from([0xc3, 0x28]));

  const run = runCli(path);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /UTF-8/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

test('a missing file reports the requested path without a stack trace', () => {
  const path = 'content/fixtures/does-not-exist.csv';
  const run = runCli(path);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /does-not-exist\.csv/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

test('a multiline card code is rejected before it can forge summary output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tarororo-content-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'multiline-card.csv');
  await writeFile(path, [
    'card_code,interpretation_id,locale,version,is_active_version,source_kind,source_attribution,content',
    '"the-fool',
    'forged-line",00000000-0000-4000-8000-000000000001,ko-KR,1,true,synthetic_test,test,text',
  ].join('\n'));

  const run = runCli(path);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /card_code: 카드 코드는 제어 문자를 포함할 수 없습니다/);
  assert.doesNotMatch(run.stdout, /forged-line/);
});
