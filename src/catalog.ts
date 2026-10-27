/**
 * CoRouter 模型目录（仅对话模型，供 llm 适配器的模型选择器使用）。
 *
 * 取证来源：
 * - 模型 ID / 显示名 / 供应商 / 单价：`https://corouter.open-design.ai/zh/models/<slug>/`
 *   详情页内联 `data-model="{...}"` JSON（公开页面，2026-10-26）。
 * - group：官网首页套餐卡 `https://corouter.open-design.ai/zh/` 的
 *   `data-model-module="design-plan"` 12 款归 `plan`；其余在售对话模型归 `paid`。
 * - `plan` 12 款的 contextWindow / maxOutputTokens / inputModalities / reasoningEfforts
 *   来自 Go 侧 `dsh-opendesign-go` 0.1.9 的 MODEL_DEFAULTS（同一 `amr-link` endpoint 部署资料），
 *   作为部署参考，尚无官网能力数值的独立佐证；只用于对应的原有 12 款模型。
 * - 客户端桌面安装（Open Design 0.26.1）不内联 CoRouter 目录；其
 *   `vela model preset --format json` 只有 11 个旧预设 id（见 docs/client-evidence.md），
 *   与本表不同代，故不用于本目录。
 *
 * 分组语义（重要）：`plan`/`paid` 是**本插件本地目录分类**，用于把“套餐赠送通道”与
 * “其余付费通道”拆成两个 Provider，不是上游强制计费契约。最终可用性、扣哪个额度池、
 * 是否先扣 Design Plan 额度再用套餐模型/钱包额度，全部由服务端按账号套餐决定。
 * 2026-10-27 官方 GET /v1/models 实测补齐五个 ID，现为 plan 13 + paid 25。
 * 同日桌面 Vela 按模型 billing preflight：M3.1 Flash 的 modelCovered=true /
 * funding=coding_plan，新增于附赠通道；其余四项为 false / wallet，归付费通道。
 * 此分类以当次工作区证据为依据，不保证其他账号或未来套餐权益。
 * 新增项证据及名称来源见 docs/client-evidence.md；不从型号名推断能力。
 *
 * 未收录：
 * - 媒体模型 `GPT Image 2`、`Nano Banana 2`、`Seedream 5 Lite / Pro`：
 *   走 `/api/v1/media/*`，不应出现在对话模型列表里，避免选中后 chat 请求必败。
 *
 * `paid` 25 款及新增 M3.1 Flash 的能力字段一律缺省：没有可核实的能力数值，
 * 未知模态保持缺省；`['text']` 仅表示已确认的纯文本输入。
 */
export interface CatalogModel {
  id: string;
  name: string;
  group: 'plan' | 'paid';
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: readonly ('text' | 'image')[];
  reasoningEfforts?: readonly string[];
}

const TEXT_ONLY = ['text'] as const;
const TEXT_AND_IMAGE = ['text', 'image'] as const;

/** Go 0.1.9 MODEL_DEFAULTS 里的思考档位集合（同 amr-link endpoint 部署资料）。 */
const EFFORTS_FULL = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const;
const EFFORTS_STD = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORTS_LOW_HIGH = ['low', 'high', 'max'] as const;

/**
 * `plan` 为官网 12 款 Core / Design Plan 模型，加预检确认覆盖的 M3.1 Flash；
 * 其余 25 项归 `paid`（Plan / 钱包付费通道）。
 */
export const MODELS: readonly CatalogModel[] = [
  // ── OpenAI（7） ─────────────────────────────────────────────
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', group: 'paid' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', group: 'paid' },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    group: 'plan',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_FULL,
  },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', group: 'paid' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', group: 'paid' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', group: 'paid' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', group: 'paid' },

  // ── Anthropic（8） ──────────────────────────────────────────
  { id: 'claude-fable-5.1', name: 'Claude Fable 5.1', group: 'paid' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', group: 'paid' },
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', group: 'paid' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', group: 'paid' },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', group: 'paid' },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', group: 'paid' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', group: 'paid' },
  {
    id: 'claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_STD,
  },

  // ── DeepSeek（4） ───────────────────────────────────────────
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_FULL,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_ONLY,
    reasoningEfforts: EFFORTS_FULL,
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_FULL,
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision Exp',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_FULL,
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
  { id: 'glm-5.2', name: 'GLM-5.2', group: 'paid' },

  // ── Moonshot（3） ───────────────────────────────────────────
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    group: 'plan',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_STD,
  },
  { id: 'kimi-k3', name: 'Kimi K3', group: 'paid' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', group: 'paid' },

  // ── Google（3） ─────────────────────────────────────────────
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', group: 'paid' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', group: 'paid' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', group: 'paid' },

  // ── xAI（3） ────────────────────────────────────────────────
  { id: 'grok-4.7', name: 'Grok 4.7', group: 'paid' },
  { id: 'grok-4.6', name: 'Grok 4.6', group: 'paid' },
  { id: 'grok-4.5', name: 'Grok 4.5', group: 'paid' },

  // ── Xiaomi（2） ─────────────────────────────────────────────
  {
    id: 'mimo-v2.6-pro',
    name: 'MiMo V2.6 Pro',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_STD,
  },
  {
    id: 'mimo-v2.6-flash',
    name: 'MiMo V2.6 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_STD,
  },

  // ── Tencent（1） ────────────────────────────────────────────
  {
    id: 'hy4-preview',
    name: 'Hunyuan H4 Preview',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputModalities: TEXT_ONLY,
    reasoningEfforts: EFFORTS_STD,
  },

  // ── Alibaba（1） ────────────────────────────────────────────
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', group: 'paid' },

  // Official API additions; display labels for undocumented entries are local formatting.
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', group: 'plan' },
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', group: 'paid' },
  { id: 'muse-wonder', name: 'Muse Wonder', group: 'paid' },
];

const BY_ID = new Map(MODELS.map(model => [model.id, model] as const));

export function modelsFor(group: 'plan' | 'paid'): readonly CatalogModel[] {
  return MODELS.filter(model => model.group === group);
}

export function findModel(id: string): CatalogModel | undefined {
  return BY_ID.get(id);
}
