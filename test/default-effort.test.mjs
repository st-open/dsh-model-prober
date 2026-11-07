import assert from 'node:assert/strict';
import { pickDefaultEffort } from '../lib/default-effort.js';
import { generateYaml } from '../lib/generate.js';

// --- pickDefaultEffort: highest level common to every reasoning model ---

// hy4free only high; others broaden — common top is high.
assert.equal(
	pickDefaultEffort([
		{ reasoningEfforts: ['high'] },
		{ reasoningEfforts: ['off', 'low', 'high', 'max'] },
		{ reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
		{ reasoningEfforts: ['low', 'high', 'max'] },
	]),
	'high',
);

// dict form is accepted.
assert.equal(pickDefaultEffort([{ reasoningEfforts: { low: 'low', high: 'high' } }]), 'high');

// non-reasoning models (no efforts) are ignored.
assert.equal(
	pickDefaultEffort([{ reasoningEfforts: undefined }, { reasoningEfforts: ['low', 'high'] }]),
	'high',
);

// no reasoning model at all -> undefined (no level is truthful).
assert.equal(pickDefaultEffort([{}, { reasoningEfforts: [] }]), undefined);
assert.equal(pickDefaultEffort([]), undefined);

// "off" alone never becomes the default.
assert.equal(pickDefaultEffort([{ reasoningEfforts: ['off'] }]), undefined);

// --- generateYaml: provider-level reasoning is emitted ---

const yaml = generateYaml({
	providerId: 'wb',
	apiKeyEnv: 'WB_API_KEY',
	baseURL: 'https://example.test/v1',
	models: [
		{ id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100, input: ['text', 'image'], reasoningEfforts: ['off', 'low', 'high'] },
		{ id: 'b', name: 'B', contextWindow: 2000, maxTokens: 200, input: ['text'], reasoningEfforts: ['low', 'high', 'max'] },
	],
});
assert.match(yaml, /^ {8}reasoning: high$/m, 'provider reasoning line present');
assert.match(yaml, /reasoningEfforts:/, 'per-model efforts present');

// Explicit override wins.
const yaml2 = generateYaml({
	providerId: 'wb',
	baseURL: 'https://example.test/v1',
	models: [{ id: 'a', name: 'A', reasoningEfforts: ['low', 'high', 'max'] }],
	defaultEffort: 'max',
});
assert.match(yaml2, /^ {8}reasoning: max$/m);

// No reasoning models -> no provider reasoning line.
const yaml3 = generateYaml({
	providerId: 'x',
	baseURL: 'https://example.test/v1',
	models: [{ id: 'a', name: 'A', input: ['text'] }],
});
assert.doesNotMatch(yaml3, /reasoning:/);

console.log('default-effort + generateYaml: all assertions passed');
