import fs from "node:fs";

const CAP = 1024 * 1024;

export function readLogTail(file: string, offset = 0, capacity = CAP) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const requested = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const truncated = requested > size;
    const start = truncated ? 0 : requested;
    const begin = Math.max(start, size - capacity);
    const bytes = Buffer.alloc(size - begin);
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, begin + read);
      if (!n) break;
      read += n;
    }
    return {
      text: bytes.toString("utf8", 0, read),
      offset: begin + read,
      reset: truncated || begin !== start,
    };
  } finally {
    fs.closeSync(fd);
  }
}
