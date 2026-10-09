import type { Socket } from 'node:net';

export type ConcurrencyMetric = 'requests' | 'clients' | 'upstream';
export type Counts = Record<ConcurrencyMetric, number>;
export type ConcurrencyScope = { id: string; label: string; kind: 'provider' | 'account' | 'unattributed' | 'shared' };
export type ConcurrencyRule = { requests?: number; clients?: number; upstream?: number; action: 'warn' | 'reject' };
export type ConcurrencySettings = { retention: 7 | 30 | 90 | 0; rules: Record<string, ConcurrencyRule> };
export type ConcurrencyRow = ConcurrencyScope & Counts & { supported: Counts; rule?: ConcurrencyRule; rejected: number };
export type ConcurrencyAlert = { scope: string; label: string; metric: ConcurrencyMetric; count: number; limit: number; rejected: boolean };
export type ConcurrencyState = { at: number; rows: ConcurrencyRow[]; alerts: ConcurrencyAlert[]; settings: ConcurrencySettings };
export type ConcurrencyLiveState = ConcurrencyState & { storageError?: string; coverage: { app: string; monitored: boolean }[] };
export type ConcurrencyHistoryQuery = { scope: string; metric: ConcurrencyMetric; days: 0 | 1 | 7 | 30 | 90 };
export type ConcurrencyHistoryPoint = { at: number; until: number; session: string; min: number; max: number; last: number; rejected: number };
export type ConcurrencyHistory = { at: number; since: number; step: number; metric: ConcurrencyMetric; scope: string; points: ConcurrencyHistoryPoint[] };
export type ConcurrencyBucket = { session: string; from: number; observedFrom: number; until: number; available: boolean; rows: Record<string, { min: Counts; max: Counts; last: Counts; rejected: number }> };
const METRICS: ConcurrencyMetric[] = ['requests', 'clients', 'upstream'];
const zero = (): Counts => ({ requests: 0, clients: 0, upstream: 0 });
const GLOBAL: ConcurrencyScope = { id: 'global', label: '全部转发', kind: 'provider' };

export function validateConcurrencySettings(value: unknown): ConcurrencySettings {
  const input = value as ConcurrencySettings;
  if (!input || ![0, 7, 30, 90].includes(input.retention) || !input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules)) throw Error('Invalid concurrency settings');
  const rules: Record<string, ConcurrencyRule> = {};
  if (Object.keys(input.rules).length > 1000) throw Error('Too many concurrency rules');
  for (const [id, rule] of Object.entries(input.rules)) {
    if (!/^(global|provider:[\w:.-]+|account:[\w:@./%+-]+)$/.test(id) || id.length > 200 || !rule || !['warn', 'reject'].includes(rule.action)) throw Error('Invalid concurrency rule');
    const clean: ConcurrencyRule = { action: rule.action };
    for (const metric of METRICS) {
      const n = rule[metric];
      if (n == null) continue;
      if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) throw Error('Concurrency limits must be positive integers');
      clean[metric] = n;
    }
    rules[id] = clean;
  }
  return { retention: input.retention, rules };
}

/** Only stable scope metadata enters snapshots/history. Credentials and payloads
 * never enter this object. Every resource has a single idempotent release. */
