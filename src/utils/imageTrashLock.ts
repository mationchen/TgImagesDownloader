let pending: Promise<void> = Promise.resolve();

/** Restoring and permanently deleting the same URI must not race across screens. */
export function withImageTrashLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}
