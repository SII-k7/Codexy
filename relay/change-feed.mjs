import { randomUUID } from 'node:crypto';

// Memory-only invalidation feed. It never contains prompts or conversation data.
export function createChangeFeed({ waitMs = 25_000 } = {}) {
  let revision = randomUUID();
  const pending = new Set();
  return {
    notify() {
      revision = randomUUID();
      for (const finish of [...pending]) finish();
    },
    watch(request, response, after, authorized, send) {
      if (pending.size >= 128) { send(response, 429, { error: 'too many change watchers' }); return; }
      let timer;
      const cleanup = () => { clearTimeout(timer); pending.delete(finish); response.off('close', cleanup); };
      const finish = () => {
        cleanup();
        if (response.destroyed) return;
        if (!authorized()) { send(response, 401, { error: 'device authorization expired' }); return; }
        send(response, 200, { revision, changed: after !== revision });
      };
      response.on('close', cleanup);
      if (after !== revision) { finish(); return; }
      pending.add(finish);
      timer = setTimeout(finish, waitMs);
      timer.unref?.();
    },
    close() { for (const finish of [...pending]) finish(); },
  };
}