export class ConcurrencyMonitor {
  private settings: ConcurrencySettings = { retention: 30, rules: {} };
  private scopes = new Map<string, ConcurrencyScope>([[GLOBAL.id, GLOBAL]]);
  private requests = new Map<symbol, string[]>();
  private sockets = new Map<Socket, { side: 'clients' | 'upstream'; scopes: Map<string, ConcurrencyScope>; contexts: Map<string, Set<string>>; close: () => void }>();
  private rejected = new Map<string, number>();
  private episodes = new Map<string, { alert: ConcurrencyAlert; recovering?: number }>();
  private notified = new Map<string, number>();
  private bucket: ConcurrencyBucket | null = null;
  private previousRejected = new Map<string, number>();
  private bucketRejected = new Map<string, number>();
  private session = `${Date.now()}-${process.pid}`;
  private available = true;
  private availabilitySegment = 0;
  private listeners = new Set<() => void>();
  private sink?: (bucket: ConcurrencyBucket) => void;
  private notification?: (alerts: ConcurrencyAlert[]) => void;
  constructor(private now = Date.now) {}
  configure(settings: unknown) { this.settings = validateConcurrencySettings(settings); this.changed(); }
  attach(sink: (bucket: ConcurrencyBucket) => void, notification: (alerts: ConcurrencyAlert[]) => void) { this.sink = sink; this.notification = notification; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setAvailable(available: boolean) { if (this.available === available) return; this.available = available; this.availabilitySegment++; this.changed(); }
  register(scopes: ConcurrencyScope[]) { for (const scope of scopes) { const previous = this.scopes.get(scope.id); this.scopes.set(scope.id, { ...scope, label: scope.kind === 'account' && scope.label === scope.id.slice(8) && previous ? previous.label : scope.label }); } }
  snapshot(): ConcurrencyState {
    const rows = new Map<string, ConcurrencyRow>();
    for (const scope of this.scopes.values()) rows.set(scope.id, { ...scope, ...zero(), supported: { requests: +(scope.kind === 'provider' || scope.kind === 'account'), clients: +(scope.kind === 'provider' || scope.kind === 'account'), upstream: +(scope.kind === 'provider' || scope.kind === 'account') }, rejected: this.rejected.get(scope.id) || 0, rule: this.settings.rules[scope.id] });
    for (const ids of this.requests.values()) for (const id of [...(ids.includes('!member') ? [] : ['global']), ...ids]) { const row = rows.get(id); if (row) row.requests++; }
    for (const entry of this.sockets.values()) {
      rows.get('global')![entry.side]++;
      const associated = [...entry.scopes.values()];
      const ambiguous = entry.contexts.size > 1;
      const common = associated.filter(scope => [...entry.contexts.values()].every(ids => ids.has(scope.id)));
      if (ambiguous || !associated.length) {
        const id = ambiguous ? 'shared' : 'unattributed';
        if (!rows.has(id)) rows.set(id, { id, label: ambiguous ? '共享连接' : '未归属', kind: ambiguous ? 'shared' : 'unattributed', ...zero(), supported: zero(), rejected: 0 });
        rows.get(id)![entry.side]++;
        for (const scope of common) rows.get(scope.id)![entry.side]++;
        for (const scope of associated.filter(scope => !common.includes(scope))) { const row = rows.get(scope.id); if (row) row.supported[entry.side] = 0; }
      } else for (const scope of associated) rows.get(scope.id)![entry.side]++;
    }
    return { at: this.now(), rows: [...rows.values()].map(row => ({ ...row, supported: { ...row.supported }, rule: row.rule && { ...row.rule } })), alerts: [...this.episodes.values()].map(value => ({ ...value.alert })), settings: structuredClone(this.settings) };
  }
  /** Global reservation survives pool attempts; member reservations do not. */
  admit(scopes: ConcurrencyScope[], global = true, reportRejection = true): { release: () => void } | { error: ConcurrencyAlert } {
    this.register(scopes);
    const state = this.snapshot();
    const ids = [...new Set(scopes.map(scope => scope.id))];
    for (const id of [...(global ? ['global'] : []), ...ids]) {
      const row = state.rows.find(row => row.id === id)!;
      if (row.supported.requests && row.rule?.action === 'reject' && row.rule.requests != null && row.requests >= row.rule.requests) {
        const error = { scope: id, label: row.label, metric: 'requests' as const, count: row.requests, limit: row.rule.requests, rejected: true };
        if (reportRejection) this.recordRejectedRequest(error, global);
        return { error };
      }
    }
    const key = Symbol('request');
    // A member-only reservation omits global to avoid counting one request twice.
    this.requests.set(key, global ? ids : ['!member', ...ids]);
    this.changed();
    return { release: () => { if (this.requests.delete(key)) this.changed(); } };
  }
  trackSocket(socket: Socket, side: 'clients' | 'upstream', scopes: ConcurrencyScope[]) {
    if (socket.destroyed) return;
    this.register(scopes);
    let entry = this.sockets.get(socket);
    if (!entry) {
      const close = () => { const current = this.sockets.get(socket); if (!current) return; this.sockets.delete(socket); socket.off('close', close); this.changed(); };
      entry = { side, scopes: new Map(), contexts: new Map(), close }; this.sockets.set(socket, entry); socket.once('close', close);
    }
    for (const scope of scopes) entry.scopes.set(scope.id, scope);
    if (scopes.length) entry.contexts.set(scopes.map(scope => scope.id).sort().join('|'), new Set(scopes.map(scope => scope.id)));
    this.changed();
  }
  observeRequest(request: import('http').ClientRequest, scopes: ConcurrencyScope[]) {
    request.once('socket', socket => {
      const register = () => this.trackSocket(socket, 'upstream', scopes);
      if (socket.connecting) socket.once('connect', register); else register();
    });
  }
  private startEpisode(alert: ConcurrencyAlert) {
    const key = `${alert.scope}/${alert.metric}`, existing = this.episodes.get(key);
    if (existing) { existing.alert = { ...alert, rejected: existing.alert.rejected || alert.rejected }; existing.recovering = undefined; return; }
    this.episodes.set(key, { alert });
    if (this.now() - (this.notified.get(key) ?? -Infinity) >= 60_000) {
      this.notified.set(key, this.now()); this.notification?.([alert]);
    }
  }
  private changed() { this.tick(); for (const listener of this.listeners) listener(); }
  tick() {
    const state = this.snapshot(), at = this.now();
    for (const row of state.rows) for (const metric of METRICS) {
      const limit = row.rule?.[metric];
      if (limit != null && row.supported[metric] && row[metric] > limit) this.startEpisode({ scope: row.id, label: row.label, metric, count: row[metric], limit, rejected: false });
    }
    for (const [key, episode] of this.episodes) {
      const row = state.rows.find(row => row.id === episode.alert.scope), metric = episode.alert.metric, limit = row?.rule?.[metric];
      if (limit == null || !row?.supported[metric]) { this.episodes.delete(key); continue; }
      episode.alert.count = row[metric]; episode.alert.limit = limit;
      const recovered = metric === 'requests' && row.rule?.action === 'reject' ? row[metric] < limit : row[metric] <= limit;
      if (recovered) { episode.recovering ??= at; if (at - episode.recovering >= 5000) this.episodes.delete(key); }
      else episode.recovering = undefined;
    }
    this.record(state);
  }
  private record(state: ConcurrencyState) {
    const from = Math.floor(state.at / 60_000) * 60_000;
    const session = `${this.session}/${this.availabilitySegment}`;
    if (this.bucket && (this.bucket.from !== from || this.bucket.session !== session)) { this.sink?.(this.sparseBucket()); this.bucket = null; }
    if (!this.bucket) this.bucketRejected = new Map(this.previousRejected);
    this.bucket ??= { session, from, observedFrom: state.at, until: state.at, available: this.available, rows: {} };
    this.bucket.until = state.at;
    for (const row of state.rows) {
      const counts = { requests: row.requests, clients: row.clients, upstream: row.upstream };
      const old = this.bucket.rows[row.id];
      const rejected = row.rejected - (this.bucketRejected.get(row.id) || 0);
      if (!old) this.bucket.rows[row.id] = { min: { ...counts }, max: { ...counts }, last: { ...counts }, rejected };
      else { for (const metric of METRICS) { old.min[metric] = Math.min(old.min[metric], counts[metric]); old.max[metric] = Math.max(old.max[metric], counts[metric]); old.last[metric] = counts[metric]; } old.rejected = rejected; }
      this.previousRejected.set(row.id, row.rejected);
    }
  }
  recordRejectedRequest(error: ConcurrencyAlert, global = true) {
    if (global) this.rejected.set('global', (this.rejected.get('global') || 0) + 1);
    if (error.scope !== 'global') this.rejected.set(error.scope, (this.rejected.get(error.scope) || 0) + 1);
    this.startEpisode(error); this.changed();
  }
  private sparseBucket() {
    const bucket = structuredClone(this.bucket!);
    bucket.rows = Object.fromEntries(Object.entries(bucket.rows).filter(([id, row]) => id === 'global' || row.rejected || Object.values(row.max).some(count => count > 0)));
    return bucket;
  }
  currentBucket() { return this.bucket && this.sparseBucket(); }
  clear() {
    this.requests.clear();
    for (const [socket, entry] of this.sockets) socket.off('close', entry.close);
    this.sockets.clear(); this.changed();
  }
  closeSockets() { for (const socket of this.sockets.keys()) socket.destroy(); }
  flush() { if (this.bucket) { this.sink?.(this.sparseBucket()); this.bucket = null; } }
}

export const concurrencyMonitor = new ConcurrencyMonitor();
let identityResolver: ((app: string, headers: Record<string, unknown>) => ConcurrencyScope | null) | undefined;
export function setConcurrencyIdentityResolver(resolver: typeof identityResolver) { identityResolver = resolver; }
export function transparentScopes(app: string, headers: Record<string, unknown>): ConcurrencyScope[] {
  const scopes = providerScopes(app);
  let account: ConcurrencyScope | null | undefined;
  try { account = identityResolver?.(app, headers); } catch { /* identity unavailable: never guess */ }
  return account ? [scopes[0], account] : scopes;
}
export function providerScopes(app: string, target?: { id: string; name: string; officialAccount?: string; concurrencyProviderId?: string; concurrencyProviderName?: string; concurrencyPoolId?: string; concurrencyPoolName?: string }): ConcurrencyScope[] {
  const scopes: ConcurrencyScope[] = [{ id: `provider:${target?.concurrencyProviderId || target?.id || 'pass-' + app}`, label: target?.concurrencyProviderName || target?.name || `${app} · 官方透明转发`, kind: 'provider' }];
  if (target?.concurrencyPoolId && target.concurrencyPoolId !== target.concurrencyProviderId) scopes.push({ id: 'provider:' + target.concurrencyPoolId, label: target.concurrencyPoolName || target.concurrencyPoolId, kind: 'provider' });
  if (target?.officialAccount) scopes.push({ id: `account:${target.officialAccount}`, label: target.officialAccount, kind: 'account' });
  else if (!target) scopes.push({ id: `unattributed:${app}`, label: `${app} · 未归属账号`, kind: 'unattributed' });
  return scopes;
}
export const isInference = (method: string | undefined, path: string) => method === 'POST' && /\/(responses|messages|chat\/completions)\/?(?:\?|$)/.test(path);
