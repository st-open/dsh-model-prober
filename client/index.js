window.__ModuleLoader__.load({
  id: 'dsh-model-prober',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useCallback } = React;

    const NAME_SENTINEL = '\u241Fmp`';
    const PROBE_NS = 'model-prober';

    function decodeName(name) {
      if (typeof name !== 'string') return { displayName: name, input: null, reasoningEfforts: null };
      const at = name.indexOf(NAME_SENTINEL);
      if (at < 0) return { displayName: name, input: null, reasoningEfforts: null };
      const displayName = name.slice(0, at);
      const rest = name.slice(at + NAME_SENTINEL.length);
      const jsonText = rest.endsWith('`') ? rest.slice(0, -1) : rest;
      try {
        const p = JSON.parse(jsonText);
        return { displayName, input: p.v ?? null, reasoningEfforts: p.r ?? null };
      } catch {
        return { displayName: name, input: null, reasoningEfforts: null };
      }
    }

    /** Walk a plain object by path segments, tolerating missing branches. */
    function atPath(obj, path) {
      let cur = obj;
      for (const key of path || []) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = cur[key];
      }
      return cur;
    }

    /**
     * Highest reasoning level supported by EVERY reasoning model on the
     * provider — mirrors host/index.js pickDefaultEffort. The provider-level
     * `reasoning` field is what dsh reads for the effort picker's default;
     * leaving it unset is exactly what renders the ambiguous "Default".
     */
    function pickDefaultEffort(models) {
      const ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      const sets = (models || [])
        .map((m) => new Set(m.reasoningEfforts ? Object.keys(m.reasoningEfforts).filter((l) => l && l !== 'off') : []))
        .filter((s) => s.size > 0);
      if (sets.length === 0) return undefined;
      const common = ORDER.filter((l) => sets.every((s) => s.has(l)));
      return common.length > 0 ? common[common.length - 1] : undefined;
    }

    if (typeof document !== 'undefined' && !document.getElementById('dsh-model-prober-css')) {
      const style = document.createElement('style');
      style.id = 'dsh-model-prober-css';
      style.textContent =
        '.mp-btn{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0;border-radius:14px;height:28px;padding:0 10px;font-size:12px;line-height:18px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;margin-top:8px}' +
        '.mp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
        '.mp-btn:disabled{opacity:.4;cursor:default}' +
        '.mp-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-left:8px}' +
        '.mp-status.err{color:var(--dsw-alias-state-error-primary)}' +
        '.mp-status.ok{color:var(--dsw-alias-state-success-primary)}' +
        '.mp-report{width:100%;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}' +
        '.mp-report-lines{display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto}' +
        '.mp-line{font-family:var(--ds-font-family-code,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}';
      document.head.appendChild(style);
    }

    function ProbeButton(props) {
      const { provider, services } = props;
      const [busy, setBusy] = useState(false);
      const [phase, setPhase] = useState('');   // 进行中的一句话
      const [report, setReport] = useState(null); // {kind, text, lines[]}

      const run = useCallback(async () => {
        setBusy(true);
        setReport(null);
        setPhase('读取配置…');
        try {
          const ns = provider.settingsNs;
          if (!ns) throw new Error('该提供商没有设置命名空间');

          // Read the whole settings document (0-arg describe), then locate our ns.
          const described = await services.remote.settings.describe();
          if (!described || described.ok === false) throw new Error('读取设置失败');
          const view = described.value || {};
          const row = (view.namespaces || []).find((n) => n.ns === ns);
          if (!row) throw new Error('找不到该提供商的设置段');

          // `value` is the merged (schema+base+user) section; the provider leaf
          // lives at settingsPath (pi-ai: ["providers", <route>]).
          const basePath = Array.isArray(provider.settingsPath) ? provider.settingsPath : ['providers', provider.provider];
          const leaf = atPath(row.value, basePath) || {};
          const baseURL = leaf.baseURL || leaf.baseUrl;
          const api = leaf.api;
          if (!baseURL) throw new Error('该提供商未填写 API 地址');

          const before = Array.isArray(leaf.models) ? leaf.models : [];
          const beforeById = new Map(before.map((m) => [m.id, m]));

          setPhase('探测中（逐个模型实测识图与思考强度）…');
          const reply = await services.remote.llm.discoverModels(PROBE_NS, {
            provider: provider.provider,
            baseURL,
            ...(api ? { api } : {}),
          });
          if (!reply || reply.ok === false) {
            throw new Error((reply && reply.error && reply.error.message) || '探测失败');
          }
          const found = reply.value || [];
          if (found.length === 0) throw new Error('未探测到任何模型');

          setPhase('回填结果…');
          const models = found.map((m) => {
            const cap = decodeName(m.name);
            const entry = { id: m.id, name: cap.displayName || m.id };
            if (m.contextWindow) entry.contextWindow = m.contextWindow;
            if (m.maxTokens) entry.maxTokens = m.maxTokens;
            if (cap.input) entry.input = cap.input;
            if (cap.reasoningEfforts && cap.reasoningEfforts.length) {
              const eff = {};
              for (const lvl of cap.reasoningEfforts) eff[lvl] = lvl === 'off' ? 'none' : lvl;
              entry.reasoningEfforts = eff;
            }
            return entry;
          });

          // Provider-level DEFAULT effort — the piece that kills the ambiguous
          // "Default" label. dsh derives the picker's default from the
          // provider `reasoning` field, not from per-model efforts, so we
          // compute the highest level every reasoning model supports and pin
          // it explicitly.
          const defaultEffort = pickDefaultEffort(models);

          const ops = [{ op: 'set', path: [...basePath, 'models'], value: models }];
          if (defaultEffort) {
            ops.push({ op: 'set', path: [...basePath, 'reasoning'], value: defaultEffort });
          }
          const written = await services.remote.settings.mutate(ns, ops, row.revision);
          if (!written || written.ok === false) throw new Error((written && written.error && written.error.message) || '写回设置失败');

          // ---- 变更报告: 明确列出每个模型补了什么 ----
          const describeVision = (v) => (v === undefined || v === null ? '未知' : v && v.includes && v.includes('image') ? '可识图' : '纯文本');
          const lines = [];
          let added = 0, updated = 0;
          for (const m of models) {
            const old = beforeById.get(m.id);
            const vision = describeVision(m.input);
            const efforts = m.reasoningEfforts ? Object.keys(m.reasoningEfforts).join('/') : '无';
            if (!old) {
              added++;
              lines.push(`＋ ${m.name || m.id}（新增：${vision}，强度 ${efforts}）`);
              continue;
            }
            const oldVision = describeVision(old.input);
            const oldEfforts = old.reasoningEfforts ? Object.keys(old.reasoningEfforts).join('/') : '无';
            const changedVision = vision !== oldVision;
            const changedEfforts = efforts !== oldEfforts;
            const changedCtx = (m.contextWindow || 0) !== (old.contextWindow || 0) || (m.maxTokens || 0) !== (old.maxTokens || 0);
            if (changedVision || changedEfforts || changedCtx) {
              updated++;
              const what = [];
              if (changedVision) what.push(`识图 ${oldVision}→${vision}`);
              if (changedEfforts) what.push(`强度 ${oldEfforts}→${efforts}`);
              if (changedCtx) what.push('上下文更新');
              lines.push(`↻ ${m.name || m.id}（${what.join('，')}）`);
            } else {
              lines.push(`✓ ${m.name || m.id}（${vision}，强度 ${efforts}，无变化）`);
            }
          }
          const summary = `探测完成：${models.length} 个模型` + (added ? `，新增 ${added}` : '') + (updated ? `，更新 ${updated}` : '') + '。';
          setReport({ kind: 'ok', text: summary, lines });
        } catch (e) {
          setReport({ kind: 'err', text: `探测失败：${(e && e.message) || String(e)}`, lines: [] });
        } finally {
          setPhase('');
          setBusy(false);
        }
      }, [provider, services]);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', marginTop: 8, gap: 4 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'button',
            { className: 'mp-btn', disabled: busy, onClick: run, title: '探测该接口能力：识图 / 思考强度 / 上下文，并回填模型目录' },
            busy ? '探测中…' : '探测能力',
          ),
          phase ? h('span', { className: 'mp-status' }, phase) : null,
          report && !report.lines.length ? h('span', { className: 'mp-status ' + (report.kind === 'ok' ? 'ok' : 'err') }, report.text) : null,
        ),
        report && report.lines.length
          ? h(
              'div',
              { className: 'mp-report' },
              h('div', { className: 'mp-status ' + (report.kind === 'ok' ? 'ok' : 'err') }, report.text),
              h(
                'div',
                { className: 'mp-report-lines' },
                report.lines.map((line, i) => h('div', { key: i, className: 'mp-line' }, line)),
              ),
            )
          : null,
      );
    }

    const inject = ['slots', 'remote', 'remote.llm', 'remote.settings'];

    function apply(ctx) {
      const services = { remote: ctx.remote };

      const registerFor = (entries) => {
        const disposers = [];
        for (const entry of entries) {
          const ns = entry.settingsNs;
          if (typeof ns !== 'string' || ns.length === 0) continue;
          // One scope controller per provider card (lives on this plugin's fiber).
          const dispose = ctx.slots.inject('settings.models.provider-card', () =>
            ctx.slots.register(
              { name: 'settings.models.provider-card', key: ns, order: 50 },
              (ownerProps) => h(ProbeButton, { provider: ownerProps.provider, services }),
            ),
          );
          disposers.push(dispose);
        }
        return disposers;
      };

      let disposers = [];
      const refresh = async () => {
        try {
          const reply = await ctx.remote.llm.listConfigurableProviders();
          const entries = reply && reply.ok !== false ? reply.value || [] : [];
          for (const d of disposers) {
            try {
              d();
            } catch {}
          }
          disposers = registerFor(entries);
        } catch {}
      };

      ctx.effect(() => {
        refresh();
        const off = ctx.remote.$on ? ctx.remote.$on('llm/adapters-updated', refresh) : () => {};
        return () => {
          try {
            off();
          } catch {}
          for (const d of disposers) {
            try {
              d();
            } catch {}
          }
        };
      }, 'dsh-model-prober: provider-card probe buttons');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
