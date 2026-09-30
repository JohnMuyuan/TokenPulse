/** Recoverable synchronous file transaction for provider state and tool configs. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dataFile, dataDir } from './paths';
import { changeSignature, mergeChanges, recordHistory, type FileChange } from './agent-history';

type Change = { file: string; before: string | null; after: string | null };
type Journal = { version: 1; committed: boolean; files: Change[] };
let allowedFiles: () => string[] = () => [];
let active: Map<string, Change> | null = null;
export function configureConfigFiles(files: () => string[]) { allowedFiles = files; }

/*
 * 0.3.9 保护措施（都在这一个提交点上，所有写工具配置的路径都绕不开）：
 * - 只读保护：打开后拒绝改动工具配置文件；只有「把东西放回去」的操作（关闭路由、退出恢复、还原备份）走 configAllowRestore 放行。
 * - 预览：configPreview 里跑一遍同样的操作，只收集改动、不落盘，给界面显示对比并确认。
 * - 确认：configExpect 记下确认过的改动签名，真正提交时对不上（确认之后文件又变了）就取消。
 * - 历史：每次提交把工具配置文件的前后内容记进 agent-history。
 */
let readOnly: () => boolean = () => false;
let allowRestore = 0;
let preview: FileChange[] | null = null;
let expected: string | null = null;
let reason = '';
export function configureReadOnly(fn: () => boolean) { readOnly = fn; }
export function configReason(text: string) { reason = text; }
export function configExpect(signature: string | null) { expected = signature; }
export function configPreviewing() { return preview !== null; }
export function configAllowRestore<T>(work: () => T): T {
  allowRestore++;
  try { return work(); } finally { allowRestore--; }
}
/** 只收集改动，不写文件。work 可以是异步的（启用路由）；预览期间 agent-switch 不启动 / 停止本地路由。 */
export async function configPreview(work: () => unknown): Promise<FileChange[]> {
  if (preview) throw new Error('另一个预览正在进行');
  preview = [];
  try {
    await work();
    return mergeChanges(preview);
  } finally { preview = null; }
}
const isStore = (file: string) => path.resolve(file) === path.resolve(dataFile('agent-switch.json'));
const journalFile = () => dataFile('agent-config-pending.json');
const raw = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
function checked(file: string) {
  const resolved = path.resolve(file);
  if (!allowedFiles().some(item => path.resolve(item) === resolved)) throw new Error('拒绝修改非供应商配置文件');
  return resolved;
}
function atomicRaw(file: string, value: string | null) {
  if (value === null) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tokenpulse-tmp';
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, value, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function lock() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = dataFile('agent-config.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => { if (raw(file) === String(process.pid)) fs.unlinkSync(file); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(raw(file));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('配置写入锁无效，请先检查其他 TokenPulse 进程');
      let stale = false;
      try { process.kill(pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!stale) throw new Error('其他供应商配置操作正在进行，请稍后重试');
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法取得供应商配置写入锁');
}
function backup(change: Change) {
  if (change.before === null || change.file === path.resolve(dataFile('agent-switch.json'))) return;
  const dir = path.join(dataDir(), 'backups', 'live-first-write');
  const id = crypto.createHash('sha1').update(change.file).digest('hex').slice(0, 12);
  const marker = path.join(dir, id + '.ok');
  if (fs.existsSync(marker)) return;
  atomicRaw(path.join(dir, id + '-' + path.basename(change.file)), change.before);
  atomicRaw(marker, change.file);
}
function recoverLocked() {
  const text = raw(journalFile()); if (text === null) return;
  const journal = JSON.parse(text) as Journal;
  if (journal.version !== 1 || typeof journal.committed !== 'boolean' || !Array.isArray(journal.files) || journal.files.length > 20) throw new Error('供应商恢复日志无效，已停止写入');
  for (const change of journal.files) {
    checked(change.file);
    if (![change.before, change.after].every(value => value === null || typeof value === 'string')) throw new Error('供应商恢复记录无效');
  }
  if (!journal.committed) {
    // Roll back only our bytes; another program's changes always win.
    for (const change of [...journal.files].reverse()) {
      if (raw(change.file) === change.after) atomicRaw(change.file, change.before);
    }
  }
  fs.unlinkSync(journalFile());
}
export function recoverConfig() {
  if (active || !fs.existsSync(journalFile())) return;
  const release = lock(); try { recoverLocked(); } finally { release(); }
}
export function configRead(file: string): string | null {
  file = checked(file);
  if (!active) return raw(file);
  let change = active.get(file);
  if (!change) { const before = raw(file); change = { file, before, after: before }; active.set(file, change); }
  return change.after;
}
export function configWrite(file: string, value: string | null): void {
  if (!active) return configTransaction(() => configWrite(file, value));
  configRead(file); active.get(checked(file))!.after = value;
}
export function configTransaction<T>(work: () => T): T {
  if (active) return work();
  const release = lock();
  try {
    recoverLocked(); active = new Map();
    const result = work();
    const reads = [...active.values()];
    const changes = reads.filter(item => item.before !== item.after);
    for (const item of reads) if (raw(item.file) !== item.before) throw new Error('配置已被其他程序修改，本次操作已取消');
    const tools = changes.filter(item => !isStore(item.file));
    if (preview) { preview.push(...tools.map(item => ({ ...item }))); return result; }
    if (tools.length && readOnly() && !allowRestore) throw new Error('只读保护已开启：TokenPulse 不会改动 Claude / Codex / Grok 的配置文件。需要切换时，先在供应商页关闭只读保护。');
    if (expected !== null && tools.length) {
      const ok = changeSignature(tools) === expected;
      expected = null;
      if (!ok) throw new Error('确认之后配置又有变化，本次没有写入，请重新确认');
    }
    if (changes.length) {
      for (const item of changes) backup(item);
      if (tools.length) recordHistory(reason, tools.map(item => ({ file: item.file, before: item.before, after: item.after })));
      atomicRaw(journalFile(), JSON.stringify({ version: 1, committed: false, files: changes }));
      try {
        for (const item of changes) {
          if (raw(item.file) !== item.before) throw new Error('配置出现并发修改，本次操作已取消');
          atomicRaw(item.file, item.after);
        }
        atomicRaw(journalFile(), JSON.stringify({ version: 1, committed: true, files: changes }));
      } catch (error) {
        try { recoverLocked(); } catch { throw new Error('配置写入失败，自动回滚未完成；恢复日志已保留，请解除占用后重试'); }
        throw error;
      }
      // Once committed, failure to remove the journal is harmless; startup finishes cleanup.
      try { fs.unlinkSync(journalFile()); } catch { /* recovered on next entry */ }
    }
    return result;
  } finally { active = null; release(); }
}
