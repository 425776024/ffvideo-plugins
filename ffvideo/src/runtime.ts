import { reactive } from 'vue';
import { VideoCutClient, type Snapshot } from '../../packages/client/index.mjs';
import type { TtsJob } from '../../packages/client/types';
import { TtsJobCoordinator } from '../../src/editor/tts-jobs';
import { renderTemplateExport } from '../../src/editor/template-export';
import { sharedMediaEngine } from '../../packages/media/browser';

export const client = new VideoCutClient(location.origin);
export const runtimeStatus = reactive({
  connected: false,
  error: '',
  exports: {} as Record<string, any>
});

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/ffapi${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error || `请求失败 (${response.status})`), {
      status: response.status
    });
  return value;
}

type RuntimeSession = {
  snapshot: Snapshot;
  source: EventSource;
  tts: TtsJobCoordinator;
  job?: TtsJob;
  rendering: Set<string>;
  exportCheck?: Promise<void>;
};

/** Playback switches one surface; background speech/render subscriptions remain alive. */
export class FeedRuntime {
  private sessions = new Map<string, RuntimeSession>();
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private refreshing = false;
  private activeId = '';
  private backgroundIds = new Set<string>();
  private runningExports = new Map<string, AbortController>();
  private exportTail: Promise<unknown> = Promise.resolve();
  private finishedExports = new Set<string>();
  private connectionEpoch = 0;
  private reconnecting?: Promise<void>;

