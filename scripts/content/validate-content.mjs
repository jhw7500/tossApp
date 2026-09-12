import { readFile } from 'node:fs/promises';

import {
  CONTEXT_LIMIT_NOTE,
  validateContentCsv,
} from './validate.mjs';

const [inputPath, extraArgument] = process.argv.slice(2);

if (!inputPath || extraArgument) {
  console.error('사용법: node scripts/content/validate-content.mjs <csv-file>');
  process.exitCode = 1;
} else {
  await validateFile(inputPath);
}

async function validateFile(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const reason = typeof error?.code === 'string' ? error.code : 'READ_ERROR';
    console.error(`${path}: 파일을 읽을 수 없습니다 (${reason}).`);
    process.exitCode = 1;
    return;
  }

  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    console.error(`${path}: 유효한 UTF-8 CSV 파일이 아닙니다.`);
    process.exitCode = 1;
    return;
  }

  const result = validateContentCsv(source);
  for (const warning of result.warnings) {
    console.log(`${path}:${warning.line}:${warning.column}: 경고: ${warning.message}`);
  }

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`${path}:${error.line}:${error.column}: ${error.message}`);
    }
    console.error(`검증 실패: 오류 ${result.errors.length}개를 수정한 뒤 다시 실행하세요.`);
    process.exitCode = 1;
    return;
  }

  const summary = result.summary;
  console.log(
    `검증 통과: 행 ${summary.rowCount}개, 카드 ${summary.cardCount}개, `
    + `원문 ${summary.interpretationCount}개, 활성 버전 ${summary.activeVersionCount}개.`,
  );
  console.log('카드/locale별 활성 후보:');
  for (const card of summary.cards) {
    console.log(
      `- ${card.cardCode} / ${card.locale}: ${card.candidateCount}개, ${card.candidateBytes} bytes`,
    );
  }
  console.log(
    `가장 큰 ko-KR 카드 3장의 후보 합계: ${summary.largestThreeKoKrCandidateBytes} bytes; `
    + `64 KiB 한도까지 최소 ${summary.remainingContextBytes} bytes 남음.`,
  );
  console.log(CONTEXT_LIMIT_NOTE);
  console.log(`dry-run 완료: ${path}와 DB를 변경하지 않았습니다.`);
}
