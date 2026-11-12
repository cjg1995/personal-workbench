import fs from "node:fs";

const CAP = 1024 * 1024;

export function readLogTail(file: string, offset = 0) {
  const size = fs.statSync(file).size;
  const requested = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const truncated = requested > size;
  const start = truncated ? 0 : Math.min(requested, size);
  const begin = size - start > CAP ? size - CAP : start;
  const length = size - begin;
  const bytes = Buffer.alloc(length);
  if (length) {
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, bytes, 0, length, begin);
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    text: bytes.toString("utf8"),
    offset: size,
    reset: truncated || begin !== start,
  };
}
