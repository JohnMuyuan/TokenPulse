/** Recoverable synchronous file transaction for provider state and tool configs. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dataFile, dataDir } from './paths';

type Change = { file: string; before: string | null; after: string | null };
type Journal = { version: 1; committed: boolean; files: Change[] };
let allowedFiles: () => string[] = () => [];
let active: Map<string, Change> | null = null;
export function configureConfigFiles(files: () => string[]) { allowedFiles = files; }
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
    if (changes.length) {
      for (const item of changes) backup(item);
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
