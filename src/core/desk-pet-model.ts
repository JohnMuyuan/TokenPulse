import type { Snapshot } from "./report";
import type { ActivityState } from "./agent-activity";
import { SOUND_KINDS, type SoundKind } from "./pet-sound-file";

/*
 * 桌宠（0.3.61）里不碰窗口的部分：设置项、宠物跟哪份额度、该干活还是睡觉、窗口和对话气泡放在哪。
 * 窗口本身在 main/desk-pet.ts。
 */

type Rect = { x: number; y: number; width: number; height: number };

export const PET_KINDS = ["squirrel", "hamster", "octopus"] as const;
export const PET_SCALES = [1, 2, 3] as const;
export const PET_EDGES = ["left", "right", "top", "bottom"] as const;
export type PetEdge = typeof PET_EDGES[number];
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
  /** 极简模式：躲在屏幕边后面探头（贴左右边时位置只看 deskPetPos 的高度，贴上下边时只看横向位置）。 */
  deskPetMini: boolean;
  /** 极简模式贴哪条边：left / right / top（倒挂着）/ bottom。 */
  deskPetEdge: PetEdge;
  /** 任务做完、在问你、出错停下、可能在等你、额度用完时响一声提示音。 */
  deskPetSound: boolean;
  /** 提示音音量，0 到 100。 */
  deskPetVolume: number;
  /** 单独关掉的几种提示音（SOUND_KINDS 里的）。 */
  deskPetMute: SoundKind[];
  /** Agent 问你问题（选择题、计划等你批准）时，在屏幕右下角弹出问题卡片。 */
  deskPetAsk: boolean;
};
export const DESK_PET_DEFAULTS: DeskPetPrefs = { deskPet: false, deskPetKind: "squirrel", deskPetScale: 2, deskPetOpacity: 100, deskPetOnTop: true, deskPetAccount: "", deskPetFidget: true, deskPetBadge: true, deskPetPos: null, deskPetMini: false, deskPetEdge: "right", deskPetSound: true, deskPetVolume: 70, deskPetMute: [], deskPetAsk: true };

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
  if ("deskPetMini" in patch) out.deskPetMini = patch.deskPetMini === true;
  if ("deskPetEdge" in patch) out.deskPetEdge = (PET_EDGES as readonly unknown[]).includes(patch.deskPetEdge) ? patch.deskPetEdge as PetEdge : DESK_PET_DEFAULTS.deskPetEdge;
  if ("deskPetSound" in patch) out.deskPetSound = patch.deskPetSound !== false;
  if ("deskPetVolume" in patch) { const value = Math.round(Number(patch.deskPetVolume)); out.deskPetVolume = Number.isFinite(value) ? clamp(value, 0, 100) : DESK_PET_DEFAULTS.deskPetVolume; }
  if ("deskPetMute" in patch) out.deskPetMute = Array.isArray(patch.deskPetMute) ? SOUND_KINDS.filter((kind) => (patch.deskPetMute as unknown[]).includes(kind)) : [];
  if ("deskPetAsk" in patch) out.deskPetAsk = patch.deskPetAsk !== false;
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

/**
 * 在跑的任务这会儿在干嘛（宠物分开表现）：有一个在跑工具就算 tool（打字），都在想就是 thinking，剩下的都在等你就是 waiting。
 * 没有任务在跑返回 null。
 */
