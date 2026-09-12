import assert from 'node:assert/strict';
import test from 'node:test';

import { CsvSyntaxError, parseCsv } from './csv.mjs';

test('BOM, CRLF, commas, escaped quotes, and quoted newlines are preserved', () => {
  const rows = parseCsv('\ufeffa,b\r\n1,"한글, ""인용""\n둘째 줄"\r\n');

  assert.deepEqual(rows, [
    { line: 1, fields: ['a', 'b'] },
    { line: 2, fields: ['1', '한글, "인용"\n둘째 줄'] },
  ]);
});

test('a final line ending does not create an empty record', () => {
  assert.deepEqual(parseCsv('a,b\n'), [{ line: 1, fields: ['a', 'b'] }]);
});

test('an unclosed quoted field reports where the field started', () => {
  assert.throws(
    () => parseCsv('a,b\n1,"열린 값'),
    error => (
      error instanceof CsvSyntaxError
      && error.line === 2
      && error.column === 3
      && /닫는 인용부호/.test(error.message)
    ),
  );
});

test('a quote in an unquoted field is rejected at the quote', () => {
  assert.throws(
    () => parseCsv('a,b\n1,bad"value'),
    error => error instanceof CsvSyntaxError && error.line === 2 && error.column === 6,
  );
});

test('characters after a closing quote are rejected', () => {
  assert.throws(
    () => parseCsv('a,b\n1,"value"tail'),
    error => error instanceof CsvSyntaxError && error.line === 2 && error.column === 10,
  );
});
