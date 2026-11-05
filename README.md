# dsh-model-prober

接入第三方 OpenAI 兼容模型时，**自动探测模型真实能力**并生成**完全显式**的 dsh（`@deepseek-ai/dsh-llm-pi-ai`）配置——不用再手写「能不能识图」「有哪些思考强度」「上下文多大」，也**不会留下含义不明的 `Default` 强度**。

## 为什么需要它

dsh 自带的「Fetch available models」只会回填 4 个字段：`id / name / contextWindow / maxTokens`。它**不读** `modalities`（识图）和 `reasoning_levels`（思考强度），所以这两项每次都得手动配——这正是这个插件补上的两块。

dsh 的推理强度如果不写 `reasoningEfforts`，界面只显示 `Model · Default`，对第三方网关来说那个「Default」是不可见的盲盒。本插件把每个模型的**每一个**强度档位都显式写出来。

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

输出：一张能力对照表 + 一段可直接粘贴进 `cordis.patch.yml` 的配置。

```bash
# 直接把结果写进配置文件（会覆盖该 entry，注意先备份）
node bin/cli.js write --base-url http://... --provider wb --api-key-env WB_API_KEY \
  --config ~/.dsh/profiles/desktop/cordis.patch.yml
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
});
console.log(yaml);
```

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

生成的每个模型条目都**显式**带 `input: [text, image]` 与完整的 `reasoningEfforts`（`off` 映射为网关的 `none`），没有任何隐藏默认值。

## 已知边界

- 主动识图探测受网关策略影响，仅作参考；以 `/v1/models` 元数据为准。
- 上下文/输出上限只认元数据；元数据不给就不编造。
- `reasoning_effort` 若网关对任意字符串都静默接受（不校验），则以元数据列出的档位为准，主动探测只用来确认「真实发生了推理」。