  onSnapshot(listener: (snapshot: Snapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start() {
    await this.reconnect();
  }
  reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    const epoch = ++this.connectionEpoch;
    runtimeStatus.connected = false;
    for (const abort of this.runningExports.values()) abort.abort();
    this.runningExports.clear(); this.finishedExports.clear(); this.exportTail = Promise.resolve();
    for (const session of this.sessions.values()) { session.tts.dispose(); session.source.close(); }
    this.sessions.clear(); this.backgroundIds.clear(); this.activeId = ''; this.refreshing = false;
    runtimeStatus.exports = {}; sharedMediaEngine.invalidate();
    const operation = (async () => {
      try {
        await client.connect();
        if (this.disposed || epoch !== this.connectionEpoch) return;
        runtimeStatus.connected = true; runtimeStatus.error = '';
        if (!this.timer) this.timer = setInterval(() => void this.refresh(), 2000);
        await this.refresh();
      } catch (error) {
        if (epoch === this.connectionEpoch) runtimeStatus.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    })();
    this.reconnecting = operation;
    void operation.finally(() => { if (this.reconnecting === operation) this.reconnecting = undefined; }).catch(() => {});
    return operation;
  }
  async activate(snapshot: Snapshot) {
    if (this.reconnecting) await this.reconnecting;
    else if (!runtimeStatus.connected) await this.reconnect();
    if (this.disposed) return;
    this.activeId = snapshot.id;
    this.releaseIdleSessions();
    this.attach(snapshot);
  }
  deactivate() {
    this.activeId = '';
    this.releaseIdleSessions();
  }
  private releaseIdleSessions() {
    for (const [id, session] of this.sessions) {
      const working = session.rendering.size || ['queued', 'running'].includes(session.job?.state || '');
      if (id === this.activeId || this.backgroundIds.has(id) || working) continue;
      session.tts.dispose();
      session.source.close();
      this.sessions.delete(id);
    }
  }
  private attach(snapshot: Snapshot) {
    const existing = this.sessions.get(snapshot.id);
    if (existing) {
      if (snapshot.version > existing.snapshot.version) existing.snapshot = snapshot;
      return;
    }
    const source = new EventSource(client.eventsUrl(snapshot.id));
    const session = {
      snapshot,
      source,
      rendering: new Set<string>()
    } as RuntimeSession;
    session.tts = new TtsJobCoordinator(client, snapshot.id, source, (job) => {
      session.job = job || undefined;
    });
    this.sessions.set(snapshot.id, session);
    source.onmessage = (event) => {
      if (this.disposed || this.sessions.get(snapshot.id) !== session) return;
      try {
        const next = JSON.parse(event.data) as Snapshot;
        if (!next.project || next.id !== snapshot.id) return;
        session.snapshot = next;
        for (const listener of this.listeners) listener(next);
      } catch {
        /* Reconnect retrieves the authoritative snapshot. */
      }
    };
    source.addEventListener('render-request', (event) => {
      if (this.disposed || this.sessions.get(snapshot.id) !== session) return;
      try {
        this.render(session, JSON.parse((event as MessageEvent).data).id);
      } catch {
        /* The next poll retries. */
      }
    });
    source.addEventListener('render-progress', (event) => {
      if (this.disposed || this.sessions.get(snapshot.id) !== session) return;
      try {
        const value = JSON.parse((event as MessageEvent).data);
        runtimeStatus.exports[snapshot.id] = value;
      } catch {
        /* A malformed progress event cannot interrupt a render. */
      }
    });
    void this.findExport(session);
  }
  private findExport(session: RuntimeSession) {
    if (session.exportCheck) return session.exportCheck;
    const epoch = this.connectionEpoch;
    const operation = (async () => {
      try {
        const value = await client.request<any>(`/sessions/${session.snapshot.id}/render-job`);
        if (this.disposed || epoch !== this.connectionEpoch || this.sessions.get(session.snapshot.id) !== session) return;
        if (value.phase === 'waiting-browser' && value.id) this.render(session, value.id);
      } catch {
        /* Sessions may expire between discovery and attachment. */
      }
    })();
    session.exportCheck = operation;
    void operation.finally(() => { if (session.exportCheck === operation) session.exportCheck = undefined; });
    return operation;
  }
  private render(session: RuntimeSession, jobId: string) {
    if (
      !jobId ||
      this.disposed ||
      this.runningExports.has(jobId) ||
      this.finishedExports.has(jobId)
    )
      return;
    const abort = new AbortController();
    const epoch = this.connectionEpoch;
    this.runningExports.set(jobId, abort);
    session.rendering.add(jobId);
    this.exportTail = this.exportTail
      .catch(() => {})
      .then(async () => {
        if (this.disposed || epoch !== this.connectionEpoch || abort.signal.aborted) return;
        try {
          await renderTemplateExport(client, session.snapshot.id, jobId, abort.signal, () => {
            runtimeStatus.exports[session.snapshot.id] = {
              phase: 'rendering',
              completed: 0,
              total: 1
            };
          });
          if (epoch !== this.connectionEpoch) return;
          this.finishedExports.add(jobId);
          if (this.finishedExports.size > 64)
            this.finishedExports.delete(this.finishedExports.values().next().value!);
        } catch (error) {
          if (epoch !== this.connectionEpoch || abort.signal.aborted) return;
          runtimeStatus.exports[session.snapshot.id] = {
            phase: 'error',
            error: error instanceof Error ? error.message : String(error)
          };
        } finally {
          if (this.runningExports.get(jobId) === abort) this.runningExports.delete(jobId);
          session.rendering.delete(jobId);
        }
      });
  }
  async refresh() {
    if (this.disposed) return;
    // Release read-only SSEs before a fetch can queue behind the HTTP/1 connection limit.
    this.releaseIdleSessions();
    if (this.refreshing) return;
    this.refreshing = true;
    const epoch = this.connectionEpoch;
    try {
      const value = await api<{ sessions: Snapshot[] }>('/runtime');
      if (this.disposed || epoch !== this.connectionEpoch) return;
      this.backgroundIds = new Set(value.sessions.map((snapshot) => snapshot.id));
      this.releaseIdleSessions();
      for (const snapshot of value.sessions) this.attach(snapshot);
      for (const session of this.sessions.values()) void this.findExport(session);
      runtimeStatus.error = '';
    } catch (error) {
      if (epoch === this.connectionEpoch) runtimeStatus.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (epoch === this.connectionEpoch) this.refreshing = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.connectionEpoch++;
    clearInterval(this.timer);
    for (const abort of this.runningExports.values()) abort.abort();
    for (const session of this.sessions.values()) {
      session.tts.dispose();
      session.source.close();
    }
    this.sessions.clear();
    this.backgroundIds.clear();
    this.listeners.clear();
  }
}

export const feedRuntime = new FeedRuntime();
