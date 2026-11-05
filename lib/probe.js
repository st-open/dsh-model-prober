/**
 * Probe engine for third-party OpenAI-compatible endpoints.
 *
 * Strategy (learned from real gateways):
 *  - The /v1/models listing is the AUTHORITATIVE source for modalities and
 *    reasoning levels. We read every known spelling.
 *  - Active probes VERIFY and FILL GAPS where the listing is silent:
 *      * reasoning: send a tiny prompt at a given effort and inspect
 *        `reasoning_tokens` / `reasoning_content` / `thinking` in the reply.
 *      * vision: send a 1x1 PNG; interpret the outcome carefully. Many
 *        gateways block images server-side ("start a new conversation..."),
 *        which is NOT a modality verdict — that is treated as "indeterminate"
 *        and we fall back to the listing, never a false negative.
 *      * context: the listing's context_length/context_window wins; when
 *        absent, we leave it undefined (caller decides) rather than guess.
 *
 * Output is a normalized record per model whose fields map 1:1 onto the
 * dsh-llm-pi-ai `models[]` entry, with reasoningEfforts FULLY explicit
 * (never omitting a level, never relying on a hidden provider default).
 */

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** dsh thinking levels in escalation order (must mirror pi-ai). */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** pi-ai dispatch level -> wire value the gateway should receive. */
export const DEFAULT_WIRE = {
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

function trimTrailingSlash(s) {
  return s.replace(/\/+$/, '');
}

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function toInt(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return undefined;
}

/** Normalize a raw listing entry into modality fields. */
function readModalities(raw) {
  const mods = pick(raw.modalities, raw.modality, raw.architecture && raw.architecture.modalities);
  const arch = raw.architecture || {};
  let input = [];
  if (mods && Array.isArray(mods.input)) input = mods.input;
  else if (mods && typeof mods.input === 'string') input = mods.input.split(',').map((s) => s.trim());
  else if (Array.isArray(raw.input_modalities)) input = raw.input_modalities;
  else if (Array.isArray(arch.input_modalities)) input = arch.input_modalities; // OpenRouter
  else if (Array.isArray(raw.capabilities)) input = raw.capabilities;
  else if (typeof raw.capabilities === 'object' && raw.capabilities && Array.isArray(raw.capabilities.input))
    input = raw.capabilities.input;
  input = input.map((x) => String(x).toLowerCase());
  // only accept what dsh understands
  return input.filter((x) => x === 'text' || x === 'image');
}

function readReasoningLevels(raw) {
  // several spellings seen across gateways
  let levels;
  const srl = pick(raw.supported_reasoning_levels, raw.reasoning_levels);
  if (Array.isArray(srl)) {
    levels = srl
      .map((x) => (typeof x === 'string' ? x : x && x.effort))
      .filter((x) => typeof x === 'string');
  } else if (typeof srl === 'string') {
    levels = srl.split(',').map((x) => x.trim());
  }
  if (!levels || levels.length === 0) {
    // inference from a bare `reasoning: true|false` flag
    if (raw.reasoning === true) levels = ['low', 'medium', 'high'];
    else if (raw.reasoning === false) levels = [];
  }
  // map gateway wire names -> dsh thinking-level ids
  const map = { none: 'off', off: 'off' };
  const out = [];
  for (const l of levels || []) {
    const norm = map[String(l).toLowerCase()] ?? String(l).toLowerCase();
    if (THINKING_LEVELS.includes(norm) && !out.includes(norm)) out.push(norm);
  }
  // keep escalation order
  out.sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b));
  return out;
}

function readContext(raw) {
  return toInt(
    pick(
      raw.contextWindow,
      raw.context_window,
      raw.context_length,
      raw.max_input_tokens,
      raw.max_context_tokens,
      raw.limit && raw.limit.context,
    ),
  );
}

function readMaxTokens(raw) {
  return toInt(
    pick(
      raw.maxOutputTokens,
      raw.max_output_tokens,
      raw.max_tokens,
      raw.max_completion_tokens,
      raw.limit && raw.limit.output,
      raw.top_provider && raw.top_provider.max_completion_tokens,
    ),
  );
}

/** Flatten the listing body ("data" array or "models" object) to raw entries. */
function readListing(body) {
  const data = body && body.data;
  if (Array.isArray(data)) return data;
  const models = body && body.models;
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    return Object.entries(models)
      .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
      .map(([id, v]) => ({ id, ...v }));
  }
  throw new Error('model listing has neither "data" array nor "models" object');
}

