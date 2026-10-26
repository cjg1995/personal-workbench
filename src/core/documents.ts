import fs from "node:fs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import type { MonthlyDraft } from "../shared/types.js";
import { sections } from "../shared/types.js";
import { atomicWrite } from "./util.js";
const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export function wordBuffer(template: string, draft: MonthlyDraft) {
  const files = unzipSync(fs.readFileSync(template));
  if (!files["word/document.xml"])
    throw new Error("月报模板不是有效 Word 文件");
  const document = new DOMParser({
    onError: (level) => {
      if (level === "fatalError") throw new Error("模板 XML 无效");
    },
  }).parseFromString(strFromU8(files["word/document.xml"]), "application/xml");
  const slots = new Map<string, any>();
  for (const node of Array.from(document.getElementsByTagNameNS(w, "t"))) {
    const value = node.textContent || "";
    const match = /^\{\{(.+)\}\}$/.exec(value);
    if (match) {
      let p = node.parentNode;
      while (p && p.nodeName !== "w:p") p = p.parentNode;
      if (p) slots.set(match[1], p);
    }
  }
  if (sections.some((s) => !slots.has(s)))
    throw new Error("模板缺少必需章节槽位，请使用随应用提供的空白模板");
  if (!files["word/numbering.xml"])
    throw new Error("模板缺少编号格式，请使用随应用提供的空白模板");
  const workIndent = slots.get("主要工作").getElementsByTagNameNS(w, "ind")[0];
  const numbering = new DOMParser().parseFromString(
    strFromU8(files["word/numbering.xml"]),
    "application/xml",
  );
  let nextId =
    Math.max(
      0,
      ...Array.from(numbering.getElementsByTagNameNS(w, "num")).map((n) =>
        Number(n.getAttribute("w:numId")),
      ),
    ) + 1;
  const abstractId =
    Math.max(
      0,
      ...Array.from(numbering.getElementsByTagNameNS(w, "abstractNum")).map(
        (n) => Number(n.getAttribute("w:abstractNumId")),
      ),
    ) + 1;
  const abstract = numbering.createElementNS(w, "w:abstractNum");
  abstract.setAttribute("w:abstractNumId", String(abstractId));
  const child = (parent: any, tag: string, value?: string) => {
    const element = numbering.createElementNS(w, "w:" + tag);
    if (value !== undefined) element.setAttribute("w:val", value);
    parent.appendChild(element);
    return element;
  };
  child(abstract, "multiLevelType", "singleLevel");
  const level = child(abstract, "lvl");
  level.setAttribute("w:ilvl", "0");
  child(level, "start", "1");
  child(level, "numFmt", "decimal");
  child(level, "lvlText", "%1.");
  child(level, "lvlJc", "left");
  const indent = child(child(level, "pPr"), "ind");
  indent.setAttribute("w:left", "420");
  indent.setAttribute("w:hanging", "420");
  const firstNum = numbering.getElementsByTagNameNS(w, "num")[0];
  numbering.documentElement!.insertBefore(abstract, firstNum || null);
  const write = (prototype: any, text: string, blank = false) => {
    const p = prototype.cloneNode(true);
    const first = prototype.getElementsByTagNameNS(w, "r")[0];
    const rpr = first?.getElementsByTagNameNS(w, "rPr")[0];
    for (const child of Array.from(p.childNodes) as any[])
      if (child.nodeName !== "w:pPr") p.removeChild(child);
    if (blank) {
      const num = p.getElementsByTagNameNS(w, "numPr")[0];
      if (num) num.parentNode.removeChild(num);
    }
    const r = document.createElementNS(w, "w:r");
    if (rpr) r.appendChild(rpr.cloneNode(true));
    text.split(/\r\n|\n|\r/).forEach((line, index) => {
      if (index) r.appendChild(document.createElementNS(w, "w:br"));
      const t = document.createElementNS(w, "w:t");
      t.setAttribute("xml:space", "preserve");
      t.appendChild(document.createTextNode(line));
      r.appendChild(t);
    });
    p.appendChild(r);
    return p;
  };
  const title = slots.get("TITLE");
  if (title) title.parentNode.removeChild(title);
  // Also honor the new layout when an older workbench template is configured.
  for (const table of Array.from(document.getElementsByTagNameNS(w, "tbl"))) {
    if (
      !table.textContent?.trim() &&
      !table.getElementsByTagNameNS(w, "drawing").length
    ) {
      const blank = document.createElementNS(w, "w:p");
      table.parentNode!.replaceChild(blank, table);
    }
  }
  for (const section of sections) {
    const p = slots.get(section);
    const entries = draft.entries.filter(
      (e) => e.section === section && e.text.length > 0,
    );
    const numbered =
      section === "主要工作" ||
      section === "其他" ||
      ((section === "个人学习和成长" || section === "个人工作计划、学习目标") &&
        entries.length > 1);
    let numId: number | undefined;
    if (numbered && entries.length) {
      numId = nextId++;
      const num = child(numbering.documentElement, "num");
      num.setAttribute("w:numId", String(numId));
      child(num, "abstractNumId", String(abstractId));
      const restart = child(num, "lvlOverride");
      restart.setAttribute("w:ilvl", "0");
      child(restart, "startOverride", "1");
    }
    for (const e of entries) {
      const paragraph = write(p, e.text, true);
      if (numId !== undefined) {
        let properties = paragraph.getElementsByTagNameNS(w, "pPr")[0];
        if (!properties) {
          properties = document.createElementNS(w, "w:pPr");
          paragraph.insertBefore(properties, paragraph.firstChild);
        }
        const num = document.createElementNS(w, "w:numPr");
        for (const [tag, value] of [
          ["ilvl", "0"],
          ["numId", String(numId)],
        ]) {
          const element = document.createElementNS(w, "w:" + tag);
          element.setAttribute("w:val", value);
          num.appendChild(element);
        }
        properties.appendChild(num);
        if (
          workIndent &&
          (section === "个人学习和成长" || section === "个人工作计划、学习目标")
        ) {
          const previousIndent = properties.getElementsByTagNameNS(w, "ind")[0];
          const alignedIndent = workIndent.cloneNode(true);
          if (previousIndent)
            properties.replaceChild(alignedIndent, previousIndent);
          else properties.appendChild(alignedIndent);
        }
      }
      p.parentNode.insertBefore(paragraph, p);
    }
    if (!entries.length) p.parentNode.insertBefore(write(p, "", true), p);
    p.parentNode.removeChild(p);
  }
  files["word/document.xml"] = strToU8(
    new XMLSerializer().serializeToString(document),
  );
  files["word/numbering.xml"] = strToU8(
    new XMLSerializer().serializeToString(numbering),
  );
  return zipSync(files, { level: 6 });
}
export function exportWord(
  template: string,
  draft: MonthlyDraft,
  file: string,
) {
  atomicWrite(file, wordBuffer(template, draft));
  return { path: file, bytes: fs.statSync(file).size };
}
