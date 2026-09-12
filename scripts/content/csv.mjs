export class CsvSyntaxError extends Error {
  constructor(message, line, column) {
    super(message);
    this.name = 'CsvSyntaxError';
    this.line = line;
    this.column = column;
  }
}

export function parseCsv(source) {
  let offset = source.startsWith('\ufeff') ? 1 : 0;
  let line = 1;
  let column = 1;
  let recordLine = 1;
  let field = '';
  let fields = [];
  let state = 'field-start';
  let quoteLine = 1;
  let quoteColumn = 1;
  let recordJustEnded = false;
  const records = [];

  const consumeNewline = () => {
    if (source[offset] === '\r' && source[offset + 1] === '\n') {
      offset += 2;
    } else {
      offset += 1;
    }
    line += 1;
    column = 1;
  };

  const finishRecord = () => {
    fields.push(field);
    records.push({ line: recordLine, fields });
    field = '';
    fields = [];
    state = 'field-start';
    recordJustEnded = true;
  };

  while (offset < source.length) {
    const character = source[offset];
    const isNewline = character === '\n' || character === '\r';

    if (state === 'quoted') {
      if (character === '"') {
        if (source[offset + 1] === '"') {
          field += '"';
          offset += 2;
          column += 2;
        } else {
          state = 'after-quote';
          offset += 1;
          column += 1;
        }
      } else if (isNewline) {
        field += character === '\r' && source[offset + 1] === '\n' ? '\r\n' : character;
        consumeNewline();
      } else {
        field += character;
        offset += 1;
        column += 1;
      }
      continue;
    }

    if (isNewline) {
      finishRecord();
      consumeNewline();
      recordLine = line;
      continue;
    }

    if (state === 'after-quote') {
      if (character !== ',') {
        throw new CsvSyntaxError(
          '닫는 인용부호 뒤에는 쉼표나 줄끝만 올 수 있습니다.',
          line,
          column,
        );
      }
      fields.push(field);
      field = '';
      state = 'field-start';
      recordJustEnded = false;
      offset += 1;
      column += 1;
      continue;
    }

    if (character === ',') {
      fields.push(field);
      field = '';
      state = 'field-start';
      recordJustEnded = false;
      offset += 1;
      column += 1;
      continue;
    }

    if (character === '"') {
      if (state !== 'field-start') {
        throw new CsvSyntaxError(
          '인용부호는 필드의 첫 문자에만 올 수 있습니다.',
          line,
          column,
        );
      }
      state = 'quoted';
      quoteLine = line;
      quoteColumn = column;
      recordJustEnded = false;
      offset += 1;
      column += 1;
      continue;
    }

    field += character;
    state = 'unquoted';
    recordJustEnded = false;
    offset += 1;
    column += 1;
  }

  if (state === 'quoted') {
    throw new CsvSyntaxError('닫는 인용부호가 없습니다.', quoteLine, quoteColumn);
  }

  if (!recordJustEnded) {
    finishRecord();
  }

  return records;
}
