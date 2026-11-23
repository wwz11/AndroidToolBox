/** 项目自行填写的期望键值，与 ADB 读到的实际键值对照。 */

export type Pair = { page: string; usage: string };

export type CodeKind = "empty" | "na" | "value" | "invalid";

export type ParsedCode = {
  kind: CodeKind;
  text: string;
  value: number | null;
};

export type VerdictKind = "match" | "mismatch" | "missing" | "na" | "invalid";

export type Judge = { kind: VerdictKind; label: string };

export type ImportedKey = { name: string; page: string; usage: string };

function isNaToken(raw: string): boolean {
  return /^(?:n\/a|na|none|null|nil|—+|-+|无|空|不适用)$/i.test(raw);
}

export function parseCode(raw: string, slot: "page" | "usage"): ParsedCode {
  const text = raw.trim();
  if (!text) return { kind: "empty", text: "", value: null };
  if (isNaToken(text)) return { kind: "na", text: "N/A", value: null };
  const hex = /^0x([0-9a-f]+)$/i.exec(text) || /^([0-9a-f]{1,4})$/i.exec(text);
  if (!hex) return { kind: "invalid", text, value: null };
  const value = Number.parseInt(hex[1], 16);
  if (!Number.isFinite(value) || value < 0 || value > 0xffff) {
    return { kind: "invalid", text, value: null };
  }
  return { kind: "value", text: formatCode(value, slot), value };
}

export function formatCode(value: number, slot: "page" | "usage"): string {
  if (slot === "page") {
    return `0x${value.toString(16).padStart(2, "0").toUpperCase()}`;
  }
  return `0x${value.toString(16).padStart(4, "0")}`;
}

export function normalizePair(pair: Pair): Pair {
  return {
    page: parseCode(pair.page, "page").text,
    usage: parseCode(pair.usage, "usage").text,
  };
}

function sideState(page: ParsedCode, usage: ParsedCode): "absent" | "value" | "partial" | "invalid" {
  if (page.kind === "invalid" || usage.kind === "invalid") return "invalid";
  const pageValue = page.kind === "value";
  const usageValue = usage.kind === "value";
  const pageAbsent = page.kind === "empty" || page.kind === "na";
  const usageAbsent = usage.kind === "empty" || usage.kind === "na";
  if (pageValue && usageValue) return "value";
  if (pageAbsent && usageAbsent) return "absent";
  return "partial";
}

export function judge(expected: Pair, actual: Pair): Judge {
  const ep = parseCode(expected.page, "page");
  const eu = parseCode(expected.usage, "usage");
  const ap = parseCode(actual.page, "page");
  const au = parseCode(actual.usage, "usage");
  const exp = sideState(ep, eu);
  const act = sideState(ap, au);
  if (exp === "invalid" || act === "invalid" || exp === "partial") {
    return { kind: "invalid", label: exp === "partial" ? "期望值不完整" : "格式错误" };
  }
  if (exp === "absent" && act === "absent") return { kind: "na", label: "不适用" };
  if (act === "absent") {
    if (ap.kind === "empty" && au.kind === "empty") return { kind: "missing", label: "未填写" };
    return { kind: "mismatch", label: "不一致" };
  }
  if (act === "partial") return { kind: "mismatch", label: "未填全" };
  if (exp === "absent") return { kind: "mismatch", label: "不应有值" };
  if (ep.value === ap.value && eu.value === au.value) return { kind: "match", label: "一致" };
  return { kind: "mismatch", label: "不一致" };
}

function codeEqual(a: ParsedCode, b: ParsedCode): boolean {
  if (a.kind === "invalid" || b.kind === "invalid") return false;
  if (a.kind === "value" || b.kind === "value") {
    return a.kind === "value" && b.kind === "value" && a.value === b.value;
  }
  return true;
}

export function samePair(a: Pair, b: Pair): boolean {
  return (
    codeEqual(parseCode(a.page, "page"), parseCode(b.page, "page")) &&
    codeEqual(parseCode(a.usage, "usage"), parseCode(b.usage, "usage"))
  );
}

function isCodeToken(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (isNaToken(text)) return true;
  return /^(?:0x[0-9a-f]{1,4}|[0-9a-f]{1,4})$/i.test(text);
}

function splitColumns(line: string): string[] {
  if (line.includes("\t")) {
    return line.split("\t").map((part) => part.trim()).filter((part) => part !== "");
  }
  if (/[,，]/.test(line)) {
    return line.split(/[,，]/).map((part) => part.trim()).filter((part) => part !== "");
  }
  return line.trim().split(/\s+/).filter(Boolean);
}

function parseLine(line: string): ImportedKey | null {
  const parts = splitColumns(line);
  if (parts.length < 3) return null;
  const usage = parts[parts.length - 1];
  const page = parts[parts.length - 2];
  if (!isCodeToken(page) || !isCodeToken(usage)) return null;
  const name = parts.slice(0, -2).join(" ").trim();
  if (!name) return null;
  const pair = normalizePair({ page, usage });
  return { name, page: pair.page, usage: pair.usage };
}

/** 粘贴文本收成按键。每行必须自带按键名。 */
export function importKeyTable(text: string): { keys: ImportedKey[]; message: string } {
  const keys: ImportedKey[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  let dup = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const row = parseLine(line);
    if (!row) {
      skipped += 1;
      continue;
    }
    const id = row.name.trim().toLowerCase().replace(/\s+/g, "");
    const prev = seen.get(id);
    if (prev !== undefined) {
      keys[prev] = row;
      dup += 1;
      continue;
    }
    seen.set(id, keys.length);
    keys.push(row);
  }
  if (!keys.length) {
    return { keys: [], message: "没有识别到键值行。每行需要「按键名、Page、Usage」。" };
  }
  const parts = [`导入 ${keys.length} 个按键`];
  if (dup) parts.push(`同名已覆盖 ${dup} 行`);
  if (skipped) parts.push(`跳过 ${skipped} 行`);
  return { keys, message: parts.join("，") };
}
