import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { dataFile } from '../core/paths';
import { concurrencyMonitor, type ConcurrencyAlert, type ConcurrencyBucket, type ConcurrencyMetric, type ConcurrencyState, type ConcurrencyHistory, type ConcurrencyHistoryPoint, validateConcurrencySettings } from '../core/concurrency';

/** Persistence and scheduling stay outside the proxy so network lifecycle
 * changes never wait for a disk scan or renderer. */
export class ConcurrencyService {
  private timer?: NodeJS.Timeout;
  private publishTimer?: NodeJS.Timeout;
  private notifyTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private pendingAlerts = new Map<string, ConcurrencyAlert>();
  private lastPrune = 0;
  private started = false;
  private failure = '';
  private settingsFailure = '';
  private lastPublished = 0;
  constructor(private callbacks: { publish: () => void; notify: (alerts: ConcurrencyAlert[]) => void }) {}
  private directory() { return dataFile('concurrency-history'); }
  start() {
    if (this.started) return; this.started = true;
    try {
      const file = dataFile('concurrency-settings.json');
      if (fs.existsSync(file)) concurrencyMonitor.configure(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { this.settingsFailure = '并发监控设置读取失败'; }
    concurrencyMonitor.attach(bucket => this.append(bucket), alerts => {
      for (const alert of alerts) this.pendingAlerts.set(`${alert.scope}/${alert.metric}`, alert);
      this.notifyTimer ??= setTimeout(() => { this.notifyTimer = undefined; const pending = [...this.pendingAlerts.values()]; this.pendingAlerts.clear(); this.callbacks.notify(pending); }, 250);
    });
    this.unsubscribe = concurrencyMonitor.subscribe(() => this.queuePublish());
    this.timer = setInterval(() => {
      concurrencyMonitor.tick();
      this.queuePublish();
      if (Date.now() - this.lastPrune > 3600_000) this.prune();
    }, 1000);
    concurrencyMonitor.tick(); this.prune();
  }
  private queuePublish() {
    this.publishTimer ??= setTimeout(() => { this.publishTimer = undefined; this.lastPublished = Date.now(); this.callbacks.publish(); }, Math.max(0, 250 - (Date.now() - this.lastPublished)));
  }
  state(): ConcurrencyState & { storageError: string } { return { ...concurrencyMonitor.snapshot(), storageError: [this.settingsFailure, this.failure].filter(Boolean).join(' · ') }; }
  save(value: unknown) {
    const settings = validateConcurrencySettings(value);
    fs.mkdirSync(path.dirname(dataFile('concurrency-settings.json')), { recursive: true });
    const file = dataFile('concurrency-settings.json'), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2)); fs.renameSync(temp, file);
    this.settingsFailure = '';
    concurrencyMonitor.configure(settings); this.prune(); return this.state();
  }
  private append(bucket: ConcurrencyBucket) {
    try {
      fs.mkdirSync(this.directory(), { recursive: true });
      const file = path.join(this.directory(), new Date(bucket.from).toISOString().slice(0, 10) + '.jsonl');
      fs.appendFileSync(file, JSON.stringify(bucket) + '\n'); this.failure = '';
    } catch { this.failure = '并发历史保存失败'; }
  }
  private prune() {
    this.lastPrune = Date.now();
    const retention = concurrencyMonitor.snapshot().settings.retention;
    if (!retention || !fs.existsSync(this.directory())) return;
    const cutoff = new Date(Date.now() - retention * 86400_000).toISOString().slice(0, 10);
    try { for (const name of fs.readdirSync(this.directory())) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) fs.unlinkSync(path.join(this.directory(), name)); }
    catch { this.failure = '并发历史清理失败'; }
  }
  async history(query: unknown): Promise<ConcurrencyHistory> {
    const q = query as { days?: number; scope?: string; metric?: ConcurrencyMetric };
    if (!q || ![0, 1, 7, 30, 90].includes(q.days ?? 1) || !['requests', 'clients', 'upstream'].includes(q.metric || 'requests') || typeof q.scope !== 'string' || q.scope.length > 200) throw Error('Invalid concurrency history query');
    const at = Date.now(), retention = concurrencyMonitor.snapshot().settings.retention;
    const since = Math.max(q.days ? at - q.days * 86400_000 : 0, retention ? at - retention * 86400_000 : 0);
    const metric = q.metric || 'requests';
    // All-history resolution is one day; other ranges have at most 1440 bins.
    const step = q.days === 0 ? 86400_000 : Math.max(60_000, (q.days || 1) * 60_000);
    const bins = new Map<string, ConcurrencyHistoryPoint>();
    let previous: ConcurrencyBucket | null = null, segment = 0;
    const add = (bucket: ConcurrencyBucket) => {
      if (!bucket || bucket.until < since || bucket.from > at || !bucket.rows?.global) return;
      if (bucket.available === false) { previous = null; segment++; return; }
      if (previous && (previous.session !== bucket.session || (bucket.observedFrom ?? bucket.from) - previous.until > 65000)) segment++;
      previous = bucket;
      const row = bucket.rows[q.scope!] || { min: { requests: 0, clients: 0, upstream: 0 }, max: { requests: 0, clients: 0, upstream: 0 }, last: { requests: 0, clients: 0, upstream: 0 }, rejected: 0 }, start = Math.floor(bucket.from / step) * step;
      const key = `${bucket.session}/${segment}/${start}`, old = bins.get(key);
      if (!old) bins.set(key, { at: Math.max(bucket.observedFrom ?? bucket.from, since), until: bucket.until, session: `${bucket.session}/${segment}`, min: row.min[metric], max: row.max[metric], last: row.last[metric], rejected: row.rejected });
      else { old.min = Math.min(old.min, row.min[metric]); old.max = Math.max(old.max, row.max[metric]); old.rejected += row.rejected; if (bucket.until >= old.until) { old.until = bucket.until; old.last = row.last[metric]; } }
    };
    if (fs.existsSync(this.directory())) for (const name of fs.readdirSync(this.directory()).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || name.slice(0, 10) < new Date(since).toISOString().slice(0, 10)) continue;
      const stream = fs.createReadStream(path.join(this.directory(), name), { encoding: 'utf8' });
      const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try { for await (const line of reader) { try { add(JSON.parse(line)); } catch { /* skip incomplete / malformed records */ } } }
      finally { reader.close(); stream.destroy(); }
    }
    const current = concurrencyMonitor.currentBucket(); if (current) add(current);
    return { at, since, step, metric, scope: q.scope!, points: [...bins.values()].sort((a, b) => a.at - b.at) };
  }
  stop() {
    if (!this.started) return; this.started = false;
    clearInterval(this.timer); clearTimeout(this.publishTimer); clearTimeout(this.notifyTimer);
    this.timer = this.publishTimer = this.notifyTimer = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined; this.pendingAlerts.clear(); concurrencyMonitor.flush();
    concurrencyMonitor.attach(() => {}, () => {});
  }
}
