import type { EditorDirectoryKind, JavaFileKind } from "../shared/editor-tree";

const javaIcons: Record<JavaFileKind, string> = {
  class: "class", "abstract-class": "classAbstract", interface: "interface",
  enum: "enum", annotation: "annotation", record: "record",
};
const directories: Record<EditorDirectoryKind, string> = {
  folder: "folder", package: "package", source: "sourceRoot", "test-source": "testRoot",
  resources: "resourcesRoot", "test-resources": "testResourcesRoot",
};
const names: Record<string, string> = {
  ".gitignore": "gitignore", ".gitattributes": "config", ".gitmodules": "config",
  ".editorconfig": "editorConfig", ".classpath": "ideaModule", ".project": "ideaModule",
  dockerfile: "docker", "docker-compose.yml": "docker", "compose.yaml": "docker",
  "build.gradle.kts": "gradle", "settings.gradle.kts": "gradle",
  license: "text", changelog: "text", readme: "text",
};
const extensions: Record<string, string> = {
  java: "java", jav: "java", class: "javaClass",
  xml: "xml", xsd: "xml", tld: "xml", xsl: "xml",
  html: "html", htm: "html", xhtml: "html", jsp: "jsp", jspx: "jsp",
  js: "javaScript", mjs: "javaScript", cjs: "javaScript", jsx: "javaScript",
  ts: "typeScript", tsx: "typeScript", mts: "typeScript", cts: "typeScript",
  vue: "xml", wxml: "xml",
  css: "css", scss: "css", sass: "css", less: "css", wxss: "css",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml", toml: "toml",
  properties: "properties", env: "properties", ini: "config", cfg: "config", conf: "config",
  iml: "ideaModule", ipr: "ideaModule",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sql: "sql", csv: "csv", tsv: "csv", http: "http", rest: "http",
  txt: "text", log: "text", rst: "text", patch: "patch", diff: "patch",
  sh: "shell", bash: "shell", zsh: "shell", bat: "shell", cmd: "shell", ps1: "shell",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", ico: "image", bmp: "image",
  jar: "archive", war: "archive", zip: "archive", rar: "archive", gz: "archive", tar: "archive", "7z": "archive",
  bin: "binaryData", dat: "binaryData", exe: "binaryData", dll: "binaryData", so: "binaryData",
  gradle: "gradle", groovy: "groovy",
};
const singleVariant = new Set(["fileTypes/gitignore", "fileTypes/http"]);

export function editorFileIcon(name: string, directory?: boolean, javaKind?: JavaFileKind, directoryKind?: EditorDirectoryKind) {
  const filename = (name.split(/[\\/]/).pop() || name).toLowerCase();
  if (directory) {
    const kind = directoryKind || "folder";
    return "nodes/" + (kind === "folder" && filename === "lib" ? "libraryFolder" : directories[kind]);
  }
  if (javaKind) return "nodes/" + javaIcons[javaKind];
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1) : "";
  return "fileTypes/" + (Object.hasOwn(names, filename) ? names[filename]
    : Object.hasOwn(extensions, extension) ? extensions[extension] : "unknown");
}

export function editorIconUrl(icon: string, dark = false) {
  const suffix = dark && !singleVariant.has(icon) ? "_dark" : "";
  return "./editor-icons/" + icon + suffix + ".svg";
}
