import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';

type WriteCallback = (error?: Error | null) => void;

class ControlledSink extends EventEmitter {
  readonly writes: string[] = [];
  acceptNextWrite = true;
  callbackError: Error | undefined;

  write(line: string, callback: WriteCallback): boolean {
    this.writes.push(line);
    const error = this.callbackError;
    this.callbackError = undefined;
    callback(error);
    return this.acceptNextWrite;
  }
}

async function loadWriter() {
  return (await import('../src/stdout-writer.ts')).createStdoutWriter;
}

test('stdout writer emits successful lines unchanged', async () => {
  const createStdoutWriter = await loadWriter();
  const sink = new ControlledSink();
  const write = createStdoutWriter(sink);

  write('{"event":"api_listening"}\n');

  assert.deepEqual(sink.writes, ['{"event":"api_listening"}\n']);
});

test('stdout writer consumes sink error events and drops all later records', async () => {
  const createStdoutWriter = await loadWriter();
  const sink = new ControlledSink();
  const write = createStdoutWriter(sink);

  write('{"event":"before_error"}\n');
  assert.doesNotThrow(() => sink.emit('error', new Error('provider-secret-must-not-be-logged')));
  write('{"event":"after_error","provider":"private"}\n');

  assert.deepEqual(sink.writes, ['{"event":"before_error"}\n']);
});

test('stdout writer drops later records after a write callback error', async () => {
  const createStdoutWriter = await loadWriter();
  const sink = new ControlledSink();
  sink.callbackError = new Error('closed sink');
  const write = createStdoutWriter(sink);

  assert.doesNotThrow(() => write('{"event":"failed_write"}\n'));
  write('{"event":"must_be_dropped"}\n');

  assert.deepEqual(sink.writes, ['{"event":"failed_write"}\n']);
});

test('stdout writer does not enqueue records while the sink is backpressured', async () => {
  const createStdoutWriter = await loadWriter();
  const sink = new ControlledSink();
  sink.acceptNextWrite = false;
  const write = createStdoutWriter(sink);

  write('{"event":"fills_sink"}\n');
  write('{"event":"dropped_while_full"}\n');
  sink.acceptNextWrite = true;
  sink.emit('drain');
  write('{"event":"after_drain"}\n');

  assert.deepEqual(sink.writes, [
    '{"event":"fills_sink"}\n',
    '{"event":"after_drain"}\n',
  ]);
});

test('stdout writer keeps a real child process alive after its pipe closes', { timeout: 5_000 }, async () => {
  const script = `
    const module = await import('./src/stdout-writer.ts').catch(() => ({}));
    const write = module.createStdoutWriter
      ? module.createStdoutWriter(process.stdout)
      : line => process.stdout.write(line);
    for (let index = 0; index < 100_000; index += 1) {
      write(JSON.stringify({ event: 'closed_pipe_probe', index }) + '\\n');
    }
    setTimeout(() => process.exit(0), 20);
  `;
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.once('data', () => { child.stdout.destroy(); });

  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];

  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
});
