import type { Snapshot } from "./report";
import type { ActivityState } from "./agent-activity";

/*
 * 桌宠（0.3.61）里不碰窗口的部分：设置项、宠物跟哪份额度、该干活还是睡觉、窗口和对话气泡放在哪。
 * 窗口本身在 main/desk-pet.ts。
 */

type Rect = { x: number; y: number; width: number; height: number };

export const PET_KINDS = ["squirrel", "hamster", "octopus"] as const;
export const PET_SCALES = [1, 2, 3] as const;
export type DeskPetPrefs = {
  /** 显示桌宠。默认关。 */
  deskPet: boolean;
  /** squirrel / hamster / octopus，或导入的自定义宠物 id（pet-xxxxxxxx）。 */
  deskPetKind: string;
  /** 像素放大倍数：1 小、2 中、3 大。 */
  deskPetScale: number;
  /** 不透明度，30 到 100。 */
  deskPetOpacity: number;
  deskPetOnTop: boolean;
  /** 额度跟哪个账号；空 = 跟着正在用的账号（见 pickPetAccount）。 */
  deskPetAccount: string;
  /** 空闲时随机做小动作。 */
  deskPetFidget: boolean;
  /** 自定义宠物旁边显示额度和任务数的小标签。 */
  deskPetBadge: boolean;
  /** 宠物脚下中点的屏幕坐标；null = 主屏右下角。 */
  deskPetPos: { x: number; y: number } | null;
};
export const DESK_PET_DEFAULTS: DeskPetPrefs = { deskPet: false, deskPetKind: "squirrel", deskPetScale: 2, deskPetOpacity: 100, deskPetOnTop: true, deskPetAccount: "", deskPetFidget: true, deskPetBadge: true, deskPetPos: null };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export const PACK_ID = /^pet-[a-f0-9]{8}$/;

/** 设置页送来的值收成合法的；不认识的字段不动。 */
export function normalizeDeskPet(patch: Record<string, unknown>): Partial<DeskPetPrefs> {
  const out: Partial<DeskPetPrefs> = {};
  if ("deskPet" in patch) out.deskPet = patch.deskPet === true;
  if ("deskPetKind" in patch) { const kind = patch.deskPetKind; out.deskPetKind = typeof kind === "string" && ((PET_KINDS as readonly string[]).includes(kind) || PACK_ID.test(kind)) ? kind : DESK_PET_DEFAULTS.deskPetKind; }
  if ("deskPetScale" in patch) { const scale = Number(patch.deskPetScale); out.deskPetScale = (PET_SCALES as readonly number[]).includes(scale) ? scale : DESK_PET_DEFAULTS.deskPetScale; }
  if ("deskPetOpacity" in patch) { const value = Math.round(Number(patch.deskPetOpacity)); out.deskPetOpacity = Number.isFinite(value) ? clamp(value, 30, 100) : 100; }
  if ("deskPetOnTop" in patch) out.deskPetOnTop = patch.deskPetOnTop !== false;
  if ("deskPetAccount" in patch) out.deskPetAccount = typeof patch.deskPetAccount === "string" && patch.deskPetAccount.length <= 400 ? patch.deskPetAccount : "";
  if ("deskPetFidget" in patch) out.deskPetFidget = patch.deskPetFidget !== false;
  if ("deskPetBadge" in patch) out.deskPetBadge = patch.deskPetBadge !== false;
  if ("deskPetPos" in patch) {
    const pos = patch.deskPetPos as { x?: unknown; y?: unknown } | null;
    const x = Number(pos?.x), y = Number(pos?.y);
    out.deskPetPos = pos && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 100_000 && Math.abs(y) < 100_000 ? { x: Math.round(x), y: Math.round(y) } : null;
  }
  return out;
}

type Account = Snapshot["accounts"][number];
export type PetMood = "ok" | "tight" | "empty";
export type PetQuota = { quota: number | null; mood: PetMood; account: string; accountId: string };
export const accountKey = (account: Account) => account.key || account.accountId || account.kind;

/**
 * 现在在用哪个工具、各家 CLI 当前登录的是哪个账号（账号 id，和额度报告的 accountId 对得上）。
 * kinds 按优先顺序：有任务在跑的工具在前，然后是刚做完任务的、再之前用过的。
 */
export type PetUsing = { kinds: Account["kind"][]; current: Partial<Record<Account["kind"], string>> };

/**
 * 宠物跟哪个账号：指定了就用指定的；没指定（或指定的没有额度数据）跟着正在用的——
 * 按 kinds 的顺序找那家 CLI 当前登录的账号，没登录的取那家第一个；都不知道就用排第一的账号（也优先它那家当前登录的）。
 */
export function pickPetAccount(accounts: Account[], pick: string, using: PetUsing = { kinds: [], current: {} }): Account | undefined {
  const list = accounts.filter((account) => account.five || account.week);
  const chosen = pick ? list.find((item) => accountKey(item) === pick) : undefined;
  if (chosen) return chosen;
  const ofKind = (kind: Account["kind"]) => list.find((item) => item.kind === kind && !!using.current[kind] && item.accountId === using.current[kind]) ?? list.find((item) => item.kind === kind);
  for (const kind of using.kinds) { const hit = ofKind(kind); if (hit) return hit; }
  return list[0] ? ofKind(list[0].kind) : undefined;
}

