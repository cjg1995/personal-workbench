import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { redact, ensureDir } from "./util.js";
export function decodeOutput(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      return Buffer.from(bytes).toString("utf8");
    }
  }
}
export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  onData?: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  allowFailure?: boolean;
  input?: string | Uint8Array;
  raw?: boolean;
  requireFullOutput?: boolean;
}
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  pid?: number;
  stdoutBytes?: Buffer;
  stdoutSha256?: string;
  truncated?: boolean;
}
export class CommandError extends Error {
  constructor(
    public result: CommandResult,
    public executable: string,
    public args: string[],
  ) {
    super(
      `${path.basename(executable)} 执行失败（${result.code}）\n${redact([result.stdout.slice(-4000), result.stderr.slice(-2000)].filter(Boolean).join("\n"))}`,
    );
  }
}
export function command(
  executable: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted)
    return Promise.reject(new Error("任务已停止，未启动后续命令"));
  if (/\.(?:bat|cmd|ps1)$/i.test(executable))
    throw new Error("业务执行器只接受可执行工具；请使用其原生入口");
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      bytes = 0,
      settled = false,
      timedOut = false;
    const rawChunks: Buffer[] = [];
    const stdoutDigest = createHash("sha256");
    let rawSize = 0;
    const proc = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let log: fs.WriteStream | undefined;
    if (options.logPath) {
      ensureDir(path.dirname(options.logPath));
      log = fs.createWriteStream(options.logPath, { flags: "a" });
      log.on("error", () => {});
    }
    let outPending = Buffer.alloc(0),
      errPending = Buffer.alloc(0);
    const accept = (value: Buffer, isErr: boolean, flush = false) => {
      let pending = Buffer.concat([isErr ? errPending : outPending, value]);
      let at = 0;
      const emit = (data: Buffer) => {
        const line = decodeOutput(data);
        bytes += data.length;
        if (bytes <= (options.maxBytes || 32 * 1024 * 1024)) {
          if (isErr) stderr += line;
          else stdout += line;
        }
        log?.write(redact(line));
        options.onData?.(redact(line));
      };
      for (
        let end = pending.indexOf(10, at);
        end >= 0;
        end = pending.indexOf(10, at)
      ) {
        emit(pending.subarray(at, end + 1));
        at = end + 1;
      }
      pending = pending.subarray(at);
      if (flush && pending.length) {
        emit(pending);
        pending = Buffer.alloc(0);
      }
      if (isErr) errPending = pending;
      else outPending = pending;
    };
    proc.stdout.on("data", (b: Buffer) => {
      stdoutDigest.update(b);
      if (options.raw) {
        rawSize += b.length;
        if (rawSize <= (options.maxBytes || 32 * 1024 * 1024))
          rawChunks.push(b);
      }
      accept(b, false);
    });
    proc.stderr.on("data", (b) => accept(b, true));
    const stop = () => {
      if (proc.pid) void terminateTree(proc.pid);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeoutMs)
      : undefined;
    options.signal?.addEventListener("abort", stop, { once: true });
    proc.on("error", (e) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      log?.end();
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    proc.on("close", (code) => {
      accept(Buffer.alloc(0), false, true);
      accept(Buffer.alloc(0), true, true);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      log?.end();
      if (settled) return;
      settled = true;
      const result = {
        code: code ?? -1,
        stdout,
        stderr,
        pid: proc.pid,
        stdoutBytes: options.raw ? Buffer.concat(rawChunks) : undefined,
        stdoutSha256: stdoutDigest.digest("hex"),
        truncated: bytes > (options.maxBytes || 32 * 1024 * 1024),
      };
      if (timedOut) reject(new Error(`命令超时：${path.basename(executable)}`));
      else if (options.signal?.aborted)
        reject(new Error("任务已停止，未完成结果未标记为成功"));
      else if (result.code && !options.allowFailure)
        reject(new CommandError(result, executable, args));
      else if (result.truncated && options.requireFullOutput)
        reject(
          new Error(
            `工具输出超过核对上限：${path.basename(executable)}，未使用不完整结果继续操作`,
          ),
        );
      else resolve(result);
    });
    if (options.input) proc.stdin.end(options.input);
    else proc.stdin.end();
  });
}
export function terminateTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    p.on("error", () => resolve());
    p.on("close", () => resolve());
  });
}
export interface ProcessIdentity {
  pid: number;
  parent: number;
  created: string;
  executable: string;
  commandLine: string;
}
export async function processes(): Promise<ProcessIdentity[]> {
  const script =
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parent';e={$_.ParentProcessId}},@{n='created';e={$_.CreationDate.ToUniversalTime().ToString('o')}},@{n='executable';e={$_.ExecutablePath}},@{n='commandLine';e={$_.CommandLine}}) | ConvertTo-Json -Compress";
  const r = await command(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeoutMs: 15000, maxBytes: 8 * 1024 * 1024 },
  );
  return JSON.parse(r.stdout || "[]") as ProcessIdentity[];
}
export function sameProcess(
  saved: { pid?: number; created?: string; executable?: string },
  actual: ProcessIdentity,
) {
  return (
    saved.pid === actual.pid &&
    saved.created === actual.created &&
    !!saved.executable &&
    saved.executable.toLowerCase() === actual.executable?.toLowerCase()
  );
}
export async function listenerPids(port: number): Promise<number[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口无效");
  const script = `$ErrorActionPreference='Stop'; @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`;
  const result = await command(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeoutMs: 15000 },
  );
  const value = JSON.parse(result.stdout || "[]");
  return (Array.isArray(value) ? value : [value]).filter(
    (n): n is number => Number.isInteger(n) && n > 0,
  );
}
export async function visibleClientWindows(
  executable: string,
): Promise<{ pid: number; handle: number; title: string }[]> {
  const target = path.resolve(executable).replaceAll("'", "''");
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${target}' -and $_.MainWindowHandle -ne 0 } | Select-Object @{n='pid';e={$_.Id}},@{n='handle';e={$_.MainWindowHandle.ToInt64()}},@{n='title';e={$_.MainWindowTitle}}) | ConvertTo-Json -Compress`;
  const result = await command(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeoutMs: 15000 },
  );
  const parsed = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}
