/**
 * CoRouter 模型目录（仅对话模型，供 llm 适配器的模型选择器使用）。
 *
 * 取证来源：
 * - 模型 ID / 显示名 / 供应商 / 单价：`https://corouter.open-design.ai/zh/models/<slug>/`
 *   详情页内联 `data-model="{...}"` JSON（公开页面，2026-10-26）。
 * - group：官网首页套餐卡 `https://corouter.open-design.ai/zh/` 的
 *   `data-model-module="design-plan"` 12 款归 `plan`；其余在售对话模型归 `paid`。
 * - `plan` 原有 12 款的 contextWindow / maxOutputTokens 与原模态
 *   来自 Go 侧 `dsh-opendesign-go` 0.1.9 的 MODEL_DEFAULTS（同一 `amr-link` endpoint 部署资料），
 *   作为部署参考，尚无官网能力数值的独立佐证；图片模态按最新证据单独核验。
 * - `gpt-6.1-terra` 的 contextWindow / maxOutputTokens / inputModalities 取自
 *   厂商型号文档（1,050,000 / 128,000 / text+image，与 `gpt-6-luna` 同口径）；
 *   CoRouter 网关侧未实测该型号的有效预算。
 * - 客户端桌面安装（Open Design 0.26.1）不内联 CoRouter 目录；其
 *   `vela model preset --format json` 只有 11 个旧预设 id（见 docs/client-evidence.md），
 *   与本表不同代，故不用于本目录。
 *
 * 分组语义（重要）：`plan`/`paid` 是**本插件本地目录分类**，用于把“套餐赠送通道”与
 * “其余付费通道”拆成两个 Provider，不是上游强制计费契约。最终可用性、扣哪个额度池、
 * 是否先扣 Design Plan 额度再用套餐模型/钱包额度，全部由服务端按账号套餐决定。
 * 2026-10-27 官方 GET /v1/models 实测补齐五个 ID，同日厂商型号文档与服务目录
 * 补齐 GPT-6.1 Terra，现为 plan 13 + paid 26。
 * 同日桌面 Vela 按模型 billing preflight：M3.1 Flash 的 modelCovered=true /
 * funding=coding_plan，新增于附赠通道；其余四项为 false / wallet，归付费通道。
 * GPT-6.1 Terra 同为 modelCovered=false / funding=wallet，归付费通道。
 * 此分类以当次工作区证据为依据，不保证其他账号或未来套餐权益。
 * 新增项证据及名称来源见 docs/client-evidence.md；不从型号名推断能力。
 *
 * 未收录：
 * - 媒体模型 `GPT Image 2`、`Nano Banana 2`、`Seedream 5 Lite / Pro`：
 *   走 `/api/v1/media/*`，不应出现在对话模型列表里，避免选中后 chat 请求必败。
 *
 * 思考档位按厂商型号资料记录，来源见 docs/reasoning-evidence.md；网关逐路由行为未实测。
 * 图片输入能力按精确型号的厂商资料补充，证据与网关限制见 docs/model-capabilities.md；
 * 不可确认的模态与容量保持缺省。
 */
export interface CatalogModel {
  id: string;
  name: string;
  group: 'plan' | 'paid';
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: readonly ('text' | 'image')[];
  /** Undefined means unconfirmed; an empty array means no discrete effort selector. */
  reasoningEfforts?: readonly string[];
}

const TEXT_ONLY = ['text'] as const;
const TEXT_AND_IMAGE = ['text', 'image'] as const;

/** Vendor-documented effort sets; per-model sources are in docs/reasoning-evidence.md. */
const EFFORTS_REASONING = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORTS_OPENAI = ['none', ...EFFORTS_REASONING] as const;
const EFFORTS_GLM52 = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORTS_LOW_HIGH = ['low', 'high', 'max'] as const;
const EFFORTS_LEVELS = ['low', 'medium', 'high'] as const;
const EFFORTS_GROK = [...EFFORTS_LEVELS, 'xhigh'] as const;
const EFFORTS_MUSE = ['minimal', ...EFFORTS_REASONING] as const;

/**
 * `plan` 为官网 12 款 Core / Design Plan 模型，加预检确认覆盖的 M3.1 Flash；
 * 其余 26 项归 `paid`（Plan / 钱包付费通道）。
 */
export const MODELS: readonly CatalogModel[] = [
  // ── OpenAI（8） ─────────────────────────────────────────────
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  {
    id: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    group: 'paid',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_OPENAI,
  },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    group: 'plan',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_OPENAI,
  },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_OPENAI },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_OPENAI },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_OPENAI },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_OPENAI },

  // ── Anthropic（8） ──────────────────────────────────────────
  { id: 'claude-fable-5.1', name: 'Claude Fable 5.1', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  { id: 'claude-fable-5', name: 'Claude Fable 5', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  { id: 'claude-opus-5', name: 'Claude Opus 5', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  {
    id: 'claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_REASONING,
  },

  // ── DeepSeek（4） ───────────────────────────────────────────
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    reasoningEfforts: EFFORTS_LOW_HIGH,
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision Exp',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
  },

  // ── Z.ai（3） ───────────────────────────────────────────────
  {
    id: 'glm-5.3-flashx',
    name: 'GLM-5.3 Flash-X',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
  },
  { id: 'glm-5.2', name: 'GLM-5.2', group: 'paid', inputModalities: TEXT_ONLY, reasoningEfforts: EFFORTS_GLM52 },

  // ── Moonshot（3） ───────────────────────────────────────────
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    group: 'plan',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: [],
  },
  { id: 'kimi-k3', name: 'Kimi K3', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LOW_HIGH },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LOW_HIGH },

  // ── Google（3） ─────────────────────────────────────────────
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LEVELS },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LEVELS },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LEVELS },

  // ── xAI（3） ────────────────────────────────────────────────
  { id: 'grok-4.7', name: 'Grok 4.7', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_GROK },
  { id: 'grok-4.6', name: 'Grok 4.6', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_GROK },
  { id: 'grok-4.5', name: 'Grok 4.5', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LEVELS },

  // ── Xiaomi（2） ─────────────────────────────────────────────
  {
    id: 'mimo-v2.6-pro',
    name: 'MiMo V2.6 Pro',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: [],
  },
  {
    id: 'mimo-v2.6-flash',
    name: 'MiMo V2.6 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: [],
  },

  // ── Tencent（1） ────────────────────────────────────────────
  {
    id: 'hy4-preview',
    name: 'Hunyuan H4 Preview',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputModalities: TEXT_ONLY,
    reasoningEfforts: ['none', 'high'],
  },

  // ── Alibaba（1） ────────────────────────────────────────────
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', group: 'paid', inputModalities: TEXT_ONLY, reasoningEfforts: [] },

  // Official API additions; display labels for undocumented entries are local formatting.
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', group: 'plan', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING },
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', group: 'paid', inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_MUSE },
  { id: 'muse-wonder', name: 'Muse Wonder', group: 'paid' },
];

const BY_ID = new Map(MODELS.map(model => [model.id, model] as const));

export function modelsFor(group: 'plan' | 'paid'): readonly CatalogModel[] {
  return MODELS.filter(model => model.group === group);
}

export function findModel(id: string): CatalogModel | undefined {
  return BY_ID.get(id);
}
