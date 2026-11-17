/** Model-relative working windows, including both input and reserved output. */
const CONTEXT_TIERS = [
  { id: 'default', label: '默认' },
  { id: 'extended', label: '扩展' },
  { id: 'maximum', label: '最大' },
] as const;

export type ContextWindowPresetId = typeof CONTEXT_TIERS[number]['id'];
export interface ContextWindowPreset {
  id: ContextWindowPresetId;
  label: string;
  tokens: number | undefined;
}

/**
 * Use familiar quarter/half-size working budgets and the exact reference as maximum.
 * Decimal references use decimal K; exact binary windows retain binary subdivisions.
 * Missing references stay unknown instead of inheriting another model's capacity.
 */
export function contextWindowPresets(reference?: number): readonly ContextWindowPreset[] {
  if (reference === undefined || !Number.isSafeInteger(reference) || reference < 1) {
    return CONTEXT_TIERS.map(tier => ({ ...tier, tokens: undefined }));
  }
  const unit = reference < 4096 ? 1 : Number.isInteger(Math.log2(reference)) ? 1024 : 1000;
  const extended = Math.min(reference, Math.max(1, 2 ** Math.round(Math.log2(reference / (2 * unit))) * unit));
  const windows = [Math.max(1, Math.floor(extended / 2)), extended, reference];
  return CONTEXT_TIERS.map((tier, index) => ({ ...tier, tokens: windows[index]! }));
}

/** Default can always clear an old override; unknown/duplicate higher tiers cannot be selected. */
export function contextTierAvailable(tier: ContextWindowPresetId, reference: number | undefined): boolean {
  if (tier === 'default') return true;
  const presets = contextWindowPresets(reference);
  const index = presets.findIndex(preset => preset.id === tier);
  const tokens = presets[index]?.tokens;
  return tokens !== undefined && !presets.slice(0, index).some(preset => preset.tokens === tokens);
}

/** Saved numbers are always legacy custom windows; only an explicit tier selects a preset. */
export function contextWindowPreset(legacyOverride: number | undefined, tier?: ContextWindowPresetId): ContextWindowPresetId | undefined {
  return tier ?? (legacyOverride === undefined ? 'default' : undefined);
}

/**
 * Tiers follow the current catalog/gateway reference. Historical custom numbers
 * retain their prior meaning until the user explicitly chooses a tier.
 */
export function effectiveContextWindow(reference: number | undefined, override?: number, tier?: ContextWindowPresetId): number | undefined {
  if (tier === undefined && override !== undefined) return override;
  return contextWindowPresets(reference).find(preset => preset.id === (tier ?? 'default'))?.tokens;
}
