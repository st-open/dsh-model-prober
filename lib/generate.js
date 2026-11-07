/**
 * Turn normalized probe records into dsh-llm-pi-ai configuration.
 *
 * Emits a `cordis.patch.yml` loader-patch entry (the shape the desktop profile
 * uses) with every model's capabilities declared EXPLICITLY:
 *   - input: [text, image]   (never omitted)
 *   - reasoningEfforts:      (every level spelled out, no hidden Default)
 *   - contextWindow / maxTokens when discovered
 * and, at the provider level, an explicit `reasoning:` default so a new
 * session starts on a concrete tier instead of the ambiguous "Default".
 *
 * The only thing it will not fabricate is a capability the gateway hid
 * (e.g. server-side image blocking): there it prints a TODO marker so the
 * operator sees what is unknown instead of a wrong guess.
 */

import { DEFAULT_WIRE } from './probe.js';
import { pickDefaultEffort } from './default-effort.js';

function quoteIfNeeded(s) {
  // YAML-safe: quote keys/values that YAML 1.1 would read as booleans/numbers.
  if (/^(off|on|yes|no|true|false|null|~)$/i.test(s)) return `"${s}"`;
  if (/^[0-9]/.test(s) || /[:#{}\[\],&*?|<>=!%@`"']/.test(s)) return JSON.stringify(s);
  return s;
}

/** Build the reasoningEfforts mapping (dsh level -> wire value). */
function reasoningBlock(levels) {
  if (!levels || levels.length === 0) return null;
  const lines = ['            reasoningEfforts:'];
  for (const lvl of levels) {
    const wire = DEFAULT_WIRE[lvl] ?? lvl;
    lines.push(`              ${quoteIfNeeded(lvl)}: "${wire}"`);
  }
  return lines.join('\n');
}

/**
 * @param {object} args
 * @param {string} args.entryId        loader patch entry id (e.g. 'llm-pi-ai')
 * @param {string} args.moduleName      plugin module name (e.g. '@deepseek-ai/dsh-llm-pi-ai')
 * @param {string} args.providerId      provider route key (e.g. 'wb')
 * @param {string} [args.apiKeyEnv]     credential env reference
 * @param {string} [args.api]           wire protocol (default 'openai-completions')
 * @param {string} args.baseURL
 * @param {Array} models                probe records
 * @param {string} [args.defaultEffort] explicit provider-level default level;
 *                                      auto-derived (highest common level) when omitted
 * @param {object} [opts]
 * @param {boolean} [opts.onlyProviderEntry=true] wrap in a single loader entry
 * @returns {string} YAML text
 */
export function generateYaml({ entryId = 'llm-pi-ai', moduleName = '@deepseek-ai/dsh-llm-pi-ai', providerId, apiKeyEnv, api = 'openai-completions', baseURL, models, defaultEffort }, opts = {}) {
  const lines = [];
  lines.push(`- id: ${entryId}`);
  lines.push(`  name: "${moduleName}"`);
  lines.push('  config:');
  lines.push('    providers:');
  lines.push(`      ${providerId}:`);
  if (apiKeyEnv) lines.push(`        apiKeyEnv: ${apiKeyEnv}`);
  lines.push(`        api: ${api}`);
  lines.push(`        baseURL: ${baseURL}`);
  // Provider-level default effort — the piece that removes the ambiguous
  // "Default" label from the reasoning picker. Omitted only when no model on
  // the route reasons, where no level would be truthful.
  const providerDefault = defaultEffort ?? pickDefaultEffort(models);
  if (providerDefault) lines.push(`        reasoning: ${quoteIfNeeded(providerDefault)}`);
  lines.push('        models:');
  for (const m of models) {
    lines.push(`          - id: ${m.id}`);
    lines.push(`            name: ${quoteIfNeeded(m.name || m.id)}`);
    if (m.contextWindow) lines.push(`            contextWindow: ${m.contextWindow}`);
    if (m.maxTokens) lines.push(`            maxTokens: ${m.maxTokens}`);
    if (m.input) {
      lines.push('            input:');
      for (const mod of m.input) lines.push(`              - ${mod}`);
    } else {
      lines.push('            # TODO: ${modality unknown (gateway blocked probing)} — set input: [text, image] manually if it supports vision');
    }
    const rb = reasoningBlock(m.reasoningEfforts);
    if (rb) lines.push(rb);
    else lines.push('            # TODO: reasoning level unknown — set reasoningEfforts manually if it reasons');
  }
  return lines.join('\n') + '\n';
}

/** A compact human-readable table for CLI output. */
export function summarizeTable(models) {
  const rows = models.map((m) => ({
    id: m.id,
    vision: m.input ? (m.input.includes('image') ? 'yes' : 'no') : '?',
    efforts: m.reasoningEfforts ? m.reasoningEfforts.join('/') : '(none)',
    context: m.contextWindow ?? '?',
    maxOut: m.maxTokens ?? '?',
    probe: m.probes ? Object.entries(m.probes).map(([k, v]) => `${k}=${v}`).join(' ') : '',
  }));
  const cols = ['id', 'vision', 'efforts', 'context', 'maxOut'];
  const widths = {};
  for (const c of cols) widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  const fmt = (r) => cols.map((c) => String(r[c]).padEnd(widths[c])).join('  ');
  const out = [fmt(Object.fromEntries(cols.map((c) => [c, c])))];
  out.push(cols.map((c) => '-'.repeat(widths[c])).join('  '));
  for (const r of rows) out.push(fmt(r));
  return out.join('\n');
}
