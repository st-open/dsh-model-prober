# dsh-model-prober

接入第三方 OpenAI 兼容模型时，**自动探测模型真实能力**并生成**完全显式**的 dsh（`@deepseek-ai/dsh-llm-pi-ai`）配置——不用再手写「能不能识图」「有哪些思考强度」「上下文多大」，也**不会留下含义不明的 `Default` 强度**。

## 为什么需要它

dsh 自带的「Fetch available models」只会回填 4 个字段：`id / name / contextWindow / maxTokens`。它**不读** `modalities`（识图）和 `reasoning_levels`（思考强度），所以这两项每次都得手动配——这正是这个插件补上的两块。

dsh 的推理强度有两层，缺一就会看到含义不明的 `Default`：

- **模型级 `reasoningEfforts`**：该模型有哪些档位可选。不写则整个模型按非推理处理，连档位选择都不出现。
- **渠道级 `reasoning`**：模型选择器里显示的**默认档**。不写则 UI 显示 `Model · Default`——对第三方网关来说这个「Default」实际是什么强度，完全不可见。

本插件两层都显式回填：每个模型的**每一个**档位写进 `reasoningEfforts`；再把「所有推理模型共同支持的最高档」写进渠道级 `reasoning`，让选择器直接显示具体档名（如 `Model · High`），而不是盲盒 Default。

## 它怎么「探」

1. **拉取 `/v1/models`** —— 这是能力的权威来源。读取各种拼写：
   - 识图：`modalities.input` / `input_modalities` / `capabilities`
   - 思考强度：`supported_reasoning_levels` / `reasoning_levels` / `reasoning:true`
   - 上下文：`context_length` / `context_window` / `max_input_tokens` …
   - 输出上限：`max_output_tokens` / `max_tokens` …
2. **主动实测（active probe）** —— 对每个模型实际发请求验证：
   - **思考强度**：逐档发 `reasoning_effort`，检查回复里的 `reasoning_tokens > 0` 或 `reasoning_content` 是否存在，确认该档位真的在思考。
   - **识图**：发一张 1×1 PNG，看模型是否接受并作答。
   - **上下文/输出**：以上限元数据为准；缺失则留空（绝不瞎猜）。

### 一个重要的诚实设计

某些网关（如带会话状态的中转网关）会在**服务端**拦截图片（返回类似 `Please start a new conversation, replace the image...` 的错误），或者干脆把图片丢掉让模型瞎答。这种情况下「黑盒识图探测」会得到**假阴性**。

所以本插件采取**保守策略**：

- 如果主动探测被网关拦截 → 判定为 `indeterminate`，**回退到 listing 的 modalities**，绝不因网关策略误报 `no`。
- 只有当 listing 没给 modalities、且主动探测干净地拿到「不支持图片」的回答时，才判 `no`。
- 拿不准的字段会写成 `# TODO` 注释，让你看到「未知」，而不是写错。

一句话：**以元数据为准，主动探测只做确认与补空，不覆盖成假结论。**

## 用法

### 方式一：命令行（推荐）

```bash
# 只读元数据（快，不实际调模型）
node ~/Documents/dsh-model-prober/bin/cli.js probe \
  --base-url https://gateway.example.com/v1 \
  --provider wb --api-key-env WB_API_KEY --no-active

# 完整主动实测（会真的逐个模型发图片/推理请求，稍慢但更可靠）
WB_API_KEY=sk-xxx node ~/Documents/dsh-model-prober/bin/cli.js probe \
  --base-url https://gateway.example.com/v1 \
  --provider wb --api-key-env WB_API_KEY
```

输出：一张能力对照表 + 一段可直接粘贴进 `cordis.patch.yml` 的配置。会在 provider 级写一行 `reasoning: <档位>`（默认取「所有推理模型共同支持的最高档」），这就是去掉 `Default` 的关键那一行。

```bash
# 直接把结果写进配置文件（会覆盖该 entry，注意先备份）
node bin/cli.js write --base-url http://... --provider wb --api-key-env WB_API_KEY \
  --config ~/.dsh/profiles/desktop/cordis.patch.yml

# 想指定默认档（默认自动选最高共同档；可选 off/minimal/low/medium/high/xhigh/max）
node bin/cli.js write --base-url http://... --provider wb --api-key-env WB_API_KEY \
  --default-effort max --config ~/.dsh/profiles/desktop/cordis.patch.yml
```