async function getJson(url, apiKey, extraHeaders = {}) {
  const headers = new Headers({ accept: 'application/json', ...extraHeaders });
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (cause) {
    const e = new Error(`无法连接 ${url}（网关可能离线或地址/端口不对）`);
    e.status = 0;
    e.cause = cause;
    throw e;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${url} -> HTTP ${res.status} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * One chat completion. Returns { text, reasoningText, reasoningTokens } or
 * throws with a classified error. Never throws for a plain content answer.
 */
async function chatOnce({ baseURL, apiKey, model, effort, maxTokens = 64, messages, extraHeaders }) {
  const url = `${trimTrailingSlash(baseURL)}/chat/completions`;
  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json', ...extraHeaders });
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const body = { model, max_tokens: maxTokens, messages };
  if (effort !== undefined) body.reasoning_effort = effort;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (cause) {
    const e = new Error(`无法连接 ${url}（网关可能离线）`);
    e.status = 0;
    e.cause = cause;
    throw e;
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const e = new Error(`non-JSON reply: ${text.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  if (!res.ok || json.error) {
    const msg = (json.error && (json.error.message || JSON.stringify(json.error))) || text.slice(0, 200);
    const e = new Error(msg);
    e.status = res.status;
    e.gatewayError = msg;
    throw e;
  }
  const choice = (json.choices && json.choices[0]) || {};
  const message = choice.message || {};
  const reasoningText =
    message.reasoning_content || message.reasoning || message.thinking || (message.reasoning_details && JSON.stringify(message.reasoning_details)) || '';
  const usage = json.usage || {};
  const reasoningTokens =
    (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) ??
    (usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens) ??
    undefined;
  return { text: message.content || '', reasoningText, reasoningTokens, finish: choice.finish_reason };
}

/** Detect whether an error string means the gateway refuses image input server-side. */
function looksLikeImageBlocked(msg) {
  const s = String(msg || '').toLowerCase();
  return /image|picture|photo|vision|new conversation|unsupported media|media type/.test(s) && /conversation|image|picture|unsupported|not support|invalid/.test(s);
}

/**
 * Active vision probe. Returns 'yes' | 'no' | 'indeterminate'.
 * A server-side image rejection is INDETERMINATE (gateway policy, not model).
 */
async function probeVision(opts) {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Answer with exactly one word: what color is this image?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
      ],
    },
  ];
  try {
    const r = await chatOnce({ ...opts, messages, maxTokens: 16 });
    return r.text && r.text.trim() ? 'yes' : 'yes'; // accepted and answered
  } catch (e) {
    const msg = e.gatewayError || e.message;
    if (looksLikeImageBlocked(msg)) return 'indeterminate';
    // a 400 "does not support image" style error is a genuine 'no'
    if (/does not support|unsupported|not a vision|no image/.test(String(msg).toLowerCase()) && !looksLikeImageBlocked(msg)) return 'no';
    return 'indeterminate';
  }
}

/**
 * Active reasoning probe at one effort level. Returns true if reasoning
 * evidently happened (reasoning tokens > 0 or reasoning text present).
 */
async function probeReasoningAt(opts, wireEffort) {
  const messages = [
    { role: 'user', content: 'A farmer has 17 sheep, all but 9 die. How many remain? Answer with just the number.' },
  ];
  try {
    // reasoning models need headroom before they emit thinking tokens; a tiny
    // cap can truncate before any reasoning is produced, yielding a false
    // negative. 256 is enough for a short chain without wasting quota.
    const r = await chatOnce({ ...opts, effort: wireEffort, messages, maxTokens: 256 });
    if (r.reasoningTokens !== undefined) return r.reasoningTokens > 0;
    if (r.reasoningText && r.reasoningText.trim().length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Full probe of one endpoint.
 * @returns {Promise<{baseURL, models: NormalizedModel[]}>}
 */
export async function probeEndpoint({
  baseURL,
  apiKey,
  extraHeaders = {},
  activeProbe = true,
  probeVision: doVision = true,
  probeReasoning: doReasoning = true,
  onEvent = () => {},
}) {
  if (!baseURL) throw new Error('baseURL required');
  onEvent({ type: 'listing', baseURL });
  const listing = await getJson(`${trimTrailingSlash(baseURL)}/models`, apiKey, extraHeaders);
  const raws = readListing(listing);
  onEvent({ type: 'listed', count: raws.length });

  /** Probe ONE model record (metadata + active verification). */
  const probeOne = async (raw, index) => {
    const id = String(pick(raw.id, raw.model, raw.name) || '');
    if (!id) return null;
    const name = pick(raw.name, raw.display_name, raw.displayName, id);

    // 1) start from listing-derived capability truth
    let input = readModalities(raw);
    const inputFromListing = input.length > 0;
    const levelsFromListing = readReasoningLevels(raw);
    let levels = [...levelsFromListing];
    const contextWindow = readContext(raw);
    const maxTokens = readMaxTokens(raw);

    const record = {
      id,
      name,
      contextWindow,
      maxTokens,
      input: inputFromListing ? input : undefined,
      reasoningEfforts: levels.length > 0 ? levels : undefined,
      probes: {},
      index,
    };
    onEvent({ type: 'model-start', id, index, total: raws.length });

    // 2) active verification / gap-filling
    if (activeProbe) {
      // vision
      if (doVision) {
        const v = await probeVision({ baseURL, apiKey, model: id, extraHeaders });
        record.probes.vision = v;
        if (!inputFromListing) {
          if (v === 'yes') {
            input = ['text', 'image'];
            record.input = input;
          } else if (v === 'no') {
            record.input = ['text'];
          }
          // indeterminate: leave undefined
        } else if (v === 'no' && input.includes('image')) {
          // listing claimed image but active probe cleanly refused -> trust probe
          record.probes.visionConflict = true;
          record.input = ['text'];
        }
      }
      // reasoning
      if (doReasoning) {
        const baseLevels = levels.length > 0 ? levels : ['low', 'medium', 'high'];
        const kept = [];
        for (const lvl of baseLevels) {
          if (lvl === 'off') {
            kept.push(lvl); // off is always offerable; it means "don't send"
            continue;
          }
          const wire = DEFAULT_WIRE[lvl] ?? lvl;
          const emits = await probeReasoningAt({ baseURL, apiKey, model: id, extraHeaders }, wire);
          const listed = levelsFromListing.includes(lvl);
          // Evidence label: metadata is authoritative; a probe that saw real
          // reasoning tokens corroborates it. A probe miss on a listed level is
          // 'listed' (kept), never a rejection — small caps / gateway quirks can
          // suppress reasoning tokens without meaning the level is unsupported.
          record.probes[`reasoning:${lvl}`] = emits
            ? (listed ? 'listed+verified' : 'verified')
            : (listed ? 'listed' : 'unlisted');
          if (emits || listed) kept.push(lvl);
        }
        // If nothing kept (no metadata and no probe evidence) try a bare call.
        if (kept.filter((l) => l !== 'off').length === 0) {
          const bare = await probeReasoningAt({ baseURL, apiKey, model: id, extraHeaders }, undefined);
          record.probes['reasoning:default'] = bare ? 'verified' : 'none';
          if (bare) kept.push('low', 'medium', 'high');
        }
        levels = THINKING_LEVELS.filter((l) => kept.includes(l));
        record.reasoningEfforts = levels.length > 0 ? levels : undefined;
      }
    }

    // ensure text is always present when we do declare modalities
    if (record.input && !record.input.includes('text')) record.input.unshift('text');
    onEvent({
      type: 'model-done',
      id,
      index,
      total: raws.length,
      input: record.input,
      levels: record.reasoningEfforts,
      contextWindow,
      maxTokens,
    });
    return record;
  };

  // Probe models CONCURRENTLY with a small cap: gateways tolerate a handful of
  // parallel small requests, and this turns ~25 serial round trips into ~4
  // waves. Failures are isolated per model — one broken model never drops the
  // rest (its record is null and simply omitted, matching the old behavior of
  // skipping entries without an id).
  const CONCURRENCY = 4;
  const results = new Array(raws.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, raws.length) }, async () => {
    while (cursor < raws.length) {
      const at = cursor++;
      try {
        results[at] = await probeOne(raws[at], at);
      } catch (error) {
        results[at] = null;
        onEvent({ type: 'model-error', index: at, message: error && error.message ? error.message : String(error) });
      }
    }
  });
  await Promise.all(workers);

  const models = results.filter(Boolean);
  return { baseURL, models };
}
