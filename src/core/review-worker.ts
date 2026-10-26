import { parentPort, workerData } from "node:worker_threads";
import { Git } from "./git.js";
import { ReviewCapture } from "./review-capture.js";
import { errorText } from "./util.js";

// Imports are loaded; every subsequent file read targets an external repository.
// Skip archive path probing for each of the thousands of working files.
(process as NodeJS.Process & { noAsar?: boolean }).noAsar = true;
const port = parentPort!;
const cancel = new Int32Array(workerData.cancel);
const controller = new AbortController();
port.on("message", () => controller.abort());
const git = new Git(workerData.executable);
const run = git.run.bind(git);
git.run = (repo, args, options = {}) =>
  run(repo, args, { ...options, signal: controller.signal, timeoutMs: 60000 });
let lastProgress = 0;
const capture = new ReviewCapture(git, (message) => {
  if (Atomics.load(cancel, 0)) throw new Error("已取消差异读取");
  if (Date.now() - lastProgress > 150) {
    lastProgress = Date.now();
    port.postMessage({ progress: message });
  }
});
capture
  .capture(workerData.range)
  .then(
    (result) => port.postMessage({ result }),
    (error) => port.postMessage({ error: errorText(error) }),
  )
  .finally(() => port.close());
