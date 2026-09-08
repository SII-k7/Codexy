// One authenticated long poll per foreground host. No secret in the URL and no
// transcript in the feed. Old relays fall back to a 30-second snapshot check.
export function createLiveSync(options: {
  watch: (revision: string | null, signal: AbortSignal) => Promise<{ revision: string; changed: boolean }>;
  refresh: () => Promise<void>;
  onError: (error: Error) => void;
  retryMs?: number;
}) {
  let active = false;
  let closed = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let revision: string | null = null;
  let failures = 0;
  let generation = 0;
  async function run(epoch: number) {
    if (!active || closed || epoch !== generation) return;
    controller = new AbortController();
    let delay = 0;
    try {
      const result = await options.watch(revision, controller.signal);
      if (!active || closed || epoch !== generation) return;
      // A heartbeat also performs a low-frequency full reconciliation. Taking
      // the revision before the snapshot avoids missing changes during reads.
      revision = result.revision;
      await options.refresh();
      failures = 0;
    } catch (error) {
      if (!active || closed || epoch !== generation) return;
      const failure = error instanceof Error ? error : new Error('状态连接中断');
      if ((failure as Error & { status?: number }).status === 404) {
        await options.refresh();
        delay = options.retryMs ?? 30_000;
      } else {
        options.onError(failure);
        revision = null; // Reconnect must fetch a complete current snapshot.
        delay = options.retryMs ?? Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      }
    }
    if (active && !closed && epoch === generation) timer = setTimeout(() => void run(epoch), delay || 100);
  }
  function setActive(value: boolean) {
    if (closed || value === active) return;
    active = value; generation += 1;
    controller?.abort(); if (timer) clearTimeout(timer);
    revision = null;
    if (active) void run(generation);
  }
  return { setActive, close() { setActive(false); closed = true; } };
}
