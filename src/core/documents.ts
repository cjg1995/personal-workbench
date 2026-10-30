import fs from "node:fs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import type { MonthlyDraft, MonthlyImage } from "../shared/types.js";
import { sections } from "../shared/types.js";
import { atomicWrite } from "./util.js";
const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const wp = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const a = "http://schemas.openxmlformats.org/drawingml/2006/main";
const pic = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ct = "http://schemas.openxmlformats.org/package/2006/content-types";
const rel = "http://schemas.openxmlformats.org/package/2006/relationships";
const emuPerPixel = 9525;
const emuPerTwip = 635;
/** 按图片像素与本页可用宽高等比缩放，避免超宽或超出一页。 */
function pictureSize(document: any, image: MonthlyImage) {
  const section = document.getElementsByTagNameNS(w, "sectPr")[0];
  const page = section?.getElementsByTagNameNS(w, "pgSz")[0];
  const margin = section?.getElementsByTagNameNS(w, "pgMar")[0];
  const twips = (element: any, name: string, fallback: number) => {
    const value = Number(element?.getAttribute("w:" + name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const width =
    (twips(page, "w", 11906) -
      twips(margin, "left", 1800) -
      twips(margin, "right", 1800)) *
    emuPerTwip;
  const height =
    (twips(page, "h", 16838) -
      twips(margin, "top", 1440) -
      twips(margin, "bottom", 1440)) *
    emuPerTwip *
    0.92;
  const naturalWidth = image.width * emuPerPixel,
    naturalHeight = image.height * emuPerPixel;
  const scale = Math.min(1, width / naturalWidth, height / naturalHeight);
  return {
    cx: Math.max(1, Math.round(naturalWidth * scale)),
    cy: Math.max(1, Math.round(naturalHeight * scale)),
  };
}
/** 在「一、工作成果」标题下（原截图空行位置）插入截图段落。 */
function insertPictures(
  document: any,
  files: Record<string, Uint8Array>,
  images: MonthlyImage[],
  slots: Map<string, any>,
) {
  const contentTypes = new DOMParser().parseFromString(
    strFromU8(files["[Content_Types].xml"]),
    "application/xml",
  );
  const target = "word/_rels/document.xml.rels";
  const relationships = files[target]
    ? new DOMParser().parseFromString(strFromU8(files[target]), "application/xml")
    : new DOMParser().parseFromString(
        `<Relationships xmlns="${rel}"/>`,
        "application/xml",
      );
  let nextRid =
    Math.max(
      0,
      ...Array.from(relationships.getElementsByTagName("Relationship")).map(
        (node: any) => Number((node.getAttribute("Id") || "").slice(3)) || 0,
      ),
    ) + 1;
  let nextDocId =
    Math.max(
      0,
      ...Array.from(
        document.getElementsByTagNameNS(wp, "docPr"),
      ).map((node: any) => Number(node.getAttribute("id")) || 0),
    ) + 1;
  // 模板里「一、工作成果」下的空行就是截图位置：用图占位，导出后不再多留空行。
  let anchor: any = slots.get(sections[0]),
    blank: any = null,
    cursor = anchor.previousSibling,
    depth = 0;
  while (cursor && depth < 3) {
    if (cursor.nodeName === "w:p") {
      depth++;
      if (cursor.getElementsByTagNameNS(w, "drawing").length) break;
      anchor = cursor;
      if (!(cursor.textContent || "").trim()) {
        blank = cursor;
        break;
      }
    }
    cursor = cursor.previousSibling;
  }
  for (const [index, image] of images.entries()) {
    const extension = image.mime === "image/jpeg" ? "jpeg" : "png";
    const known = Array.from(contentTypes.getElementsByTagName("Default")).some(
      (node: any) =>
        (node.getAttribute("Extension") || "").toLowerCase() === extension,
    );
    if (!known) {
      const entry = contentTypes.createElementNS(ct, "Default");
      entry.setAttribute("Extension", extension);
      entry.setAttribute("ContentType", image.mime);
      const types = contentTypes.documentElement!;
      types.insertBefore(entry, types.firstChild);
    }
    const media = `word/media/monthly-${index + 1}.${extension}`;
    files[media] = new Uint8Array(Buffer.from(image.data, "base64"));
    const relationship = relationships.createElementNS(rel, "Relationship");
    relationship.setAttribute("Id", "rId" + nextRid);
    relationship.setAttribute(
      "Type",
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    );
    relationship.setAttribute("Target", media.slice("word/".length));
    relationships.documentElement!.appendChild(relationship);
    const { cx, cy } = pictureSize(document, image);
    const element = (namespace: string, tag: string, parent: any) => {
      const node = document.createElementNS(namespace, tag);
      parent.appendChild(node);
      return node;
    };
    const paragraph = document.createElementNS(w, "w:p");
    const properties = element(w, "w:pPr", paragraph);
    element(w, "w:spacing", properties).setAttribute("w:after", "120");
    element(w, "w:jc", properties).setAttribute("w:val", "center");
    const run = element(w, "w:r", paragraph);
    const drawing = element(w, "w:drawing", run);
    const inline = element(wp, "wp:inline", drawing);
    for (const [name, value] of [
      ["distT", "0"],
      ["distB", "0"],
      ["distL", "0"],
      ["distR", "0"],
    ])
      inline.setAttribute(name, value);
    const extentMark = element(wp, "wp:extent", inline);
    extentMark.setAttribute("cx", String(cx));
    extentMark.setAttribute("cy", String(cy));
    const effect = element(wp, "wp:effectExtent", inline);
    for (const name of ["l", "t", "r", "b"]) effect.setAttribute(name, "0");
    const docPr = element(wp, "wp:docPr", inline);
    docPr.setAttribute("id", String(nextDocId++));
    docPr.setAttribute("name", `工作内容汇总截图${index + 1}`);
    docPr.setAttribute("descr", image.name || "工作内容汇总截图");
    const lock = element(wp, "wp:cNvGraphicFramePr", inline);
    element(a, "a:graphicFrameLocks", lock).setAttribute("noChangeAspect", "1");
    const graphic = element(a, "a:graphic", inline);
    const data = element(a, "a:graphicData", graphic);
    data.setAttribute(
      "uri",
      "http://schemas.openxmlformats.org/drawingml/2006/picture",
    );
    const picture = element(pic, "pic:pic", data);
    const nonVisual = element(pic, "pic:nvPicPr", picture);
    const canvas = element(pic, "pic:cNvPr", nonVisual);
    canvas.setAttribute("id", String(index + 1));
    canvas.setAttribute("name", `monthly-${index + 1}.${extension}`);
    element(pic, "pic:cNvPicPr", nonVisual);
    const fill = element(pic, "pic:blipFill", picture);
    const blip = element(a, "a:blip", fill);
    blip.setAttributeNS(r, "r:embed", "rId" + nextRid);
    const stretch = element(a, "a:stretch", fill);
    element(a, "a:fillRect", stretch);
    const shape = element(pic, "pic:spPr", picture);
    const transform = element(a, "a:xfrm", shape);
    const offset = element(a, "a:off", transform);
    offset.setAttribute("x", "0");
    offset.setAttribute("y", "0");
    const extent = element(a, "a:ext", transform);
    extent.setAttribute("cx", String(cx));
    extent.setAttribute("cy", String(cy));
    const geometry = element(a, "a:prstGeom", shape);
    geometry.setAttribute("prst", "rect");
    element(a, "a:avLst", geometry);
    nextRid++;
    anchor.parentNode.insertBefore(paragraph, anchor);
  }
  if (blank?.parentNode) blank.parentNode.removeChild(blank);
  files["[Content_Types].xml"] = strToU8(
    new XMLSerializer().serializeToString(contentTypes),
  );
  files[target] = strToU8(
    new XMLSerializer().serializeToString(relationships),
  );
}
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
  if (draft.images?.length) insertPictures(document, files, draft.images, slots);
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
