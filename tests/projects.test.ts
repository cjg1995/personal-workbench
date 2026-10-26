import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.js";
import { ConfigService } from "../src/core/config.js";
import { Git } from "../src/core/git.js";
import { TaskManager } from "../src/core/tasks.js";
import { ProjectService } from "../src/core/projects.js";
import {
  processEnvironments,
  processes,
  terminateTree,
} from "../src/core/process.js";
async function unusedPort() {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
function fixture(port: number, opener?: (url: string) => Promise<void>) {
  const dir = path.resolve(".local", "run-fixtures", randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify({ h5: { devServer: { port } } }),
  );
  const cli = path.join(dir, "cli.cjs");
  fs.writeFileSync(
    cli,
    `const http=require('http');http.createServer((q,r)=>r.end('fixture ready')).listen(${port},'127.0.0.1',()=>{console.log('Local: http://127.0.0.1:${port}/');console.log('password=should-be-hidden');console.log('"privateKey":"should-be-hidden"');console.log('Authorization: Bearer should-be-hidden');});`,
  );
  const store = new Store(path.join(dir, "data.sqlite")),
    config = new ConfigService(store, dir);
  const c = config.get();
  c.projects.find((p) => p.id === "employee")!.path = source;
  c.tools.hbNode = process.execPath;
  c.tools.hbCli = cli;
  config.save(c);
  const tasks = new TaskManager(store, dir),
    runner = path.resolve("src/main/service-runner.cjs"),
    service = new ProjectService(
      config,
      new Git(),
      tasks,
      dir,
      () => {},
      runner,
      undefined,
      opener,
    );
  return { dir, source, cli, store, config, tasks, service, runner };
}
test("本机进程环境探测只返回 UniApp 归属字段", async () => {
  const env = await processEnvironments([process.pid]);
  assert.equal(env[0].pid, process.pid);
  assert.ok(
    Object.keys(env[0]).every((k) =>
      ["pid", "input", "platform", "output"].includes(k),
    ),
  );
});
test("真实隔离 HTTP 进程：等待就绪、重复启动复用、日志脱敏、重开身份核验、旧 PID 拒绝、停止", async () => {
  const f = fixture(await unusedPort());
  let pid: number | undefined;
  try {
    const start = await f.service.start("employee");
    const second = await f.service.start("employee");
    assert.equal(second.reused, true);
    const task = await f.tasks.wait((start as any).taskId);
    assert.equal(task.state, "success", task.error || "");
    const run = await f.service.inspect("employee", true);
    pid = run.pid;
    assert.equal(run.state, "running");
    assert.equal(run.canStop, true);
    assert.ok(run.url);
    const log = fs.readFileSync(task.logPath, "utf8");
    assert.ok(log.includes("[已隐藏]"));
    assert.ok(!log.includes("should-be-hidden"));
    const reopened = new ProjectService(
      f.config,
      new Git(),
      f.tasks,
      f.dir,
      () => {},
      f.runner,
    );
    const adopted = await reopened.inspect("employee", true);
    assert.equal(adopted.pid, run.pid);
    assert.equal(adopted.canStop, true);
    const saved = f.store.get<any>("run", "employee");
    const pendingLog = path.join(f.dir, "not-ready.log");
    fs.writeFileSync(pendingLog, "Compiling...\n");
    f.store.set("run", "employee", {
      ...saved,
      state: "unknown",
      logPath: pendingLog,
    });
    await assert.rejects(() => reopened.start("employee"), /仍在运行/);
    assert.equal(f.store.get<any>("run", "employee").pid, pid);
    f.store.set("run", "employee", { ...saved, state: "unknown" });
    assert.equal(
      (await reopened.inspect("employee", true)).state,
      "running",
      "late readiness can be re-confirmed without starting again",
    );
    const configuration = f.config.get();
    configuration.projects.find((p) => p.id === "employee")!.expectedPort =
      Number(new URL(run.url!).port) + 1;
    f.config.save(configuration);
    assert.match(
      (await reopened.inspect("employee", true)).message || "",
      /配置已改变/,
    );
    await assert.rejects(() => reopened.start("employee"), /仍在运行/);
    delete configuration.projects.find((p) => p.id === "employee")!
      .expectedPort;
    f.config.save(configuration);
    const manifestFile = path.join(f.source, "manifest.json");
    const manifestBytes = fs.readFileSync(manifestFile);
    fs.writeFileSync(manifestFile, "invalid json");
    const invalidConfiguration = await reopened.inspect("employee", true);
    assert.equal(invalidConfiguration.pid, pid);
    assert.equal(invalidConfiguration.state, "unknown");
    assert.equal(invalidConfiguration.canStop, true);
    await assert.rejects(() => reopened.start("employee"), /仍在运行/);
    fs.writeFileSync(manifestFile, manifestBytes);
    f.store.set("run", "employee", { ...saved, created: "not-this-process" });
    await assert.rejects(() => reopened.stop("employee"), /身份/);
    assert.ok((await processes()).some((p) => p.pid === pid));
    f.store.set("run", "employee", saved);
    const stopped = await reopened.stop("employee");
    assert.equal(stopped.state, "stopped");
    assert.ok(!(await processes()).some((p) => p.pid === pid));
    pid = undefined;
  } finally {
    if (pid) await terminateTree(pid);
    await new Promise((r) => setTimeout(r, 100));
    f.store.close();
  }
});
test("端口占用保持未知并阻断，不静默改端口或结束其他服务", async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port,
    f = fixture(port);
  try {
    const inspect = await f.service.inspect("employee", true);
    assert.equal(inspect.state, "unknown");
    await assert.rejects(() => f.service.start("employee"), /占用/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.store.close();
  }
});
test("浏览器打开失败保留已就绪服务与阶段，重复启动复用；只停止自己的进程", async () => {
  const opened: string[] = [],
    f = fixture(await unusedPort(), async (url) => {
      opened.push(url);
      throw new Error("默认浏览器未注册");
    });
  try {
    const first = await f.service.start("employee"),
      task = await f.tasks.wait((first as any).taskId);
    assert.equal(task.state, "partial");
    assert.equal(task.stages[2].state, "done");
    assert.equal(task.stages[3].state, "failed");
    const run = await f.service.inspect("employee", true);
    assert.equal(run.state, "running");
    assert.equal(opened[0], run.url);
    assert.equal((await f.service.start("employee")).reused, true);
    assert.equal(opened.length, 1);
    assert.equal((await f.service.stop("employee")).state, "stopped");
  } finally {
    for (const run of await f.service.owned())
      await f.service.stop(run.projectId);
    f.store.close();
  }
});
test("外部 UniApp 实例通过实际进程环境识别，工作台不能停止", async () => {
  const f = fixture(await unusedPort());
  const external = spawn(process.execPath, [f.cli], {
    cwd: f.source,
    env: {
      ...process.env,
      UNI_INPUT_DIR: f.source,
      UNI_PLATFORM: "h5",
      UNI_OUTPUT_DIR: path.join(f.source, "out"),
    },
    windowsHide: true,
    stdio: "ignore",
  });
  try {
    await new Promise((r) => setTimeout(r, 500));
    const inspected = await f.service.inspect("employee", true);
    assert.equal(inspected.state, "external", inspected.message);
    assert.equal(inspected.pid, external.pid);
    const result = await f.service.start("employee");
    assert.equal(result.reused, true);
    await assert.rejects(() => f.service.stop("employee"), /拥有/);
  } finally {
    if (external.pid) await terminateTree(external.pid);
    f.store.close();
  }
});

test(
  "真实临时 Tomcat：沿用关闭自动部署的 IDEA 配置，原生加载指定应用，忽略其他日志地址，停止后原配置字节不变",
  {
    skip:
      !fs.existsSync("D:/apache-tomcat-7.0.81/bin/bootstrap.jar") ||
      !fs.existsSync("C:/Program Files/Java/jdk1.8.0_131/bin/java.exe"),
  },
  async () => {
    const port = await unusedPort(),
      f = fixture(port);
    const oldAppData = process.env.APPDATA,
      oldLocal = process.env.LOCALAPPDATA;
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    let pid: number | undefined;
    try {
      process.env.APPDATA = path.join(f.dir, "roaming");
      process.env.LOCALAPPDATA = path.join(f.dir, "local");
      const opts = path.join(
        process.env.APPDATA,
        "JetBrains/IntelliJIdeaFixture/options",
      );
      write(
        path.join(opts, "javaeeAppServers.xml"),
        '<application><ServerDK NAME="Fixture"><option name="CATALINA_HOME" value="D:/apache-tomcat-7.0.81"/></ServerDK></application>',
      );
      const base = path.join(f.dir, "tomcat-base"),
        deployment = path.join(f.source, "web");
      write(
        path.join(deployment, "WEB-INF/web.xml"),
        '<web-app xmlns="http://java.sun.com/xml/ns/javaee" version="3.0"></web-app>',
      );
      write(
        path.join(deployment, "index.html"),
        "Native Tomcat fixture is ready",
      );
      write(
        path.join(base, "conf/server.xml"),
        `<Server port="-1" shutdown="SHUTDOWN"><Service name="Catalina"><Connector port="${port}" protocol="HTTP/1.1"/><Engine name="Catalina" defaultHost="localhost"><Host name="localhost" appBase="webapps" deployOnStartup="false" autoDeploy="false"/></Engine></Service></Server>`,
      );
      const context = path.join(base, "conf/Catalina/localhost/fixture.xml");
      write(
        context,
        `<Context path="/fixture" docBase="${deployment.replaceAll("\\", "/")}"/>`,
      );
      fs.copyFileSync(
        "D:/apache-tomcat-7.0.81/conf/web.xml",
        path.join(base, "conf/web.xml"),
      );
      write(
        path.join(f.source, ".idea/workspace.xml"),
        '<project><configuration type="TomcatRunConfigurationFactory" APPLICATION_SERVER_NAME="Fixture" ALTERNATIVE_JRE_PATH="unused"><option name="COMMON_VM_ARGUMENTS" value="-Dfixture.documentation=http://localhost:12345/"/></configuration></project>',
      );
      const config = f.config.get(),
        project = config.projects.find((p) => p.id === "homeproject")!;
      project.path = f.source;
      project.java = "C:/Program Files/Java/jdk1.8.0_131/bin/java.exe";
      project.catalinaBase = base;
      project.context = "/fixture";
      if (process.env.WORKBENCH_TEST_JREBEL === "1") {
        project.vmArgs =
          "-agentpath:C:/Users/Master/AppData/Roaming/JetBrains/IntelliJIdea2020.3/plugins/jr-ide-idea/lib/jrebel6/lib/jrebel64.dll -Dfixture.documentation=http://localhost:12345/";
        const dir = deployment.replaceAll("\\", "/");
        write(
          path.join(deployment, "WEB-INF/classes/rebel.xml"),
          `<application xmlns="http://www.zeroturnaround.com"><classpath><dir name="${dir}/WEB-INF/classes"/></classpath><web><link target="/"><dir name="${dir}"/></link></web></application>`,
        );
      }
      f.config.save(config);
      const service = new ProjectService(
        f.config,
        new Git(),
        f.tasks,
        f.dir,
        () => {},
        f.runner,
        path.resolve("assets/runtime/tomcat/WorkbenchTomcat.class"),
      );
      const originalServer = fs.readFileSync(
          path.join(base, "conf/server.xml"),
        ),
        originalContext = fs.readFileSync(context);
      const started = await service.start(project.id),
        task = await f.tasks.wait((started as any).taskId);
      assert.equal(task.state, "success", task.error || "");
      const run = await service.inspect(project.id, true);
      pid = run.pid;
      assert.equal(run.state, "running");
      assert.match(
        await (await fetch(run.url! + "/index.html")).text(),
        /Native Tomcat fixture/,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(base, "conf/server.xml")),
        originalServer,
      );
      assert.deepEqual(fs.readFileSync(context), originalContext);
      const observerDir = path.join(f.dir, "observer"),
        observerStore = new Store(path.join(observerDir, "data.sqlite"));
      try {
        const observerConfig = new ConfigService(observerStore, observerDir);
        observerConfig.save(config);
        const observerTasks = new TaskManager(observerStore, observerDir),
          observer = new ProjectService(
            observerConfig,
            new Git(),
            observerTasks,
            observerDir,
            () => {},
            f.runner,
            path.resolve("assets/runtime/tomcat/WorkbenchTomcat.class"),
          );
        assert.equal(
          (await observer.inspect(project.id, true)).state,
          "external",
        );
        await assert.rejects(() => observer.stop(project.id), /拥有/);
      } finally {
        observerStore.close();
      }
      assert.equal((await service.stop(project.id)).state, "stopped");
      pid = undefined;
      if (process.env.WORKBENCH_TEST_JREBEL !== "1") {
        project.vmArgs = "  ";
        f.config.save(config);
        assert.ok(
          service
            .launchConfig(project, "check")
            .args.includes("-Dfixture.documentation=http://localhost:12345/"),
        );
      }
      project.expectedPort = Number(new URL(run.url!).port) + 1;
      f.config.save(config);
      assert.throws(() => service.launchConfig(project, "check"), /server.xml/);
    } finally {
      for (const run of await f.service.owned())
        await f.service.stop(run.projectId).catch(() => {});
      if (pid) await terminateTree(pid);
      f.store.close();
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
      if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = oldLocal;
    }
  },
);
