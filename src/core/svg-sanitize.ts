/**
 * 导入的主题包里的 SVG：只留画图用的元素和属性，按白名单重新拼一份。
 *
 * - 自己把 XML 拆成标签 / 文字，再从拆出来的东西重新写出 SVG，原文里没认出来的一律不要；
 * - 不收：脚本、foreignObject、iframe 这类能嵌别的内容的元素（连同里面的东西）、on* 事件属性、
 *   指向外面的链接（href 只能是 #id，<image> 另外允许内嵌的 PNG / GIF / WebP / JPEG）、javascript: / data: 之类的地址、
 *   DOCTYPE 和实体定义（整份不收）；
 * - <style> 和 style 属性里的 CSS：去掉 @import、url(非 #id)、image-set、反斜杠转义和 :host（宠物放在 Shadow DOM 里，不让它改外面）。
 * 桌宠窗口的内容安全策略本来也不让跑脚本、不让连网，这里是第一道。出错时抛出给用户看的中文说明。
 */

const SVG_NS = "http://www.w3.org/2000/svg", XLINK_NS = "http://www.w3.org/1999/xlink";
export const SVG_FILE_MAX = 2 * 1024 * 1024;

const ELEMENTS = new Set([
  "svg", "g", "defs", "style", "title", "desc", "symbol", "use", "switch",
  "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "textPath", "image",
  "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "marker",
  "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
  "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
  "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting",
  "feSpotLight", "feTile", "feTurbulence",
  "animate", "animateTransform", "animateMotion", "set", "mpath",
]);
const ANIMATIONS = new Set(["animate", "animateTransform", "animateMotion", "set"]);
/** 带冒号的属性只认这几个；xmlns 一律去掉，根元素上由这里重新写。 */
const PREFIXED = new Set(["xlink:href", "xml:space", "xml:lang"]);
const LIMITS = { elements: 20000, depth: 100, attribute: 200_000 };
const IMAGE_DATA = /^data:image\/(png|gif|webp|jpeg);base64,[a-z0-9+/=\s]+$/i;

function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&"; if (lower === "lt") return "<"; if (lower === "gt") return ">"; if (lower === "quot") return '"'; if (lower === "apos") return "'";
    const n = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  });
}
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, "&quot;");
/** 比较地址用：去掉空白和控制字符、转小写（防 java\tscript: 这种）。 */
const squash = (text: string) => text.replace(/[\u0000- \u007f]+/g, "").toLowerCase();

