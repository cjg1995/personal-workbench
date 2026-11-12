const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

async function main() {
  const { JavaLanguageService } = await import("../dist/core/java-language-service.js");
  const runtime = process.env.PWB_TEST_RUNTIME || path.resolve(__dirname, "..", ".local", "editor-runtime");
  const root = path.resolve(__dirname, "..", ".local", "editor-language-tests", randomUUID());
  const file = (name, text) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  file("pom.xml", `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>sample</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>api</module><module>impl</module><module>consumer</module></modules><properties><maven.compiler.source>1.8</maven.compiler.source><maven.compiler.target>1.8</maven.compiler.target></properties></project>`);
  const modulePom = (name, deps = "") => file(`${name}/pom.xml`, `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><parent><groupId>sample</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>${name}</artifactId>${deps}</project>`);
  const apiSource = process.env.PWB_TEST_JAVA_SOURCE || "1.8";
  modulePom("api", `<properties><maven.compiler.source>${apiSource}</maven.compiler.source><maven.compiler.target>${apiSource}</maven.compiler.target></properties>`);
  modulePom("impl", "<dependencies><dependency><groupId>sample</groupId><artifactId>api</artifactId><version>1</version></dependency></dependencies>");
  modulePom("consumer", "<dependencies><dependency><groupId>sample</groupId><artifactId>api</artifactId><version>1</version></dependency><dependency><groupId>sample</groupId><artifactId>impl</artifactId><version>1</version></dependency></dependencies>");
  const api = file("api/src/main/java/sample/api/Gateway.java", `package sample.api;\npublic interface Gateway {\n    String send(String value);\n    String send(int value);\n}\n`);
  const base = file("impl/src/main/java/sample/impl/Base.java", `package sample.impl;\npublic abstract class Base {\n    protected String normalize(String value) { return value.trim(); }\n}\n`);
  const first = file("impl/src/main/java/sample/impl/FirstGateway.java", `package sample.impl;\nimport sample.api.Gateway;\npublic class FirstGateway extends Base implements Gateway {\n    @Override public String send(String value) { return normalize(value); }\n    @Override public String send(int value) { return String.valueOf(value); }\n}\n`);
  const second = file("impl/src/main/java/sample/impl/SecondGateway.java", `package sample.impl;\nimport sample.api.Gateway;\npublic class SecondGateway implements Gateway {\n    @Override public String send(String value) { return value; }\n    @Override public String send(int value) { return String.valueOf(value); }\n}\n`);
  const caller = file("consumer/src/main/java/sample/consumer/Caller.java", `package sample.consumer;\nimport sample.api.Gateway;\nimport sample.impl.FirstGateway;\npublic class Caller {\n    void execute(Gateway gateway) {\n        gateway.send("hello");\n        gateway.send(1);\n        new FirstGateway().send("world");\n    }\n}\n`);
  const locations = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((item) => ({ uri: item.targetUri || item.uri, line: (item.targetSelectionRange || item.range || item.targetRange).start.line + 1 }));
  const at = (target, line, character) => ({ textDocument: { uri: pathToFileURL(target).href }, position: { line: line - 1, character } });
  const project = { id: "fixture", name: "fixture", path: root, type: "spring" };
  const events = [];
  const service = new JavaLanguageService(project, runtime, path.resolve(__dirname, "..", ".local", "editor-lsp-cache"), (method, params) => {
    if (method === "status") { events.push(params); process.stdout.write(`JDT: ${params.status} ${params.message || ""}\n`); }
    if (method === "diagnostics") events.push({ method, params });
  });
  const start = Date.now();
  try {
    await service.start();
    for (const source of [api, base, first, second, caller]) service.open(source, fs.readFileSync(source, "utf8"));
    const readyDeadline = Date.now() + 240000;
    while (service.status !== "ready" && Date.now() < readyDeadline)
      await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(service.status, "ready", "JDT did not finish project import");
    assert.equal(fs.existsSync(path.join(root, "api", ".project")), false, "JDT must keep generated Eclipse metadata outside the source project");
    const deadline = Date.now() + 90000;
    let definition = [];
    while (Date.now() < deadline) {
      definition = locations(await service.request("textDocument/definition", at(caller, 6, 17)));
      if (definition.some((item) => item.uri === pathToFileURL(api).href && item.line === 3)) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    assert(definition.some((item) => item.uri === pathToFileURL(api).href && item.line === 3), `cross-module definition: ${JSON.stringify(definition)}`);
    const overloaded = locations(await service.request("textDocument/definition", at(caller, 7, 17)));
    assert(overloaded.some((item) => item.uri === pathToFileURL(api).href && item.line === 4), `overload: ${JSON.stringify(overloaded)}`);
    const completionResult = await service.request("textDocument/completion", at(caller, 6, 16));
    const completionItems = Array.isArray(completionResult) ? completionResult : completionResult?.items || [];
    assert(completionItems.some((item) => String(item.label).includes("send")),
      `Java completion: ${JSON.stringify(completionItems.slice(0, 8).map((item) => item.label))}`);
    let implementations = [];
    const implementationDeadline = Date.now() + 15000;
    while (Date.now() < implementationDeadline) {
      implementations = locations(await service.request("textDocument/implementation", at(api, 3, 11)));
      if (implementations.length) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(implementations.some((item) => item.uri === pathToFileURL(first).href && item.line === 4), `first implementation: ${JSON.stringify(implementations)}; diagnostics: ${JSON.stringify(events.filter((item) => item.method === "diagnostics").flatMap((item) => item.params.diagnostics || []).map((item) => item.message).slice(-12))}`);
    assert(implementations.some((item) => item.uri === pathToFileURL(second).href && item.line === 4), `second implementation: ${JSON.stringify(implementations)}`);
    const references = locations(await service.request("textDocument/references", { ...at(api, 3, 11), context: { includeDeclaration: false } }));
    assert(references.some((item) => item.uri === pathToFileURL(caller).href && item.line === 6), `references: ${JSON.stringify(references)}`);
    const inherited = locations(await service.request("textDocument/definition", at(first, 4,
      fs.readFileSync(first, "utf8").split("\n")[3].indexOf("normalize") + 2)));
    assert(inherited.some((item) => item.uri === pathToFileURL(base).href && item.line === 3), `inherited method: ${JSON.stringify(inherited)}`);
    const parameter = locations(await service.request("textDocument/definition", at(caller, 6, 8)));
    assert(parameter.some((item) => item.uri === pathToFileURL(caller).href && item.line === 5), `parameter: ${JSON.stringify(parameter)}`);
    const superMethod = locations(await service.request("java/findLinks", { type: "superImplementation", position: at(first, 4, 29) }));
    assert(superMethod.some((item) => item.uri === pathToFileURL(api).href && item.line === 3), `super method: ${JSON.stringify(superMethod)}`);
    const hierarchy = await service.request("textDocument/prepareTypeHierarchy", at(first, 3, 15));
    assert(hierarchy && hierarchy.length, "type hierarchy unavailable");
    const parents = await service.request("typeHierarchy/supertypes", { item: hierarchy[0] });
    assert(parents.some((item) => item.name === "Base"), `base class: ${JSON.stringify(parents)}`);
    assert(parents.some((item) => item.name === "Gateway"), `interface: ${JSON.stringify(parents)}`);
    const changedText = fs.readFileSync(caller, "utf8").replace('gateway.send("hello")', "gateway.send(2)");
    service.change(caller, changedText);
    const changeDeadline = Date.now() + 25000;
    let changedDefinition = [];
    while (Date.now() < changeDeadline) {
      changedDefinition = locations(await service.request("textDocument/definition", at(caller, 6, 17)));
      if (changedDefinition.some((item) => item.uri === pathToFileURL(api).href && item.line === 4)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(changedDefinition.some((item) => item.uri === pathToFileURL(api).href && item.line === 4), `unsaved change navigation: ${JSON.stringify(changedDefinition)}`);
    service.change(caller, fs.readFileSync(caller, "utf8").replace('gateway.send("hello")', 'gateway.unknownMethod("hello")'));
    const diagnosticDeadline = Date.now() + 20000;
    let diagnostics = [];
    while (Date.now() < diagnosticDeadline) {
      diagnostics = events.filter((entry) => entry.method === "diagnostics" && entry.params.uri === pathToFileURL(caller).href)
        .flatMap((entry) => entry.params.diagnostics || [])
        .filter((item) => item.range.start.line === 5 && item.severity === 1 && item.message.includes("unknownMethod"));
      if (diagnostics.length) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert(diagnostics.length, "Java unsaved syntax diagnostics were not published");
    service.change(caller, fs.readFileSync(caller, "utf8"));
    process.stdout.write(JSON.stringify({
      elapsedMs: Date.now() - start, definition, overloaded, implementations,
      references, inherited, parameter, superMethod, parents: parents.map((item) => item.name),
      changedDefinition, completionItems: completionItems.length, diagnostics: diagnostics.length,
    }, null, 2) + "\n");
  } finally {
    await service.stop();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
