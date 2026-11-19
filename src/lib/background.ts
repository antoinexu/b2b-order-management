import type { Logger } from 'pino';

const pending = new Set<Promise<void>>();

/**
 * Runs work after the response has been sent, e.g. so a request's timing doesn't reveal what the work found.
 * Failures are logged, never thrown.
 */
export function runInBackground(log: Logger, description: string, task: () => Promise<void>) {
  const promise = task()
    .catch((err: unknown) => log.error({ err }, `Background task failed: ${description}`))
    .finally(() => pending.delete(promise));
  pending.add(promise);
}

/** Resolves once every background task started so far has finished. For tests and graceful shutdown. */
export async function settleBackgroundTasks() {
  while (pending.size > 0) await Promise.all(pending);
}
