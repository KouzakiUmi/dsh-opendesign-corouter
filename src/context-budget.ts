/** Client working windows, including both input and reserved output tokens. */
export const CONTEXT_WINDOW_PRESETS = [
  { id: 'default', label: '默认', tokens: 272_000 },
  { id: 'extended', label: '扩展', tokens: 500_000 },
  { id: 'maximum', label: '最大', tokens: 872_000 },
] as const;

export type ContextWindowPresetId = typeof CONTEXT_WINDOW_PRESETS[number]['id'];

/** Saved numbers are always legacy custom windows; only an explicit tier selects a preset. */
export function contextWindowPreset(legacyOverride: number | undefined, tier?: ContextWindowPresetId): ContextWindowPresetId | undefined {
  return tier ?? (legacyOverride === undefined ? 'default' : undefined);
}

/**
 * Presets never increase a known catalog/gateway reference. Historical custom
 * numbers retain their prior meaning until the user explicitly chooses a preset.
 * An unknown reference does not imply model capacity: the preset is a local budget.
 */
export function effectiveContextWindow(reference: number | undefined, override?: number, tier?: ContextWindowPresetId): number {
  if (tier === undefined && override !== undefined) return override;
  const requested = (CONTEXT_WINDOW_PRESETS.find(preset => preset.id === (tier ?? 'default')) ?? CONTEXT_WINDOW_PRESETS[0]).tokens;
  return reference === undefined ? requested : Math.min(requested, reference);
}
