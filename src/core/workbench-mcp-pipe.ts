import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { atomicWrite, errorText, readJson, redact } from "./util.js";

type Endpoint = { pipeId: string; token: string };
type PipeRequest = { token: string; name: string; args: Record<string, unknown> };
type PipeReply =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

const endpointFile = (dataDir: string) => path.join(dataDir, "mcp-endpoint.json");
const pipePath = (pipeId: string) => "\\\\.\\pipe\\personal-workbench-mcp-" + pipeId;
const tokenPattern = /^[a-f0-9]{64}$/;
const maxRequestBytes = 2 * 1024 * 1024;

export class WorkbenchUnavailable extends Error {}

function readMessage<T>(socket: Socket, maxBytes = Infinity) {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const onData = (chunk: Buffer) => {
      const lineEnd = chunk.indexOf(10);
      const data = lineEnd === -1 ? chunk : chunk.subarray(0, lineEnd);
      received += data.length;
      if (received > maxBytes) {
        fail(new Error("工作台接入消息过大"));
        return;
      }
      chunks.push(data);
      if (lineEnd === -1) return;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks, received).toString("utf8")) as T);
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => fail(new Error("工作台连接已关闭"));
    const onTimeout = () => fail(new Error("工作台连接超时"));
    function cleanup() {
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
      socket.off("timeout", onTimeout);
      socket.setTimeout(0);
    }
    function fail(error: Error) {
      cleanup();
      reject(error);
    }
    socket.setTimeout(4_000);
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("close", onClose);
    socket.once("timeout", onTimeout);
  });
}

export function startWorkbenchPipe(
  dataDir: string,
  handle: (name: string, args: unknown) => Record<string, unknown>,
  reportError: (error: unknown) => void,
) {
  const file = endpointFile(dataDir);
  const endpoint: Endpoint = {
    pipeId: randomUUID(),
    token: randomBytes(32).toString("hex"),
  };
  const token = Buffer.from(endpoint.token, "hex");
  const connections = new Set<Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    void (async () => {
      let reply: PipeReply;
      try {
        const request = await readMessage<PipeRequest>(socket, maxRequestBytes);
        if (
          typeof request?.token !== "string" || !tokenPattern.test(request.token) ||
          !timingSafeEqual(Buffer.from(request.token, "hex"), token)
        ) {
          throw new Error("工作台连接授权无效");
        }
        reply = { ok: true, data: handle(request.name, request.args) };
      } catch (error) {
        reply = { ok: false, error: redact(errorText(error)) };
      }
      if (!socket.destroyed) socket.end(JSON.stringify(reply) + "\n");
    })();
  });
  server.maxConnections = 16;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    server.close();
    for (const socket of connections) socket.destroy();
    try {
      if (readJson<Endpoint>(file).pipeId === endpoint.pipeId) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // A stale endpoint is harmless. The next launch publishes a new one.
    }
  }
  function failed(error: unknown) {
    close();
    reportError(error);
  }
  server.on("error", failed);
  server.listen(pipePath(endpoint.pipeId), () => {
    try {
      if (!closed) atomicWrite(file, JSON.stringify(endpoint));
    } catch (error) {
      failed(error);
    }
  });
  return close;
}

export async function requestWorkbench(
  dataDir: string,
  name: string,
  args: Record<string, unknown>,
) {
  let endpoint: Endpoint;
  try {
    endpoint = readJson<Endpoint>(endpointFile(dataDir));
    if (
      !/^[a-f0-9-]{36}$/.test(endpoint.pipeId) ||
      !tokenPattern.test(endpoint.token)
    ) {
      throw new Error("工作台接入地址无效");
    }
  } catch (error) {
    throw new WorkbenchUnavailable("工作台尚未启动", { cause: error });
  }
  const message = JSON.stringify({ token: endpoint.token, name, args }) + "\n";
  const socket = net.createConnection(pipePath(endpoint.pipeId));
  socket.on("error", () => socket.destroy());
  let reply: PipeReply;
  try {
    const reading = readMessage<PipeReply>(socket);
    socket.write(message);
    reply = await reading;
  } catch (error) {
    throw new WorkbenchUnavailable("工作台暂时无法连接", { cause: error });
  } finally {
    socket.destroy();
  }
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