export async function processEnvironments(
  pids: number[],
): Promise<
  { pid: number; input?: string; output?: string; platform?: string }[]
> {
  if (!pids.length) return [];
  const code = String.raw`
using System; using System.Text; using System.Runtime.InteropServices;
public class WorkbenchProcessEnvironment {
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] bytes, int count, out IntPtr read);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int type, IntPtr[] data, int size, out int returned);
 static byte[] Read(IntPtr h,long address,int length) { byte[] b=new byte[length]; IntPtr n; ReadProcessMemory(h,new IntPtr(address),b,length,out n); if(n.ToInt64()<=0)return new byte[0]; Array.Resize(ref b,(int)n); return b; }
 static long Pointer(IntPtr h,long address,int size) {byte[] b=Read(h,address,size); if(b.Length!=size)return 0;return size==4?BitConverter.ToUInt32(b,0):BitConverter.ToInt64(b,0);}
 public static string ReadEnvironment(int pid) { IntPtr h=OpenProcess(0x410,false,pid); if(h==IntPtr.Zero)return ""; try {IntPtr[] data=new IntPtr[6];int returned; if(NtQueryInformationProcess(h,0,data,IntPtr.Size*6,out returned)!=0)return "";long peb=data[1].ToInt64();int size=8;IntPtr[] wow=new IntPtr[1];if(NtQueryInformationProcess(h,26,wow,IntPtr.Size,out returned)==0&&wow[0]!=IntPtr.Zero){peb=wow[0].ToInt64();size=4;}long parameters=Pointer(h,peb+(size==8?0x20:0x10),size);long env=Pointer(h,parameters+(size==8?0x80:0x48),size);if(env==0)return "";StringBuilder result=new StringBuilder();for(int offset=0;offset<524288;offset+=4096){byte[] bytes=Read(h,env+offset,4096);if(bytes.Length==0)break;result.Append(Encoding.Unicode.GetString(bytes));string value=result.ToString();int end=value.IndexOf("\0\0",StringComparison.Ordinal);if(end>=0)return value.Substring(0,end);}return result.ToString();}catch{return "";}finally{CloseHandle(h);} }
}`;
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition @'\n${code}\n'@; @(${pids
    .filter(Number.isInteger)
    .map(
      (pid) =>
        `$v=@{}; ([WorkbenchProcessEnvironment]::ReadEnvironment(${pid}) -split [char]0) | ForEach-Object { if($_ -match '^(UNI_INPUT_DIR|UNI_OUTPUT_DIR|UNI_PLATFORM)=(.*)$') { $v[$matches[1]]=$matches[2] } }; [pscustomobject]@{pid=${pid};input=$v.UNI_INPUT_DIR;output=$v.UNI_OUTPUT_DIR;platform=$v.UNI_PLATFORM}`,
    )
    .join("\n")}) | ConvertTo-Json -Compress`;
  const result = await command(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeoutMs: 20000 },
  );
  const parsed = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}
