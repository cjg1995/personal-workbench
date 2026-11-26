import fs from "node:fs";
import path from "node:path";
import type { Element } from "@xmldom/xmldom";
import type { JavaSourceFolder, JavaSourceKind } from "../shared/editor-tree.js";
import type { ProjectConfig } from "../shared/types.js";
import { ideaJdk, ideaOptions, ideaTomcatHome, readIdeaXml } from "./idea-options.js";
import { atomicWrite, ensureDir, hash, inside } from "./util.js";

type Library = { file: string; test: boolean; exported: boolean };
type ModuleDependency = { name: string; test: boolean; exported: boolean };
type IdeaJavaModule = {
  name: string;
  sources: JavaSourceFolder[];
  libraries: Library[];
  dependencies: ModuleDependency[];
  java?: string;
  languageLevel?: number;
};
export type IdeaJavaLayout = { root: string; modules: IdeaJavaModule[] };
export type JavaRuntime = { name: string; path: string; major: number };

function optional<T>(read: () => T): T | undefined {
  try { return read(); } catch { return; }
}

function directoryEntries(directory: string) {
  return optional(() => fs.readdirSync(directory, { withFileTypes: true })) ?? [];
}

function ideaPath(value: string | null, root: string, moduleDir = root) {
  if (!value) return;
  const resolved = value.replace(/^(?:file|jar):\/\//, "").replace(/!\/.*$/, "")
    .replaceAll("$PROJECT_DIR$", root).replaceAll("$MODULE_DIR$", moduleDir)
    .replaceAll("$USER_HOME$", process.env.USERPROFILE || "").replace(/^\/([a-z]:)/i, "$1");
  if (/\$[^$]+\$/.test(resolved)) return;
  return path.resolve(moduleDir, resolved);
}

function jarFiles(directory: string, recursive = false): string[] {
  return directoryEntries(directory).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) return jarFiles(file, true);
    return entry.isFile() && /\.jar$/i.test(entry.name) && !/-(?:sources?|javadoc)\.jar$/i.test(entry.name) ? [file] : [];
  });
}

function libraryFiles(library: Element, root: string, moduleDir: string) {
  const jarDirectories = new Map<string, boolean>();
  for (const entry of Array.from(library.getElementsByTagName("jarDirectory"))) {
    const dir = ideaPath(entry.getAttribute("url"), root, moduleDir);
    if (dir && entry.getAttribute("type") !== "SOURCES") jarDirectories.set(dir, entry.getAttribute("recursive") === "true");
  }
  const locations = new Set<string>();
  for (const entry of Array.from(library.getElementsByTagName("CLASSES")[0]?.getElementsByTagName("root") ?? [])) {
    const file = ideaPath(entry.getAttribute("url"), root, moduleDir);
    if (file && fs.existsSync(file)) locations.add(file);
  }
  for (const dir of jarDirectories.keys()) locations.add(dir);
  return [...locations].flatMap((file) => jarDirectories.has(file) ? jarFiles(file, jarDirectories.get(file)) : [file]);
}

function librariesIn(paths: string[]) {
  const libraries = new Map<string, Element>();
  for (const file of paths) {
    const doc = optional(() => readIdeaXml(file));
    for (const library of Array.from(doc?.getElementsByTagName("library") ?? [])) {
      const name = library.getAttribute("name");
      if (name) libraries.set(name, library);
    }
  }
  return libraries;
}

function sourceKind(folder: Element): JavaSourceKind {
  switch (folder.getAttribute("type")) {
    case "java-resource": return "resources";
    case "java-test-resource": return "test-resources";
    default: return folder.getAttribute("isTestSource") === "true" ? "test-source" : "source";
  }
}

function languageLevel(value: string | null | undefined) {
  const version = /^JDK_(?:1_)?(\d+)/i.exec(value ?? "")?.[1];
  return version ? Number(version) : undefined;
}

function readTomcatRun(root: string) {
  const paths = path.join(root, ".idea", "runConfigurations");
  const files = [path.join(root, ".idea", "workspace.xml"), ...directoryEntries(paths)
    .filter((file) => file.name.endsWith(".xml")).map((file) => path.join(paths, file.name))];
  return files.flatMap((file) => Array.from(optional(() => readIdeaXml(file))?.getElementsByTagName("configuration") ?? []))
    .find((config) => config.getAttribute("type")?.includes("TomcatRunConfiguration") && config.getAttribute("default") !== "true");
}

