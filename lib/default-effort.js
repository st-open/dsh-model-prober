/**
 * Provider-level default reasoning effort.
 *
 * dsh renders the ambiguous "Default" entry/label in the reasoning picker
 * exactly when the provider's `reasoning` field is unset (or names a level the
 * selected model does not support). A per-model `reasoningEfforts` list never
 * fills it: dsh reads the default from the provider profile, not from the
 * model entry. So a probed route must be able to answer "which tier should a
 * brand-new session start in?".
 *
 * Strategy: pick the highest level that EVERY reasoning model on the route
 * declares. That is the strongest tier that is still truthful for all models
 * (setting a level one model lacks would push that model straight back to the
 * "Default" label). Non-reasoning models (no `reasoningEfforts`) are ignored —
 * they have no effort control at all.
 *
 * Both accepted shapes are handled:
 *   - array of level ids:            ["off", "low", "high", "max"]
 *   - dict of level -> wire value:   { off: "none", low: "low", ... }
 */

/** pi-ai escalation order. */
export const THINKING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function levelsOf(value) {
	if (Array.isArray(value)) return value;
	if (value && typeof value === 'object') return Object.keys(value);
	return [];
}

/**
 * @param {Array<{reasoningEfforts?: string[]|Record<string, string>|null}>} models
 * @returns {string|undefined} highest common non-"off" level, or undefined when
 *   no model on the route reasons (in which case no level is truthful).
 */
export function pickDefaultEffort(models) {
	const sets = (models || [])
		.map((m) => new Set(levelsOf(m && m.reasoningEfforts).filter((l) => l && l !== 'off')))
		.filter((s) => s.size > 0);
	if (sets.length === 0) return undefined;
	const common = THINKING_ORDER.filter((l) => sets.every((s) => s.has(l)));
	return common.length > 0 ? common[common.length - 1] : undefined;
}
