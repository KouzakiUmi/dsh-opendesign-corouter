/** Preserve a transform callback through repeated Schema JSON rehydration. */
export function serializableTransform<T, R>(callback: (value: T) => R): ((value: T) => R) & { toJSON(): string } {
  return Object.assign(callback, {
    toJSON() {
      return `(${serializableTransform.toString()})(${callback.toString()})`;
    },
  });
}