/** 宠物跟的额度。剩余 = 100 − 两个窗口里用得多的那个；用完是 empty，压力高或剩不到 15% 是 tight。 */
export function petQuota(snapshot: Snapshot | null, pick: string, title: (account: Account) => string, using?: PetUsing): PetQuota {
  const account = pickPetAccount(snapshot?.accounts ?? [], pick, using);
  if (!account) return { quota: null, mood: "ok", account: "", accountId: "" };
  const windows = [account.five, account.week].filter((item): item is NonNullable<typeof item> => !!item);
  const quota = Math.round(100 - Math.max(...windows.map((item) => clamp(item.used, 0, 100))));
  const mood: PetMood = quota <= 0 ? "empty" : windows.some((item) => item.pressure === "high") || quota < 15 ? "tight" : "ok";
  return { quota, mood, account: title(account), accountId: accountKey(account) };
}

/** 电脑这么久没人动、也没有任务在跑：宠物去睡觉。 */
export const SLEEP_AFTER_SECONDS = 5 * 60;
export function petMode(activity: ActivityState | null, idleSeconds: number): "idle" | "work" | "sleep" {
  if (activity?.running.length) return "work";
  return idleSeconds >= SLEEP_AFTER_SECONDS ? "sleep" : "idle";
}

export const GRID = { width: 72, height: 56 };
/** 宠物上方留给悬停提示的高度。 */
const HINT_SPACE = 30;
export function petWindowSize(scale: number) {
  return { width: Math.max(GRID.width * scale + 24, 240), height: GRID.height * scale + HINT_SPACE };
}
/** anchor 是宠物脚下的中点；返回窗口的位置，整个窗口留在这块屏幕的可用区域里。没有 anchor 放在右下角。 */
export function petBounds(anchor: { x: number; y: number } | null, size: { width: number; height: number }, work: Rect): Rect {
  const at = anchor ?? { x: work.x + work.width - Math.round(size.width / 2) - 12, y: work.y + work.height - 4 };
  return {
    x: clamp(Math.round(at.x - size.width / 2), work.x, work.x + work.width - size.width),
    y: clamp(Math.round(at.y - size.height), work.y, work.y + work.height - size.height),
    width: size.width, height: size.height,
  };
}
export const anchorOf = (bounds: Rect) => ({ x: Math.round(bounds.x + bounds.width / 2), y: bounds.y + bounds.height });
/** 对话气泡外沿留给像素描边和投影的宽度、尾巴的长度（都是 CSS 像素，desk-pet-bubble.css 照这个画）。 */
export const BUBBLE_EDGE = 6, BUBBLE_TAIL = 12;
export type BubblePlace = Rect & { side: "down" | "left" | "right"; at: number };
/**
 * 对话气泡放在哪：box 是气泡本身（不含描边、尾巴）的大小。默认在宠物头顶，尾巴朝下指着宠物；
 * 上面放不下（宠物贴着屏幕顶）就放到右边，右边也放不下放左边，尾巴朝宠物。
 * side 是尾巴长在气泡的哪条边上（气泡在宠物右边时尾巴在左边）；at 是尾巴在窗口里的位置（down 时是 x，left / right 时是 y）。
 */
export function bubbleBounds(pet: Rect, sprite: { width: number; height: number }, box: { width: number; height: number }, work: Rect): BubblePlace {
  const M = 4;
  const left = pet.x + (pet.width - sprite.width) / 2, right = left + sprite.width, top = pet.y + pet.height - sprite.height, center = left + sprite.width / 2;
  const width = Math.min(box.width + BUBBLE_EDGE * 2, work.width - M * 2), height = Math.min(box.height + BUBBLE_EDGE * 2 + BUBBLE_TAIL, work.height - M * 2);
  const tipY = top + Math.round(sprite.height * 0.15);
  if (tipY - height >= work.y + M) {
    const x = Math.round(clamp(center - width / 2, work.x + M, work.x + work.width - width - M));
    return { x, y: Math.round(tipY - height), width, height, side: "down", at: Math.round(clamp(center - x, BUBBLE_EDGE + 12, width - BUBBLE_EDGE - 12)) };
  }
  const sideWidth = Math.min(box.width + BUBBLE_EDGE * 2 + BUBBLE_TAIL, work.width - M * 2), sideHeight = Math.min(box.height + BUBBLE_EDGE * 2, work.height - M * 2);
  const headY = top + sprite.height * 0.35;
  const y = Math.round(clamp(headY - sideHeight / 2, work.y + M, work.y + work.height - sideHeight - M));
  const at = Math.round(clamp(headY - y, BUBBLE_EDGE + 10, sideHeight - BUBBLE_EDGE - 10));
  const toRight = right - sprite.width * 0.1;
  if (toRight + sideWidth <= work.x + work.width - M) return { x: Math.round(toRight), y, width: sideWidth, height: sideHeight, side: "left", at };
  const x = Math.round(clamp(left + sprite.width * 0.1 - sideWidth, work.x + M, work.x + work.width - sideWidth - M));
  return { x, y, width: sideWidth, height: sideHeight, side: "right", at };
}
