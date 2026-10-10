/**
 * Synchronous read of all of fd 0 with a bounded EAGAIN retry loop (AISDLC-571
 * class: Node's sync read of piped stdin can throw EAGAIN on Linux). Never opens
 * the stdin device file, which ENXIOs on some runners. Mirrors subagent-start.js.
 */
const { readSync } = require('fs');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStdinSync(fd = 0) {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  const MAX_EAGAIN_RETRIES = 200;
  let eagainRetries = 0;
  for (;;) {
    let bytesRead;
    try {
      bytesRead = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        eagainRetries += 1;
        if (eagainRetries > MAX_EAGAIN_RETRIES) throw err;
        sleepSync(10);
        continue;
      }
      if (err && err.code === 'EOF') break;
      throw err;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

module.exports = { readStdinSync };
