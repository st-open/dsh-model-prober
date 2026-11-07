/**
 * dsh-model-prober — public library entry.
 *
 * Probe a third-party OpenAI-compatible endpoint and generate fully-explicit
 * dsh-llm-pi-ai model configuration (vision, reasoning efforts, context),
 * with no hidden "Default" reasoning effort.
 */
export { probeEndpoint, THINKING_LEVELS, DEFAULT_WIRE } from './probe.js';
export { pickDefaultEffort, THINKING_ORDER } from './default-effort.js';
export { generateYaml, summarizeTable } from './generate.js';