export function petPhase(activity: ActivityState | null): "thinking" | "tool" | "waiting" | null {
  const running = activity?.running ?? [];
  for (const status of ["tool", "thinking", "waiting"] as const) if (running.some((task) => task.status === status)) return status;
  return null;
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

/*
 * 极简模式：窗口贴着屏幕可用区域的一条边，宠物像躲在屏幕边后面探头，其余在窗口（也就是屏幕边）外看不见。
 * 平时是 tuck，鼠标移上来换成 peek（桌宠窗口 desk-pet.js 照这个摆）。
 * - 右边：以脚底中点为轴往左歪 tilt 度，探出屏幕的宽度是身宽的 show 倍；左边是右边左右翻过来。
 * - 下边：从屏幕底边冒出上半身，露出身高的 show 倍。
 * - 上边：倒挂金钩，脚勾在屏幕顶边外、头朝下，露出身高的 show 倍，轻轻荡来荡去。
 * 窗口本身一直完整地在这块屏幕里：旁边如果还接着一块屏幕，也不会露到那块屏幕上去。
 */
export const MINI_POSE = { tuck: { tilt: 30, show: 0.55 }, peek: { tilt: 20, show: 0.75 } } as const;
const MINI_POSE_UPDOWN = { top: { tuck: { tilt: 0, show: 0.6 }, peek: { tilt: 0, show: 0.85 } }, bottom: { tuck: { tilt: 0, show: 0.5 }, peek: { tilt: 0, show: 0.8 } } } as const;
/** 贴 edge 这条边时的姿势（发给宠物窗口的 view.mini）。 */
export function miniPose(edge: PetEdge) {
  return { edge, ...(edge === "top" || edge === "bottom" ? MINI_POSE_UPDOWN[edge] : MINI_POSE) };
}
/** 松手时宠物离屏幕左、右、上边不到这么多（或者已经伸出去了）就贴边藏起来。 */
export const MINI_SNAP = 8;
/** 下边不一样：宠物平时就站在屏幕底边上，要往下沉进去身高的这么多才算。 */
export const MINI_SINK = 0.25;
export function miniBounds(anchor: { x: number; y: number } | null, size: { width: number; height: number }, work: Rect, edge: PetEdge = "right"): Rect {
  const normal = petBounds(anchor, size, work);
  if (edge === "left") return { ...normal, x: work.x };
  if (edge === "top") return { ...normal, y: work.y };
  if (edge === "bottom") return { ...normal, y: work.y + work.height - size.height };
  return { ...normal, x: work.x + work.width - size.width };
}
/**
 * 极简模式下宠物画面（sprite 那么大的格子）大约在哪：对话气泡对着它，问题卡片躲着它。按探出来（peek）的样子估：
 * 左右边露出大约半个画面宽；下边露出上半截；上边倒挂着，头在屏幕顶边下面一点。win 是宠物窗口。
 */
export function miniSpriteBox(edge: PetEdge, win: Rect, work: Rect, sprite: { width: number; height: number }): Rect {
  const { width, height } = sprite, middle = Math.round(win.x + (win.width - width) / 2);
  if (edge === "left") return { x: Math.round(work.x - width / 4), y: win.y + win.height - height, width, height };
  if (edge === "bottom") return { x: middle, y: Math.round(work.y + work.height - height * 0.7), width, height };
  if (edge === "top") return { x: middle, y: Math.round(work.y + height * 0.15), width, height };
  return { x: Math.round(work.x + work.width - width * 3 / 4), y: win.y + win.height - height, width, height };
}
/** 窗口放在 bounds 时，宠物伸出（或贴到）了屏幕的哪条边；好几条都是的取伸出去最多的，都没有返回 null。 */
export function edgeReached(bounds: Rect, sprite: { width: number; height: number }, work: Rect): PetEdge | null {
  const center = bounds.x + bounds.width / 2, bottom = bounds.y + bounds.height, top = bottom - sprite.height;
  const over: [PetEdge, number][] = [
    ["right", center + sprite.width / 2 - (work.x + work.width - MINI_SNAP)],
    ["left", work.x + MINI_SNAP - (center - sprite.width / 2)],
    ["top", work.y + MINI_SNAP - top],
    ["bottom", bottom - (work.y + work.height + Math.round(sprite.height * MINI_SINK))],
  ];
  let best: PetEdge | null = null, most = -1;
  for (const [edge, value] of over) if (value >= 0 && value > most) { best = edge; most = value; }
  return best;
}

/** 拖动时记下的窗口位置（t 毫秒）。 */
export type DragSample = { x: number; y: number; t: number };
const FLING_MIN = 0.6, FLING_MAX = 4;
/**
 * 松手那一刻的速度（像素 / 毫秒）：用最后一个点和它之前 40～120 毫秒的那个点算。
 * 松手前已经停了一会儿（最后一次移动离松手超过 80 毫秒）算 0：只是放下，不是甩。速度不到 FLING_MIN 也算 0。
 */
export function releaseVelocity(trail: DragSample[], now: number): { x: number; y: number } {
  const last = trail[trail.length - 1];
  if (!last || now - last.t > 80) return { x: 0, y: 0 };
  const base = [...trail].reverse().find((item) => last.t - item.t >= 40 && last.t - item.t <= 120);
  if (!base) return { x: 0, y: 0 };
  let vx = (last.x - base.x) / (last.t - base.t), vy = (last.y - base.y) / (last.t - base.t);
  const speed = Math.hypot(vx, vy);
  if (speed < FLING_MIN) return { x: 0, y: 0 };
  if (speed > FLING_MAX) { vx *= FLING_MAX / speed; vy *= FLING_MAX / speed; }
  return { x: vx, y: vy };
}
/**
 * 甩出去之后每一帧窗口在哪：每帧乘 0.9 减速，碰到屏幕可用区域的边弹回来（速度剩 45%），慢到 0.05 像素 / 毫秒停下。
 * 用力甩到哪条边（撞上时朝那边还有 0.6 像素 / 毫秒以上）：停在那条边，edge 是哪条（接着贴边藏起来）。
 * box 是窗口左上角能去的范围。
 */
export function flingPath(start: { x: number; y: number }, velocity: { x: number; y: number }, box: { minX: number; maxX: number; minY: number; maxY: number }, frameMs = 16) {
  const points: { x: number; y: number }[] = [];
  let x = clamp(start.x, box.minX, box.maxX), y = clamp(start.y, box.minY, box.maxY), vx = velocity.x, vy = velocity.y, edge: PetEdge | null = null;
  for (let i = 0; i < 150 && Math.hypot(vx, vy) >= 0.05; i++) {
    x += vx * frameMs; y += vy * frameMs;
    if (x >= box.maxX) { x = box.maxX; if (vx > 0.6) edge = "right"; vx = -vx * 0.45; }
    if (x <= box.minX) { x = box.minX; if (vx < -0.6) edge = "left"; vx = -vx * 0.45; }
    if (y >= box.maxY) { y = box.maxY; if (vy > 0.6) edge ??= "bottom"; vy = -vy * 0.45; }
    if (y <= box.minY) { y = box.minY; if (vy < -0.6) edge ??= "top"; vy = -vy * 0.45; }
    vx *= 0.9; vy *= 0.9;
    points.push({ x: Math.round(x), y: Math.round(y) });
    if (edge) break;
  }
  return { points, edge };
}
/** 进出极简模式的抛物线跳：u 从 0 到 1，中间最高处比两头的连线高 arc 像素。 */
export function jumpPoint(from: { x: number; y: number }, to: { x: number; y: number }, u: number, arc: number) {
  const k = clamp(u, 0, 1);
  return { x: Math.round(from.x + (to.x - from.x) * k), y: Math.round(from.y + (to.y - from.y) * k - arc * 4 * k * (1 - k)) };
}
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

/**
 * 问题卡片（Agent 在问你）放在哪：屏幕可用区域的右下角。会挡住宠物（avoid，宠物画出来的那块）就挪到宠物头顶，
 * 头顶放不下放到宠物左边。box 是卡片窗口的大小。
 */
export function askBounds(box: { width: number; height: number }, work: Rect, avoid: Rect | null): Rect {
  const M = 12, GAP = 8;
  const width = Math.min(box.width, work.width - M * 2), height = Math.min(box.height, work.height - M * 2);
  let x = work.x + work.width - width - M, y = work.y + work.height - height - M;
  const hits = (ax: number, ay: number) => !!avoid && ax < avoid.x + avoid.width && ax + width > avoid.x && ay < avoid.y + avoid.height && ay + height > avoid.y;
  if (hits(x, y)) {
    if (avoid!.y - GAP - height >= work.y + M) y = avoid!.y - GAP - height;
    else x = Math.max(work.x + M, avoid!.x - GAP - width);
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
