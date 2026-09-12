export interface StdoutSink {
  write(line: string, callback: (error?: Error | null) => void): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'drain', listener: () => void): this;
}

export function createStdoutWriter(sink: StdoutSink = process.stdout): (line: string) => void {
  let failed = false;
  let backpressured = false;

  sink.on('error', () => {
    failed = true;
    backpressured = false;
  });

  return line => {
    if (failed || backpressured) return;

    try {
      const accepted = sink.write(line, error => {
        if (!error) return;
        failed = true;
        backpressured = false;
      });
      if (!accepted && !failed) {
        backpressured = true;
        sink.once('drain', () => {
          if (!failed) backpressured = false;
        });
      }
    } catch {
      failed = true;
      backpressured = false;
    }
  };
}
