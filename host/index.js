/**
 * Host half of dsh-model-prober.
 *
 * Registers an LLM model-discovery for a dedicated namespace ("model-prober").
 * The client half calls `remote.llm.discoverModels("model-prober", {...})`; the
 * discovery runs the real probe engine HERE (host has network access to the
 * third-party endpoint, the browser does not) and returns one record per model.
 *
 * The dsh discovery channel only carries {id, name, contextWindow, maxTokens}.
 * We pack vision + reasoning levels into `name` with a documented envelope so
 * they survive the round trip losslessly:
 *
 *   name := "<displayName>\u241Fmp`<json>`"
 *   <json> = {"v":["text","image"], "r":["low","high","max"], "p":{...}}
 *
 * Key resolution: the client cannot read a stored credential (write-only).
 * When the caller does not pass `apiKey`, we resolve it from the provider's
 * configured `apiKeyEnv` reference by scanning the settings document, then
 * `ctx.credentials.resolve`. This is why the host half needs `settings` and
 * `credentials` injected.
 */

import { probeEndpoint } from '../lib/probe.js';

export const PROBE_NS = 'model-prober';
export const NAME_SENTINEL = '\u241Fmp`';

/** Encode capability metadata into the free-text `name` field. */
export function encodeName(displayName, record) {
  const payload = {
    v: record.input ?? null,
    r: record.reasoningEfforts ?? null,
    p: record.probes ?? {},
  };
  return `${displayName}${NAME_SENTINEL}${JSON.stringify(payload)}\``;
}

/** Decode a discovery name back to { displayName, input, reasoningEfforts, probes }. */
export function decodeName(name) {
  if (typeof name !== 'string') return { displayName: name, input: null, reasoningEfforts: null, probes: {} };
  const at = name.indexOf(NAME_SENTINEL);
  if (at < 0) return { displayName: name, input: null, reasoningEfforts: null, probes: {} };
  const displayName = name.slice(0, at);
  const rest = name.slice(at + NAME_SENTINEL.length);
  const jsonText = rest.endsWith('`') ? rest.slice(0, -1) : rest;
  try {
    const payload = JSON.parse(jsonText);
    return { displayName, input: payload.v ?? null, reasoningEfforts: payload.r ?? null, probes: payload.p ?? {} };
  } catch {
    return { displayName, input: null, reasoningEfforts: null, probes: {} };
  }
}

/**
 * Core discovery function (no key resolution — pure probe).
 * Returns entries shaped like LlmDiscoveredModel.
 */
export async function proberDiscovery(request) {
  const { baseURL, apiKey } = request || {};
  if (!baseURL) throw new Error('model-prober: baseURL is required');
  const result = await probeEndpoint({ baseURL, apiKey, activeProbe: true });
  return result.models.map((m) => ({
    id: m.id,
    name: encodeName(m.name || m.id, m),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
  }));
}

/**
 * Pick the provider-level default reasoning effort, EXPLICITLY, from the
 * probed per-model level sets.
 *
 * The dsh UI shows the ambiguous "Default" label exactly when the provider's
 * `reasoning` field is unset — a per-provider value, not a per-model one, and
 * a per-model `reasoningEfforts` list alone never fills it. This chooses the
 * highest level supported by EVERY reasoning model on the route, so the label
 * reads as a concrete tier (e.g. "High") instead of an opaque Default while
 * staying honest for every model on the provider.
 *
 * Order: off < minimal < low < medium < high < xhigh < max (pi-ai order).
 * @param {Array<{reasoningEfforts?: string[]|null}>} models decoded records
 * @returns {string|undefined} the explicit default level, or undefined when
 *   no model reasons (no level is then truthful).
 */
export function pickDefaultEffort(models) {
  const ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const levelsOf = (v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return Object.keys(v); // {low:'low', ...} dict form
    return [];
  };
  const sets = (models || [])
    .map((m) => new Set(levelsOf(m.reasoningEfforts).filter((l) => l && l !== 'off')))
    .filter((s) => s.size > 0);
  if (sets.length === 0) return undefined;
  const common = ORDER.filter((l) => sets.every((s) => s.has(l)));
  return common.length > 0 ? common[common.length - 1] : undefined;
}

/**
 * Find the `apiKeyEnv` reference for a provider route by scanning the settings
 * document for any section whose `providers[route]` object carries one.
 * @returns the referenced env/credential name, or undefined.
 */
function findApiKeyEnv(ctx, providerRoute) {
  const doc = ctx.settings && ctx.settings.document;
  if (!doc || typeof doc !== 'object') return undefined;
  for (const section of Object.values(doc)) {
    if (!section || typeof section !== 'object') continue;
    const providers = section.providers;
    if (!providers || typeof providers !== 'object') continue;
    const entry = providers[providerRoute];
    if (entry && typeof entry === 'object' && typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv.length > 0) {
      return entry.apiKeyEnv;
    }
  }
  return undefined;
}

/** Resolve the API key for a route from stored credentials, if possible. */
async function resolveStoredKey(ctx, request) {
  if (request.apiKey) return request.apiKey;
  const route = request.provider;
  if (!route || !ctx.credentials || typeof ctx.credentials.resolve !== 'function') return undefined;
  // dsh derives the credential reference from the route id on the Models page
  // (<ROUTE>_API_KEY, upper-snake), so try that FIRST — composition-layer
  // providers (cordis.patch.yml) never appear in the user settings document.
  const derived = route.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
  const candidates = [derived, findApiKeyEnv(ctx, route)].filter((v) => typeof v === 'string' && v.length > 0);
  for (const ref of candidates) {
    try {
      const resolved = await ctx.credentials.resolve(ref);
      if (resolved && resolved.value) return resolved.value;
    } catch {
      // absent reference — try the next candidate
    }
  }
  return undefined;
}

/**
 * Cordis plugin entry (function plugin).
 *
 * Only `llm` is a hard dependency (needed to register the discovery). The two
 * collaborators used at probe time — `settings` (to find the provider's
 * `apiKeyEnv`) and `credentials` (to resolve that reference to a secret) — are
 * acquired through `ctx.inject`, the same deferred pattern `dsh-llm-pi-ai`
 * uses. A deployment without them leaves the plugin activated but its
 * discovery unregistered, instead of failing plugin activation.
 */
export const name = 'model-prober';
export const inject = ['llm'];

export function apply(ctx) {
  ctx.inject(['settings', 'credentials'], (scoped) => {
    scoped.effect(
      () =>
        scoped.llm.registerModelDiscovery(PROBE_NS, async (request) => {
          const apiKey = await resolveStoredKey(scoped, request);
          return proberDiscovery({ ...request, apiKey });
        }),
      'dsh-model-prober: register model discovery',
    );
  });
}
