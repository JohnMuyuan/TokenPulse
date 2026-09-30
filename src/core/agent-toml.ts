import { parseTOML, getStaticTOMLValue, type AST } from "toml-eslint-parser";

export type Block = { header: string | null; lines: string[]; eol?: string };
const keys = (node: AST.TOMLKey) => node.keys.map(key => key.type === "TOMLBare" ? key.name : key.value);
export function parseToml(text: string): Block[] {
  const ast = parseTOML(text);
  const tables = ast.body[0].body.filter((node): node is AST.TOMLTable => node.type === "TOMLTable");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const blocks: Block[] = [{ header: null, lines: text.slice(0, tables[0]?.range[0] ?? text.length).split(/\r?\n/), eol }];
  tables.forEach((table, index) => {
    const end = tables[index + 1]?.range[0] ?? text.length;
    const newline = text.indexOf("\n", table.range[0]);
    const headerEnd = newline < 0 || newline >= end ? end : newline;
    blocks.push({ header: text.slice(table.range[0], headerEnd).replace(/\r$/, ""), lines: text.slice(headerEnd < end ? headerEnd + 1 : end, end).split(/\r?\n/), eol });
  });
  return blocks;
}
export const tableName = (...parts: string[]) => parts.map(key => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)).join(".");
export function headerName(header: string) {
  const node = parseTOML(header + "\n").body[0].body[0];
  if (node?.type !== "TOMLTable" || node.kind !== "standard") return "";
  return tableName(...keys(node.key));
}
export function stringifyToml(blocks: Block[]) {
  const eol = blocks[0]?.eol || "\n";
  let text = "";
  for (const block of blocks) {
    if (block.header) { if (text && !text.endsWith("\n")) text += eol; text += block.header + eol; }
    text += block.lines.join(eol);
  }
  parseTOML(text); // Validate the full result before any file is staged.
  return text;
}
function entry(lines: string[], key: string) {
  const text = lines.join("\n");
  const node = parseTOML(text).body[0].body.find((item): item is AST.TOMLKeyValue => item.type === "TOMLKeyValue" && keys(item.key).length === 1 && keys(item.key)[0] === key);
  return { text, node };
}
export function upsertKey(lines: string[], key: string, value: string | null) {
  const { text, node } = entry(lines, key);
  if (!node && value === null) return;
  let next: string;
  if (node) { const range = value === null ? node.range : node.value.range; next = text.slice(0, range[0]) + (value ?? "") + text.slice(range[1]); }
  else next = text + (text && !text.endsWith("\n") ? "\n" : "") + (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)) + " = " + value + "\n";
  parseTOML(next);
  lines.splice(0, lines.length, ...next.split("\n"));
}
export function readValue(lines: string[], key: string): unknown {
  const { node } = entry(lines, key); return node ? getStaticTOMLValue(node.value) : undefined;
}
export function readKey(lines: string[], key: string) {
  const value = readValue(lines, key); return value === undefined ? null : String(value);
}
export function replaceTable(blocks: Block[], name: string, body: string[] | null) {
  const found = blocks.findIndex(block => block.header && headerName(block.header) === name);
  if (found >= 0) blocks.splice(found, 1);
  if (body) blocks.push({ header: '[' + name + ']', lines: [...body, ''] });
}
export function setTableKey(blocks: Block[], name: string, key: string, value: string | null) {
  let block = blocks.find(item => item.header && headerName(item.header) === name);
  if (!block && value !== null) { block = { header: '[' + name + ']', lines: [] }; blocks.push(block); }
  if (block) upsertKey(block.lines, key, value);
}
export function quote(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error("配置值类型不正确");
  return JSON.stringify(value);
}
export function unquote(value: string) { try { return String(getStaticTOMLValue(parseTOML('value = ' + value))['value']); } catch { return value; } }

/** Reverse only fields that still equal our last write; leave unrelated changes intact. */
export function restoreToml(current: string, before: string, after: string) {
  const original = parseToml(before), written = parseToml(after), live = parseToml(current);
  const blockName = (b: Block) => b.header ? headerName(b.header) : '';
  const entries = (b?: Block) => {
    const result = new Map<string, { raw: string; value: unknown }>();
    if (!b) return result;
    const text = b.lines.join('\n');
    for (const node of parseTOML(text).body[0].body) {
      if (node.type !== 'TOMLKeyValue') continue;
      if (keys(node.key).length !== 1) continue; // Dotted settings are not fields that our writer owns.
      result.set(keys(node.key)[0], { raw: text.slice(...node.value.range), value: getStaticTOMLValue(node.value) });
    }
    return result;
  };
  for (const name of new Set([...original, ...written].map(blockName))) {
    const b = entries(original.find(item => blockName(item) === name));
    const a = entries(written.find(item => blockName(item) === name));
    let liveBlock = live.find(item => blockName(item) === name);
    const c = entries(liveBlock);
    for (const key of new Set([...b.keys(), ...a.keys()])) {
      if (JSON.stringify(b.get(key)?.value) === JSON.stringify(a.get(key)?.value)) continue;
      if (JSON.stringify(c.get(key)?.value) !== JSON.stringify(a.get(key)?.value)) continue;
      if (!liveBlock) { liveBlock = { header: name ? '[' + name + ']' : null, lines: [] }; live.push(liveBlock); }
      upsertKey(liveBlock.lines, key, b.get(key)?.raw ?? null);
    }
    if (name && !original.some(item => blockName(item) === name) && liveBlock && !entries(liveBlock).size) live.splice(live.indexOf(liveBlock), 1);
  }
  return stringifyToml(live);
}
