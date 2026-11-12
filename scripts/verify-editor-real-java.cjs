const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

(async () => {
  const source = "D:/IdeaProjects/refsys";
  if (!fs.existsSync(source)) throw new Error("真实 refsys 工程不存在");
  const root = path.resolve(__dirname, "..", ".local", "editor-real-refsys");
  const { EditorFiles } = await import("../dist/core/editor-files.js");
  const { JavaLanguageService } = await import("../dist/core/java-language-service.js");
  const files = new EditorFiles(path.resolve(__dirname, "..", "node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe"));
  const listed = await files.files(source);
  for (const name of listed) {
    const from = path.join(source, name), to = path.join(root, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  const validator = path.join(root, "src/main/java/com/ruoyi/common/xss/XssValidator.java");
  const annotation = path.join(root, "src/main/java/com/ruoyi/common/xss/Xss.java");
  const util = path.join(root, "src/main/java/com/ruoyi/common/utils/StringUtils.java");
  const generator = path.join(root, "src/main/java/com/ruoyi/project/tool/gen/service/GenTableServiceImpl.java");
  const text = fs.readFileSync(validator, "utf8");
  const line = text.split(/\r?\n/);
  const at = (file, lineNumber, column) => ({ textDocument: { uri: pathToFileURL(file).href },
    position: { line: lineNumber - 1, character: column - 1 } });
  const locations = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((item) => item.targetUri || item.uri);
  const events = [];
  const service = new JavaLanguageService({ id: "refsys", name: "refsys", path: root, type: "spring" },
    path.resolve(__dirname, "..", ".local", "editor-runtime"),
    path.resolve(__dirname, "..", ".local", "editor-real-lsp-cache"),
    (method, params) => { if (method === "status" && params.status === "ready") events.push(params); });
  const start = performance.now();
  try {
    await service.start();
    for (const file of [validator, annotation, util, generator]) service.open(file, fs.readFileSync(file, "utf8"));
    const deadline = Date.now() + 240000;
    while (service.status !== "ready" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(service.status, "ready", `JDT import did not finish: ${service.error}`);
    const typeLine = line.findIndex((value) => value.includes("implements ConstraintValidator<Xss")) + 1;
    const typeColumn = line[typeLine - 1].indexOf("<Xss") + 3;
    const type = locations(await service.request("textDocument/definition", at(validator, typeLine, typeColumn)));
    assert(type.includes(pathToFileURL(annotation).href), `annotation definition: ${JSON.stringify(type)}`);
    const useLine = line.findIndex((value) => value.includes("StringUtils.isBlank")) + 1;
    const useColumn = line[useLine - 1].indexOf("isBlank") + 2;
    const inheritedMethod = locations(await service.request("textDocument/definition", at(validator, useLine, useColumn)));
    assert(inheritedMethod.some((uri) => uri.startsWith("jdt://")), `dependency method: ${JSON.stringify(inheritedMethod)}`);
    const dependencySource = await service.request("java/classFileContents", { uri: inheritedMethod[0] });
    assert(typeof dependencySource === "string" && dependencySource.includes("class StringUtils"), "dependency source unavailable");
    const classColumn = line[useLine - 1].indexOf("StringUtils") + 2;
    const utilType = locations(await service.request("textDocument/definition", at(validator, useLine, classColumn)));
    assert(utilType.includes(pathToFileURL(util).href), `utility class definition: ${JSON.stringify(utilType)}`);
    const generatorLines = fs.readFileSync(generator, "utf8").split(/\r?\n/);
    const localCallLine = generatorLines.findIndex((value) => value.includes("StringUtils.isEmpty(dbTableColumns)")) + 1;
    const localCallColumn = generatorLines[localCallLine - 1].indexOf("isEmpty") + 2;
    const localMethod = locations(await service.request("textDocument/definition", at(generator, localCallLine, localCallColumn)));
    assert(localMethod.includes(pathToFileURL(util).href), `local utility overload: ${JSON.stringify(localMethod)}`);
    const annotationLines = fs.readFileSync(annotation, "utf8").split(/\r?\n/);
    const declarationLine = annotationLines.findIndex((value) => value.includes("public @interface Xss")) + 1;
    const declarationColumn = annotationLines[declarationLine - 1].indexOf("Xss") + 2;
    const references = locations(await service.request("textDocument/references", {
      ...at(annotation, declarationLine, declarationColumn), context: { includeDeclaration: false },
    }));
    assert(references.includes(pathToFileURL(validator).href), `annotation reference: ${JSON.stringify(references)}`);
    console.log(JSON.stringify({ sourceFiles: listed.length, indexMs: Math.round(performance.now() - start),
      annotationDefinition: true, utilityTypeDefinition: true, localMethodDefinition: true,
      inheritedDependencyMethod: true, annotationReferences: references.length }));
  } finally {
    await service.stop();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
