import { derived, writable } from 'svelte/store';

/** Active async operations, keyed by an opaque id, so overlapping work (e.g. a
 * thumbnail decode while a seek is in flight) all shows up rather than one
 * clobbering the other. */
const activeOps = writable<Map<number, string>>(new Map());
let nextId = 0;

/** Marks `label` as in-progress; call the returned function when it finishes. */
export function beginOp(label: string): () => void {
  const id = nextId++;
  activeOps.update((ops) => new Map(ops).set(id, label));
  return () => activeOps.update((ops) => {
    const next = new Map(ops);
    next.delete(id);
    return next;
  });
}

/** Runs `fn`, showing `label` in the status indicator for its duration. */
export async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const end = beginOp(label);
  try {
    return await fn();
  } finally {
    end();
  }
}

export const statusText = derived(activeOps, (ops) => (ops.size === 0 ? 'Idle' : Array.from(ops.values()).join(' · ')));
export const isBusy = derived(activeOps, (ops) => ops.size > 0);