API key 来源优先级：`--api-key` → `$DSH_PROBER_API_KEY` → `$<--api-key-env>`（默认 `$WB_API_KEY`）。所以 key 不必出现在命令行历史里。

### 方式二：作为库调用

```js
import { probeEndpoint, generateYaml } from 'dsh-model-prober';

const { models } = await probeEndpoint({
  baseURL: 'https://gateway.example.com/v1',
  apiKey: process.env.WB_API_KEY,
  activeProbe: true,          // false = 只读元数据
});

const yaml = generateYaml({
  providerId: 'wb',
  apiKeyEnv: 'WB_API_KEY',
  api: 'openai-completions',
  baseURL: 'https://gateway.example.com/v1',
  models,
  // 默认档：不传则自动取「所有推理模型共同支持的最高档」
  // defaultEffort: 'high',
});
console.log(yaml);
```

也可以用 `pickDefaultEffort(models)` 单独算出会被写进 provider 级的默认档。

## 安装到 profile

本包已经 `link:` 到 `~/.dsh/profiles/desktop/node_modules/dsh-model-prober`（软链）。它的 `cordis.patch.yml` 是**空数组**——它是一个工具/库，不需要常驻在运行时插件图里。想在另一个 profile 用，把它 ln -s 进那个 profile 的 `node_modules` 即可，或写成 `link:` 依赖后 `pnpm install`。

## 输出示例

```
id                                vision  efforts                    context  maxOut
--------------------------------  ------  -------------------------  -------  ------
vendor/hy4free                    yes     high                       960000   64000
vendor/deepseek-v4.1-flash        yes     off/low/high/max           1000000  128000
vendor/glm-5.3                    yes     low/high/max               1000000  64000
vendor/glm-5.3-flash              yes     low/high/max               1000000  131072
vendor/minimax-m3.1-flash         yes     low/medium/high/xhigh/max  1000000  128000
vendor/kimi-k3.1-pro              yes     low/high/max               1000000  32000
```

生成的每个模型条目都**显式**带 `input: [text, image]` 与完整的 `reasoningEfforts`（`off` 映射为网关的 `none`），没有任何隐藏默认值。provider 级还会多一行默认档：

```yaml
      wb:
        apiKeyEnv: WB_API_KEY
        api: openai-responses
        baseURL: http://...
        reasoning: high        # ← 去掉「Default」标签的关键
        models:
          ...
```

## 为什么新会话还看到 `Default`、怎么彻底去掉

`Default`（或 `Model · Default`）只由 **provider 级 `reasoning` 是否为空** 决定，和模型级 `reasoningEfforts` 无关。看到它还残留，通常是以下三种情况：

1. **配置里没写 `reasoning:`**。浏览器「探测能力」按钮会写，但如果你是用 `cli probe` 生成片段再手工粘贴、或手改过 `cordis.patch.yml`，很可能漏了这一行。用新版 `cli write` 或直接补一行即可。
2. **写的档位该模型不支持**。例如 provider 写了 `reasoning: max`，但某个模型只支持到 `high` → 该模型的默认档失效，又退回 `Default`。所以自动策略取「所有推理模型共同支持的最高档」，必要时用 `--default-effort high` 手动压低。
3. **改了 `cordis.patch.yml` 但没重载**。直接改文件未必会热加载；最稳妥的是在 DSH 设置里重新点一次「探测能力」（走 settings 通道、即时生效），或重启 DSH / 刷新页面。

> 说明：模型本身非推理（没有 `reasoningEfforts`）时不会出现 Effort 行，也就没有 `Default` 一说——这是正常的。

## 已知边界

- 主动识图探测受网关策略影响，仅作参考；以 `/v1/models` 元数据为准。
- 上下文/输出上限只认元数据；元数据不给就不编造。
- `reasoning_effort` 若网关对任意字符串都静默接受（不校验），则以元数据列出的档位为准，主动探测只用来确认「真实发生了推理」。
