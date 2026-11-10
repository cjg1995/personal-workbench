import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.js";
import { ConfigService } from "../src/core/config.js";
import { Git } from "../src/core/git.js";
import { TaskManager } from "../src/core/tasks.js";
import { ProjectService } from "../src/core/projects.js";
import { command, processes, terminateTree } from "../src/core/process.js";

const java = "C:/Program Files/Java/jdk1.8.0_131/bin/java.exe";
const maven = "D:/apache-maven-3.6.3";
const hooks = "D:/IdeaProjects/refsys";

test("Spring 编译失败：保留失败退出码，不使用旧依赖文件启动应用", async () => {
  const dir = path.resolve(".local", "spring-failed", randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const classpathFile = path.join(dir, "classpath.txt");
  const launchedFile = path.join(dir, "unexpected-app.txt");
  fs.writeFileSync(classpathFile, process.execPath);
  const marker = randomUUID();
  const launch = {
    marker,
    logPath: path.join(dir, "run.log"),
    exe: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(launchedFile)}, 'unexpected')`],
    cwd: dir,
    prepare: { exe: process.execPath, args: ["-e", "process.exit(7)"], classpathFile },
  };
  const result = await command(process.execPath, [path.resolve("src/main/service-runner.cjs"), "--marker=" + marker], {
    env: { WORKBENCH_SERVICE_LAUNCH: JSON.stringify(launch) },
    allowFailure: true,
    timeoutMs: 15000,
  });
  assert.equal(result.code, 7);
  assert.equal(fs.existsSync(launchedFile), false);
  assert.equal(fs.existsSync(classpathFile), false);
});

test("Spring 开发运行：Maven 退出、单应用 JVM、参数与 Profile 生效、Codex/Cursor hook 均能热更新", {
  skip: !fs.existsSync(java) || !fs.existsSync(maven) || !fs.existsSync(path.join(hooks, ".codex/hooks/devtools-hot-reload.ps1")),
  timeout: 240000,
}, async () => {
  const dir = path.resolve(".local", "spring runtime", randomUUID());
  const source = path.join(dir, "source");
  const write = (file: string, value: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  write(path.join(source, "pom.xml"), `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.5.15</version></parent><groupId>workbench.check</groupId><artifactId>spring-runtime</artifactId><version>1</version><properties><java.version>1.8</java.version></properties><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-devtools</artifactId><optional>true</optional></dependency></dependencies><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId><configuration><fork>true</fork></configuration></plugin></plugins></build></project>`);
  write(path.join(source, ".idea/workspace.xml"), '<project><configuration type="SpringBootApplicationConfigurationType"><option name="SPRING_BOOT_MAIN_CLASS" value="com.ruoyi.RuoYiApplication"/><option name="VM_PARAMETERS" value="-Dfixture.vm=idea"/><option name="ACTIVE_PROFILES" value="idea-profile"/></configuration></project>');
  write(path.join(source, ".idea/misc.xml"), '<project><component name="ProjectRootManager" project-jdk-name="fixture"/></project>');
  write(path.join(source, "src/main/resources/application.yml"), `server:\n  port: ${port}\nspring:\n  devtools:\n    restart:\n      enabled: true\n`);
  const javaFile = path.join(source, "src/main/java/com/ruoyi/RuoYiApplication.java");
  const application = (value: string) => `package com.ruoyi;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.beans.factory.annotation.Value;
@SpringBootApplication @RestController
public class RuoYiApplication {
  @Value("\${spring.profiles.active:}") private String profile;
  @RequestMapping("/") public String value() { return "${value}:" + System.getProperty("fixture.vm") + ":" + profile; }
  public static void main(String[] args) { SpringApplication.run(RuoYiApplication.class, args); }
}`;
  write(javaFile, application("initial"));
  for (const file of [".codex/hooks/devtools-hot-reload.ps1", ".cursor/hooks/devtools-hook-common.ps1", ".cursor/hooks/devtools-compile-on-stop.ps1", ".cursor/hooks/mark-devtools-pending.ps1"])
    write(path.join(source, file), fs.readFileSync(path.join(hooks, file), "utf8"));
  const store = new Store(path.join(dir, "data.sqlite"));
  const config = new ConfigService(store, dir);
  const settings = config.get();
  const project = settings.projects.find((p) => p.id === "refsys")!;
  Object.assign(project, { path: source, java, vmArgs: "-Xms64m -Xmx256m -Dfixture.vm=application", springProfile: "hook-check" });
  settings.tools.maven = maven;
  config.save(settings);
  const tasks = new TaskManager(store, dir);
  const service = new ProjectService(config, new Git(), tasks, dir, () => {}, path.resolve("src/main/service-runner.cjs"));
  let pid: number | undefined;
  const hook = (file: string, payload: object) => command("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(source, file)], {
    cwd: source,
    input: JSON.stringify(payload),
    env: { JAVA_HOME: path.dirname(path.dirname(java)), PATH: path.join(maven, "bin") + path.delimiter + process.env.PATH },
    timeoutMs: 60000,
  });
  async function waitValue(value: string) {
    const deadline = Date.now() + 45000;
    let actual = "";
    while (Date.now() < deadline) {
      try { actual = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).text(); } catch {}
      if (actual === `${value}:application:hook-check`) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.fail(`Expected ${value}:application:hook-check, got ${actual}`);
  }
  try {
    const launch = service.launchConfig(project, "check");
    assert.ok(launch.args.includes("-Xmx256m"));
    assert.ok(launch.args.includes("com.ruoyi.RuoYiApplication"));
    assert.ok(!launch.args.includes("spring-boot:run"));
    assert.ok(!launch.prepare!.args.includes("-Xmx256m"));
    const inherited = service.launchConfig({ ...project, vmArgs: " ", springProfile: "" }, "idea");
    assert.ok(inherited.args.includes("-Dfixture.vm=idea"));
    assert.ok(inherited.args.includes("--spring.profiles.active=idea-profile"));
    const started = await service.start(project.id);
    pid = started.run.pid;
    const task = await tasks.wait(started.taskId!);
    assert.equal(task.state, "success", task.error || "");
    const run = await service.inspect(project.id, true);
    pid = run.pid;
    assert.equal(run.state, "running", run.message);
    await waitValue("initial");
    const tree = await processes();
    const children = tree.filter((p) => p.parent === run.pid && /javaw?\.exe$/i.test(p.executable || ""));
    assert.equal(children.length, 1, "only the application remains under the service runner");
    assert.match(children[0].commandLine || "", /com\.ruoyi\.RuoYiApplication/);
    assert.doesNotMatch(children[0].commandLine || "", /classworlds|spring-boot:run/);
    assert.equal(tree.filter((p) => p.parent === children[0].pid && /javaw?\.exe$/i.test(p.executable || "")).length, 0);
    assert.match(fs.readFileSync(task.logPath, "utf8"), /WORKBENCH_SPRING_PREPARED/);
    assert.match(fs.readFileSync(launch.prepare!.classpathFile, "utf8"), /spring-boot-devtools/);
    assert.doesNotMatch(fs.readFileSync(launch.prepare!.classpathFile, "utf8"), /spring-boot-starter-test/);
    assert.equal((await service.start(project.id)).reused, true);
    const payload = { session_id: "runtime-check", turn_id: "one", hook_event_name: "UserPromptSubmit" };
    await hook(".codex/hooks/devtools-hot-reload.ps1", payload);
    write(javaFile, application("codex"));
    await hook(".codex/hooks/devtools-hot-reload.ps1", { ...payload, hook_event_name: "Stop" });
    await waitValue("codex");
    write(javaFile, application("cursor"));
    await hook(".cursor/hooks/mark-devtools-pending.ps1", { file_path: javaFile });
    await hook(".cursor/hooks/devtools-compile-on-stop.ps1", {});
    await waitValue("cursor");
    const after = await processes();
    assert.ok(after.some((p) => p.pid === children[0].pid), "DevTools restarts inside the same application JVM");
    assert.equal(after.filter((p) => p.parent === run.pid && /javaw?\.exe$/i.test(p.executable || "")).length, 1);
    await service.stop(project.id);
    pid = undefined;
  } finally {
    for (const run of await service.owned()) await service.stop(run.projectId).catch(() => {});
    if (pid) await terminateTree(pid);
    store.close();
  }
});