export function readIdeaJavaLayout(project: ProjectConfig): IdeaJavaLayout | undefined {
  const root = path.resolve(project.path);
  const nativeFiles = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
  if (nativeFiles.some((file) => fs.existsSync(path.join(root, file)))) return;

  const idea = path.join(root, ".idea");
  const modulesXml = optional(() => readIdeaXml(path.join(idea, "modules.xml")));
  const modulePaths = new Set<string>();
  for (const entry of Array.from(modulesXml?.getElementsByTagName("module") ?? [])) {
    const file = ideaPath(entry.getAttribute("filepath") || entry.getAttribute("fileurl"), root);
    if (file && /\.iml$/i.test(file) && inside(root, file)) modulePaths.add(file);
  }
  if (!modulePaths.size) for (const item of directoryEntries(root)) {
    if (item.isFile() && /\.iml$/i.test(item.name)) modulePaths.add(path.join(root, item.name));
  }
  if (!modulePaths.size) return;

  const projectManager = Array.from(optional(() => readIdeaXml(path.join(idea, "misc.xml")))?.getElementsByTagName("component") ?? [])
    .find((entry) => entry.getAttribute("name") === "ProjectRootManager");
  const projectJdk = projectManager?.getAttribute("project-jdk-name");
  const run = project.type === "tomcat" ? readTomcatRun(root) : undefined;
  const runtimeJdk = run?.getAttribute("ALTERNATIVE_JRE_ENABLED") === "true" ? run.getAttribute("ALTERNATIVE_JRE_PATH") : undefined;
  const settings = optional(() => ideaOptions().root);
  const localLibraries = path.join(idea, "libraries");
  const projectLibraries = librariesIn(directoryEntries(localLibraries)
    .filter((entry) => entry.name.endsWith(".xml")).map((entry) => path.join(localLibraries, entry.name)));
  const globalLibraries = settings ? librariesIn([path.join(settings, "applicationLibraries.xml")]) : new Map<string, Element>();
  const modules: IdeaJavaModule[] = [];
  for (const moduleFile of modulePaths) {
    const module = optional(() => readIdeaXml(moduleFile).documentElement);
    if (!module) continue;
    if (module.getAttribute("external.system.id")) return;
    const moduleDir = path.dirname(moduleFile);
    const manager = Array.from(module.getElementsByTagName("component"))
      .find((entry) => entry.getAttribute("name") === "NewModuleRootManager");
    if (!manager) continue;
    const sources: JavaSourceFolder[] = [];
    for (const source of Array.from(manager.getElementsByTagName("sourceFolder"))) {
      const directory = ideaPath(source.getAttribute("url"), root, moduleDir);
      if (directory && inside(root, directory) && fs.existsSync(directory)) sources.push({ directory, kind: sourceKind(source) });
    }
    if (!sources.length) continue;
    const libraries: Library[] = [];
    const dependencies: ModuleDependency[] = [];
    let moduleJdk: string | null = null;
    for (const entry of Array.from(manager.getElementsByTagName("orderEntry"))) {
      const scope = entry.getAttribute("scope");
      if (scope === "RUNTIME") continue;
      const flags = { test: scope === "TEST", exported: entry.hasAttribute("exported") };
      const type = entry.getAttribute("type");
      const level = entry.getAttribute("level");
      const name = entry.getAttribute("name") || "";
      if (type === "jdk") moduleJdk = entry.getAttribute("jdkName");
      if (type === "module") dependencies.push({ name: entry.getAttribute("module-name") || "", ...flags });
      if (type === "library" && level === "application_server_libraries") {
        const home = project.catalinaHome || (settings && optional(() => ideaTomcatHome(name, settings)));
        if (home) libraries.push(...jarFiles(path.join(home, "lib")).map((file) => ({ file, ...flags })));
      } else {
        const library = type === "module-library" ? entry.getElementsByTagName("library")[0]
          : type === "library" ? (level === "application" ? globalLibraries : projectLibraries).get(name) : undefined;
        if (library) libraries.push(...libraryFiles(library, root, moduleDir).map((file) => ({ file, ...flags })));
      }
    }
    const sdk = moduleJdk || runtimeJdk || projectJdk;
    const java = project.java || (settings && sdk ? optional(() => ideaJdk(sdk, settings)) : undefined);
    const name = path.basename(moduleFile, ".iml");
    modules.push({
      name, sources, libraries, dependencies, java,
      languageLevel: languageLevel(manager.getAttribute("LANGUAGE_LEVEL")) ?? languageLevel(projectManager?.getAttribute("languageLevel")),
    });
  }
  return modules.length ? { root, modules } : undefined;
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function classpathEntry(kind: string, file: string, { test = false, exported = false } = {}) {
  const flags = exported ? ' exported="true"' : "";
  const attributes = test ? '<attributes><attribute name="test" value="true"/></attributes>' : "";
  return '<classpathentry kind="' + kind + '" path="' + xml(file.replaceAll("\\", "/")) + '"' + flags + ">" + attributes + "</classpathentry>";
}

function updateFile(file: string, text: string) {
  if (optional(() => fs.readFileSync(file, "utf8")) !== text) atomicWrite(file, text);
}

export function prepareIdeaJavaWorkspace(layout: IdeaJavaLayout, dataDir: string, runtimes: JavaRuntime[]) {
  const revision = hash(JSON.stringify({ layout, runtimes, schema: 1 })).slice(0, 16);
  const root = ensureDir(path.join(dataDir, "idea-java-projects", revision));
  const names = new Map(layout.modules.map((module, index) => [module.name, "workbench-" + revision + "-" + (index + 1)]));
  for (const module of layout.modules) {
    const name = names.get(module.name)!;
    const dir = ensureDir(path.join(root, name));
    const preferred = module.java && path.basename(module.java).toLowerCase() === "java.exe"
      ? path.dirname(path.dirname(module.java)) : module.java;
    const requested = module.languageLevel && module.languageLevel >= 8 ? module.languageLevel : undefined;
    const runtime = runtimes.find((item) => item.major === requested)
      ?? runtimes.find((item) => preferred && path.resolve(item.path).toLowerCase() === path.resolve(preferred).toLowerCase() && item.major >= 8)
      ?? runtimes.find((item) => requested && item.major >= requested)
      ?? runtimes.find((item) => item.major === 8)
      ?? runtimes.find((item) => item.major >= 8);
    const major = requested ?? runtime?.major ?? 8;
    const level = major === 8 ? "1.8" : String(major);
    const links = module.sources.map((source, index) => {
      const link = "source-" + (index + 1);
      return {
        resource: "<link><name>" + link + "</name><type>2</type><location>" +
          xml(source.directory.replaceAll("\\", "/")) + "</location></link>",
        entry: classpathEntry("src", link, { test: source.kind.startsWith("test-") }),
      };
    });
    const libraries = new Map<string, Library>();
    for (const library of module.libraries) {
      const key = library.file.toLowerCase();
      const prior = libraries.get(key);
      if (!prior) libraries.set(key, { ...library });
      else {
        prior.test &&= library.test;
        prior.exported ||= library.exported;
      }
    }
    const jre = "org.eclipse.jdt.launching.JRE_CONTAINER";
    const container = runtime ? jre + "/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/" + runtime.name : jre;
    const dependencies = module.dependencies.flatMap((item) => {
      const target = names.get(item.name);
      return target && target !== name ? [classpathEntry("src", "/" + target, item)] : [];
    });
    updateFile(path.join(dir, ".project"), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<projectDescription><name>" + name + "</name>",
      "<buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>",
      "<natures><nature>org.eclipse.jdt.core.javanature</nature></natures>",
      "<linkedResources>", ...links.map((link) => link.resource), "</linkedResources></projectDescription>",
    ].join("\n"));
    const classpath = path.join(dir, ".classpath");
    updateFile(classpath, [
      '<?xml version="1.0" encoding="UTF-8"?><classpath>',
      ...links.map((link) => link.entry), ...dependencies,
      classpathEntry("con", container), ...[...libraries.values()].map((entry) => classpathEntry("lib", entry.file, entry)),
      classpathEntry("output", "bin"), "</classpath>",
    ].join("\n"));
    const preferences = ensureDir(path.join(dir, ".settings"));
    updateFile(path.join(preferences, "org.eclipse.jdt.core.prefs"), [
      "eclipse.preferences.version=1",
      "org.eclipse.jdt.core.compiler.source=" + level,
      "org.eclipse.jdt.core.compiler.compliance=" + level,
      "org.eclipse.jdt.core.compiler.codegen.targetPlatform=" + level,
      "",
    ].join("\n"));
  }
  return { root, revision };
}
