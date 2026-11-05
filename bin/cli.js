#!/usr/bin/env node
/**
 * dsh-model-prober CLI
 *
 * Probe a third-party OpenAI-compatible endpoint and emit dsh pi-ai model
 * configuration with fully-explicit capabilities.
 *
 * Usage:
 *   dsh-model-prober probe   --base-url <URL> [--api-key <KEY>] [--provider wb] [--api openai-completions] [--api-key-env WB_API_KEY] [--no-active] [--json]
 *   dsh-model-prober write   --base-url <URL> ... --config <path/to/cordis.patch.yml> [--entry-id llm-pi-ai] [--provider wb]
 *
 * The API key may also come from $DSH_PROBER_API_KEY or the env var named by
 * --api-key-env (default WB_API_KEY), so it need not appear in shell history.
 */

import fs from 'node:fs';
import { probeEndpoint } from '../lib/probe.js';
import { generateYaml, summarizeTable } from '../lib/generate.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const neg = key.startsWith('no-');
      const name = neg ? key.slice(3) : key;
      const next = argv[i + 1];
      const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (neg) {
        out[camel] = false;
      } else if (next === undefined || next.startsWith('--')) {
        out[camel] = true;
      } else {
        out[camel] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function resolveApiKey(args) {
  if (args.apiKey) return args.apiKey;
  if (process.env.DSH_PROBER_API_KEY) return process.env.DSH_PROBER_API_KEY;
  const envName = args.apiKeyEnv || 'WB_API_KEY';
  if (process.env[envName]) return process.env[envName];
  return undefined;
}

function usage() {
  console.error(`dsh-model-prober — probe third-party models and emit fully-explicit dsh config

  probe   --base-url <URL> [--api-key <KEY>] [--provider wb] [--api openai-completions]
          [--api-key-env WB_API_KEY] [--no-active] [--json] [--out <file>]
  write   --base-url <URL> --config <cordis.patch.yml> [--entry-id llm-pi-ai]
          [--provider wb] [--api-key <KEY>] [--api-key-env WB_API_KEY]

Notes:
  --no-active   metadata only (fast; no image/reasoning calls)
  API key can come from --api-key, $DSH_PROBER_API_KEY, or $<--api-key-env>.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  if (!args.baseUrl) {
    console.error('error: --base-url is required');
    process.exit(1);
  }
  const apiKey = resolveApiKey(args);
  const providerId = args.provider || 'wb';
  const api = args.api || 'openai-completions';

  const onEvent = (e) => {
    if (args.json) return;
    if (e.type === 'listing') console.error(`→ fetching ${e.baseURL}/models ...`);
    else if (e.type === 'listed') console.error(`  found ${e.count} models`);
    else if (e.type === 'model-start') console.error(`  [${e.index + 1}/${e.total}] probing ${e.id} ...`);
    else if (e.type === 'model-done') console.error(`  [${e.index + 1}/${e.total}] ${e.id}  vision=${e.input ? (e.input.includes('image') ? 'yes' : 'no') : '?'}  efforts=${e.levels ? e.levels.join('/') : '(none)'}`);
    else if (e.type === 'model-error') console.error(`  [${e.index + 1}] FAILED: ${e.message}`);
  };

  const final = await probeEndpoint({
    baseURL: args.baseUrl,
    apiKey,
    activeProbe: args.active !== false,
    onEvent,
  });

  if (cmd === 'probe') {
    if (args.json) {
      console.log(JSON.stringify(final, null, 2));
      return;
    }
    console.log('\n' + summarizeTable(final.models) + '\n');
    const yaml = generateYaml({
      entryId: args.entryId || 'llm-pi-ai',
      providerId,
      apiKeyEnv: args.apiKeyEnv || 'WB_API_KEY',
      api,
      baseURL: final.baseURL,
      models: final.models,
    });
    if (args.out) {
      fs.writeFileSync(args.out, yaml);
      console.error(`\nwrote config fragment to ${args.out}`);
    } else {
      console.log('--- cordis.patch.yml fragment ---');
      console.log(yaml);
    }
    return;
  }

  if (cmd === 'write') {
    if (!args.config) {
      console.error('error: write requires --config <cordis.patch.yml>');
      process.exit(1);
    }
    const yaml = generateYaml({
      entryId: args.entryId || 'llm-pi-ai',
      providerId,
      apiKeyEnv: args.apiKeyEnv || 'WB_API_KEY',
      api,
      baseURL: final.baseURL,
      models: final.models,
    });
    fs.writeFileSync(args.config, yaml);
    console.error(`wrote ${args.config}`);
    return;
  }

  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
