import fs from "node:fs";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";

const polledDocuments = new Map<string, { source: string; doc: ReturnType<DOMParser["parseFromString"]> }>();

export function readIdeaXml(file: string, slot?: string) {
  const source = fs.readFileSync(file, "utf8");
  const previous = slot && polledDocuments.get(slot);
  if (previous && previous.source === source) return previous.doc;
  const doc = new DOMParser().parseFromString(source, "application/xml");
  // Polling only retains the current workspace of each registered project and the JDK table.
  if (slot) {
    if (source.length <= 256 * 1024) polledDocuments.set(slot, { source, doc });
    else polledDocuments.delete(slot);
  }
  return doc;
}

export function ideaOptions() {
  const base = path.join(process.env.APPDATA || "", "JetBrains");
  if (!fs.existsSync(base)) throw new Error("未找到 IDEA 用户配置");
  const dirs = fs.readdirSync(base).filter((name) => name.startsWith("IntelliJIdea")).sort().reverse();
  const selected = dirs.find((name) =>
    fs.existsSync(path.join(base, name, "options", "javaeeAppServers.xml"))) || dirs[0];
  if (!selected) throw new Error("未找到 IDEA 配置目录");
  return {
    root: path.join(base, selected, "options"),
    system: path.join(process.env.LOCALAPPDATA || "", "JetBrains", selected),
  };
}

export function ideaJdk(name: string, settings = ideaOptions().root) {
  const doc = readIdeaXml(path.join(settings, "jdk.table.xml"), "jdk");
  const entry = Array.from(doc.getElementsByTagName("jdk")).find((jdk) =>
    jdk.getElementsByTagName("name")[0]?.getAttribute("value") === name);
  const home = entry?.getElementsByTagName("homePath")[0]?.getAttribute("value")
    ?.replace("$USER_HOME$", process.env.USERPROFILE || "");
  if (!home || home.includes("$")) throw new Error("无法解析 JDK：" + name);
  return path.join(home, "bin", "java.exe");
}

export function ideaTomcatHome(name: string, settings = ideaOptions().root) {
  const doc = readIdeaXml(path.join(settings, "javaeeAppServers.xml"));
  const server = Array.from(doc.getElementsByTagName("ServerDK")).find((entry) => entry.getAttribute("NAME") === name);
  if (!server) throw new Error("IDEA Tomcat 工具未配置");
  return Array.from(server.getElementsByTagName("option")).find((entry) =>
    entry.getAttribute("name") === "CATALINA_HOME")?.getAttribute("value") || "";
}