/** CSS（<style> 的内容或 style 属性）：去掉能引外部东西、能改到 Shadow DOM 外面的写法。 */
export function sanitizeCss(css: string) {
  // 指向 #id 的 url() 先换成占位符收起来，剩下的 url( 全部废掉，最后放回去
  const local: string[] = [];
  return css
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, "")
    .replace(/[\\\u0000]/g, "")
    .replace(/<\/?\s*style/gi, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/@namespace[^;]*;?/gi, "")
    .replace(/(-webkit-)?image-set\s*\(/gi, "none(")
    .replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (whole, _quote: string, target: string) => {
      if (!/^#[\w-]+$/.test(target.trim())) return "none";
      local.push(`url(${target.trim()})`);
      return `\u0000${local.length - 1}\u0000`;
    })
    .replace(/url\s*\(/gi, "none(")
    .replace(/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/gi, "none")
    .replace(/::?(host|slotted|part)\b/gi, ":not(*)")
    .replace(/\u0000(\d+)\u0000/g, (_whole, n: string) => local[Number(n)] ?? "none");
}

/** 属性值里的 url(...)：只能指向自己文件里的 #id。 */
function urlsLocal(value: string) {
  const re = /url\s*\(\s*(['"]?)\s*([^)'"]*)/gi;
  for (let m = re.exec(value); m; m = re.exec(value)) if (!m[2].trim().startsWith("#")) return false;
  return true;
}

function keepAttr(element: string, name: string, raw: string): string | null {
  if (!/^[A-Za-z_][\w.:-]*$/.test(name) || raw.length > LIMITS.attribute) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith("on") || lower === "xmlns" || lower.startsWith("xmlns:") || lower === "xml:base") return null;
  if (name.includes(":") && !PREFIXED.has(name)) return null;
  const value = decode(raw);
  if (lower === "style") { const css = sanitizeCss(value).trim(); return css || null; }
  const flat = squash(value);
  if (lower === "href" || lower === "xlink:href") {
    if (flat.startsWith("#")) return value;
    return element === "image" && IMAGE_DATA.test(value.trim()) ? value.trim() : null;
  }
  if (/(javascript|vbscript|data):/.test(flat)) return null;
  if (/url\s*\(/i.test(value) && !urlsLocal(value)) return null;
  return value;
}

type Open = { name: string; keep: boolean; out: string[] | null };

/** 拆标签、重新拼。返回消毒后的 SVG 文本；不是 SVG、写坏了、太大就抛错。 */
export function sanitizeSvg(input: string): string {
  if (typeof input !== "string") throw new Error("不是 SVG 文件");
  if (input.length > SVG_FILE_MAX) throw new Error("SVG 超过 2 MB");
  const text = input.replace(/^﻿/, "");
  const stack: Open[] = [];
  let root: string | null = null, rootOpen = false, count = 0, i = 0;
  const top = () => stack[stack.length - 1];
  /** 当前要写到哪：被丢掉的元素里面的东西不写。 */
  const sink = () => { const t = top(); return t && t.keep ? t.out : null; };
  const write = (piece: string) => { const out = sink(); if (out) out.push(piece); };

  while (i < text.length) {
    if (text.startsWith("<!--", i)) { const end = text.indexOf("-->", i + 4); if (end < 0) throw new Error("SVG 里有没写完的注释"); i = end + 3; continue; }
    if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9); if (end < 0) throw new Error("SVG 里有没写完的 CDATA");
      const body = text.slice(i + 9, end);
      write(top()?.name === "style" ? escapeText(sanitizeCss(body)) : escapeText(body));
      i = end + 3; continue;
    }
    if (text.startsWith("<!", i)) throw new Error("SVG 里不能有 DOCTYPE 或实体定义");
    if (text.startsWith("<?", i)) { const end = text.indexOf("?>", i + 2); if (end < 0) throw new Error("SVG 写坏了"); i = end + 2; continue; }
    if (text.startsWith("</", i)) {
      const m = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(text.slice(i, i + 300));
      const open = stack.pop();
      if (!m || !open || open.name !== m[1]) throw new Error("SVG 写坏了（标签没对上）");
      if (open.keep && open.out) {
        const parent = sink();
        const piece = open.out.join("") + `</${open.name}>`;
        if (parent) parent.push(piece);
        else if (!stack.length) root = piece;
      }
      if (!stack.length) rootOpen = false;
      i += m[0].length; continue;
    }
    if (text[i] === "<") {
      const nameMatch = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 200));
      if (!nameMatch) throw new Error("SVG 写坏了");
      const name = nameMatch[1];
      let j = i + nameMatch[0].length;
      const attrs: [string, string][] = [];
      const attrRe = /\s+([^\s=/>"']+)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?)>/y;
      let selfClose = false, closed = false;
      while (j < text.length) {
        attrRe.lastIndex = j;
        const m = attrRe.exec(text);
        if (!m) throw new Error("SVG 写坏了（属性）");
        j = attrRe.lastIndex;
        if (m[1] !== undefined) { attrs.push([m[1], m[3] ?? m[4] ?? ""]); continue; }
        selfClose = m[5] === "/"; closed = true; break;
      }
      if (!closed) throw new Error("SVG 写坏了");
      i = j;
      if (++count > LIMITS.elements) throw new Error("SVG 里的元素太多了");
      if (stack.length >= LIMITS.depth) throw new Error("SVG 嵌套太深了");
      if (!stack.length) {
        if (root !== null || rootOpen) throw new Error("SVG 只能有一个根元素");
        if (name !== "svg") throw new Error("不是 SVG 文件");
        rootOpen = true;
      }
      const parentKeeps = !stack.length || !!sink();
      let keep = parentKeeps && ELEMENTS.has(name);
      const kept: string[] = [];
      if (keep) {
        if (ANIMATIONS.has(name)) {
          const target = attrs.find(([key]) => key === "attributeName")?.[1] ?? "";
          if (/^(on|href$|xlink:href$|style$)/i.test(decode(target).trim())) keep = false;
        }
        for (const [key, raw] of attrs) { const value = keepAttr(name, key, raw); if (value !== null) kept.push(` ${key}="${escapeAttr(value)}"`); }
        if (!stack.length) kept.unshift(` xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}"`);
      }
      const head = `<${name}${kept.join("")}>`;
      if (selfClose) {
        const piece = head + `</${name}>`;
        if (keep) { if (stack.length) write(piece); else root = piece; }
        if (!stack.length) rootOpen = false;
        continue;
      }
      stack.push({ name, keep, out: keep ? [head] : null });
      continue;
    }
    const next = text.indexOf("<", i);
    const raw = text.slice(i, next < 0 ? text.length : next);
    i = next < 0 ? text.length : next;
    if (!stack.length) { if (raw.trim()) throw new Error("SVG 写坏了（根元素外面有文字）"); continue; }
    const value = decode(raw);
    write(top()?.name === "style" ? escapeText(sanitizeCss(value)) : escapeText(value));
  }
  if (stack.length || root === null) throw new Error("SVG 写坏了（没写完）");
  return root;
}
