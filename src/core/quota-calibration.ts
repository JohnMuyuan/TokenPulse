import { randomUUID } from "crypto";
import { dataFile, readJson, writeJson } from "./paths";
import { readOfficialAccountStore } from "./accounts";
import { readQuotaHistory } from "./quota-history";
import type { AccountKind } from "./quota";

/**
 * 用户在设置里声明「这个账号只在本机用 Code，不聊天」的账号。
 * 对这些账号，官方已用百分比可以认为全部来自本机 Code：按以前的方式直接用「本机用量 ÷ 已用百分比」折算整窗容量，
 * 不再显示共享额度的说明和校准入口。存在 prefs.json（主进程的设置页写，worker 里直接读）。
 */
export function localOnlyAccounts(): string[] {
  const prefs = readJson<{ localOnlyAccounts?: unknown }>(dataFile("prefs.json"), {});
  return Array.isArray(prefs.localOnlyAccounts) ? prefs.localOnlyAccounts.filter((id): id is string => typeof id === "string" && id.length <= 400) : [];
}

export const CALIBRATION_MS = 60 * 60000;
export const MAX_CALIBRATION_MS = 4 * CALIBRATION_MS;
export const CALIBRATION_GUARD_MS = 10 * 60000;
export type CalibrationSession = { id: string; kind: AccountKind; accountId: string; startAt: number; endAt: number; stoppedAt?: number; discardedAt?: number; confirmedLocalOnly: true };
type Store = { version: 1; sessions: CalibrationSession[] };
const file = () => dataFile("quota-calibrations.json");
export function validCalibration(s: CalibrationSession) {
  return Boolean(s && typeof s.id === "string" && s.id.length <= 100 && ["claude", "chatgpt", "grok"].includes(s.kind) && typeof s.accountId === "string" && s.accountId.startsWith(s.kind + ":") && s.confirmedLocalOnly === true && Number.isFinite(s.startAt) && Number.isFinite(s.endAt) && s.endAt > s.startAt && s.endAt - s.startAt <= MAX_CALIBRATION_MS && (s.stoppedAt == null || Number.isFinite(s.stoppedAt) && s.stoppedAt >= s.startAt && s.stoppedAt <= s.endAt) && (s.discardedAt == null || Number.isFinite(s.discardedAt)));
}
export function readCalibrations(): CalibrationSession[] {
  const stored = readJson<Store | null>(file(), null);
  return stored?.version === 1 && Array.isArray(stored.sessions) ? stored.sessions.filter(validCalibration) : [];
}
export function calibrationEnd(s: CalibrationSession) { return Math.min(s.endAt, s.stoppedAt ?? s.endAt); }
export function calibrationContains(s: CalibrationSession, accountId: string, from: number, to: number, now: number) {
  return validCalibration(s) && !s.discardedAt && s.accountId === accountId && s.startAt <= now && from >= s.startAt + CALIBRATION_GUARD_MS && to <= Math.min(calibrationEnd(s), now) && to > from;
}
export function calibrationStatus(kind: AccountKind, accountId: string, now = Date.now()) {
  const sessions = readCalibrations().filter(s => s.kind === kind && s.accountId === accountId && s.endAt >= now - 30 * 86400000).sort((a, b) => b.startAt - a.startAt);
  return { sessions, active: sessions.find(s => !s.discardedAt && !s.stoppedAt && s.startAt <= now && now < s.endAt) ?? null, guardMinutes: 10, durationMinutes: 60 };
}
/** 时间由主进程决定，不能提交历史时间来把旧混用数据批量标成“本机专用”。 */
export function updateCalibration(value: unknown, now = Date.now()) {
  const q = value as { kind: AccountKind; accountId: string; action: "start" | "finish" | "discard"; sessionId?: string; confirmedLocalOnly?: boolean; durationMinutes?: number };
  if (!q || !["chatgpt", "claude", "grok"].includes(q.kind) || typeof q.accountId !== "string" || q.accountId.length > 300 || !q.accountId.startsWith(q.kind + ":") || !["start", "finish", "discard"].includes(q.action)) throw new Error("校准参数无效。");
  const store = readOfficialAccountStore(), account = store.accounts.find(a => a.kind === q.kind && a.id === q.accountId);
  if (account?.hidden || store.removed?.includes(q.accountId) || (!account && !(readQuotaHistory().accounts[q.kind] || []).some(s => s.account === q.accountId))) throw new Error("找不到可校准的账号。");
  const sessions = readCalibrations();
  if (q.action === "start") {
    const duration = q.durationMinutes ?? 60;
    if (![60, 120, 240].includes(duration)) throw new Error("校准时长只能选择 1、2 或 4 小时。");
    if (q.confirmedLocalOnly !== true) throw new Error("请先确认校准期间只使用该账号的本机 Code。");
    if (sessions.some(s => s.accountId === q.accountId && !s.discardedAt && !s.stoppedAt && s.endAt > now)) throw new Error("该账号已有进行中的校准。");
    sessions.push({ id: randomUUID(), kind: q.kind, accountId: q.accountId, startAt: now, endAt: now + duration * 60000, confirmedLocalOnly: true });
  } else {
    const selected = sessions.find(s => s.id === q.sessionId && s.kind === q.kind && s.accountId === q.accountId);
    if (!selected) throw new Error("找不到该账号的校准记录。");
    if (q.action === "discard") selected.discardedAt = now;
    else { if (selected.stoppedAt || selected.discardedAt || selected.endAt <= now) throw new Error("本段校准已结束。"); selected.stoppedAt = now; }
  }
  writeJson(file(), { version: 1, sessions: sessions.sort((a, b) => b.startAt - a.startAt).slice(0, 200) });
  return calibrationStatus(q.kind, q.accountId, now);
}
export function forgetCalibrations(accountId: string) { const sessions = readCalibrations(); if (sessions.some(s => s.accountId === accountId)) writeJson(file(), { version: 1, sessions: sessions.filter(s => s.accountId !== accountId) }); }
