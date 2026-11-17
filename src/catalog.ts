/**
 * CoRouter 模型目录（仅对话模型，供 llm 适配器的模型选择器使用）。
 *
 * 取证来源：
 * - 模型 ID / 显示名 / 供应商 / 单价：`https://corouter.open-design.ai/zh/models/<slug>/`
 *   详情页内联 `data-model="{...}"` JSON（公开页面，2026-10-26）。
 * - group：2026-11-17 scoped preflight 的种子观察（11/35）；运行时必定重新核实，
 *   无匹配账号证据全部标未知，不从此表授予附赠权益。
 * - `plan` 原有 12 款的 contextWindow / maxOutputTokens 与原模态
 *   来自同网关客户端 `dsh-opendesign-go` 0.1.9 的 MODEL_DEFAULTS；该表标为厂商资料，
 *   不能当作网关实测上限。图片模态按最新证据单独核验。
 * - 其余上下文窗口采用厂商公开资料或明确标注的暂定参考，逐型号来源见
 *   docs/model-context.md；CoRouter 实际限制未验证，可以通过模型设置覆盖。
 * - `gpt-6.1-terra` 的 maxOutputTokens / inputModalities 取自厂商型号文档；
 *   新型号 Fable 5.2、Hy4/Flash、Qwen4 Max 的独立资料见 docs/model-context.md。
 * - 客户端桌面安装（Open Design 0.26.1）不内联 CoRouter 目录；其
 *   `vela model preset --format json` 只有 11 个旧预设 id（见 docs/client-evidence.md），
 *   与本表不同代，故不用于本目录。
 *
 * 分组语义（重要）：`plan`/`paid` 是**本插件本地目录分类**，用于把“套餐赠送通道”与
 * “其余付费通道”拆成两个 Provider，不是上游强制计费契约。最终可用性、扣哪个额度池、
 * 是否先扣 Design Plan 额度再用套餐模型/钱包额度，全部由服务端按账号套餐决定。
 * 2026-11-17 scoped remote 57 项，过滤媒体后 46；账号预检 11 covered / 35 not covered。
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
  /** A paired account preflight, never the seed classification, establishes coverage. */
  coverage?: 'included' | 'not-included' | 'unknown';
  /** Preferred wire format backed by model-specific API evidence. */
  nativeProtocol?: 'chat-completions' | 'responses' | 'messages';
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: readonly ('text' | 'image')[];
  /** Undefined means unconfirmed; an empty array means no discrete effort selector. */
  reasoningEfforts?: readonly string[];
  /**
   * Vendor-documented default effort, always a member of `reasoningEfforts`.
   * The adapter reports it as the route default, so a request that names no
   * effort sends this documented value instead of leaving the choice to an
   * untrusted relay. Omission means the vendor documents no default: nothing
   * is guessed and the provider's own default stands.
   */
  defaultEffort?: string;
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
 * 种子分组不进入实际账号授权；Host 从匹配推理身份的工作区逐型号覆盖。
 *
 * `defaultEffort` 只写有出处的默认档位：厂商文档声明的默认（docs/reasoning-evidence.md 矩阵），
 * 或在厂商未声明时由已发布实现记录的路由默认（GPT-6 Astra=low、Muse Spark 1.3=high）。
 * muse-wonder 的档位集合本身未知，保持缺省：请求不发送档位，由上游决定。
 */
const REFERENCE_MODELS: readonly CatalogModel[] = [
  // ── OpenAI（8） ─────────────────────────────────────────────
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', group: 'paid', contextWindow: 1_050_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'medium' },
  {
    id: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    group: 'paid',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_OPENAI,
    defaultEffort: 'medium',
  },
  // 厂商页只列出档位、未声明默认值；low 取自 Codex CLI 模型注册表的默认 effort 与网关记录。
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', group: 'paid', contextWindow: 1_050_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'low' },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    group: 'paid',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_OPENAI,
    defaultEffort: 'medium',
  },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', group: 'paid', contextWindow: 1_050_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_OPENAI, defaultEffort: 'medium' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', group: 'paid', contextWindow: 1_050_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_OPENAI, defaultEffort: 'medium' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', group: 'paid', contextWindow: 1_050_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_OPENAI, defaultEffort: 'medium' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', group: 'paid', contextWindow: 1_050_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_OPENAI, defaultEffort: 'medium' },

  // ── Anthropic（8） ──────────────────────────────────────────
  { id: 'claude-fable-5.2', name: 'Claude Fable 5.2', group: 'paid', contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'high' },
  { id: 'claude-fable-5.1', name: 'Claude Fable 5.1', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'high' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'high' },
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'medium' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'high' },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'high' },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'high' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'high' },
  {
    id: 'claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    group: 'paid',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_REASONING,
    defaultEffort: 'medium',
  },

  // ── DeepSeek（4） ───────────────────────────────────────────
  // Exact route confirmed by Link; Eco-specific capability evidence is not published.
  { id: 'deepseek-v4.1-flash-eco', name: 'DeepSeek V4.1 Flash Eco', group: 'plan' },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
    defaultEffort: 'high',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    reasoningEfforts: EFFORTS_LOW_HIGH,
    defaultEffort: 'high',
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
    defaultEffort: 'high',
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision Exp',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
    defaultEffort: 'high',
  },

  // ── Z.ai（3） ───────────────────────────────────────────────
  {
    id: 'glm-5.3-flashx',
    name: 'GLM-5.3 Flash-X',
    group: 'paid',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
    defaultEffort: 'max',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: TEXT_AND_IMAGE,
    reasoningEfforts: EFFORTS_LOW_HIGH,
    defaultEffort: 'max',
  },
  { id: 'glm-5.2', name: 'GLM-5.2', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_ONLY, reasoningEfforts: EFFORTS_GLM52, defaultEffort: 'max' },

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
  { id: 'kimi-k3', name: 'Kimi K3', group: 'paid', contextWindow: 1_048_576, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LOW_HIGH, defaultEffort: 'max' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', group: 'paid', contextWindow: 1_048_576, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LOW_HIGH, defaultEffort: 'max' },

  // ── Google（3） ─────────────────────────────────────────────
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', group: 'paid' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', group: 'paid', contextWindow: 1_048_576, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LEVELS, defaultEffort: 'medium' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', group: 'paid', contextWindow: 1_048_576, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LEVELS, defaultEffort: 'medium' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', group: 'paid', contextWindow: 1_048_576, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LEVELS, defaultEffort: 'medium' },

  // ── xAI（3） ────────────────────────────────────────────────
  { id: 'grok-4.7', name: 'Grok 4.7', group: 'paid', contextWindow: 500_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_GROK, defaultEffort: 'high' },
  { id: 'grok-4.6', name: 'Grok 4.6', group: 'paid', contextWindow: 500_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_GROK, defaultEffort: 'high' },
  { id: 'grok-4.5', name: 'Grok 4.5', group: 'paid', contextWindow: 500_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_LEVELS, defaultEffort: 'high' },

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
  { id: 'hy4', name: 'Hy4', group: 'paid', contextWindow: 1_000_000, maxOutputTokens: 64_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: ['high'], defaultEffort: 'high' },
  { id: 'hy4-flash', name: 'Hy4 Flash', group: 'paid', contextWindow: 1_000_000, maxOutputTokens: 64_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: ['high'], defaultEffort: 'high' },
  {
    id: 'hy4-preview',
    name: 'Hunyuan H4 Preview',
    group: 'plan',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputModalities: TEXT_ONLY,
    reasoningEfforts: ['none', 'high'],
    defaultEffort: 'high',
  },

  // ── Alibaba（1） ────────────────────────────────────────────
  // 131072 is the conservative output cap across both thinking modes, not their combined budget.
  { id: 'qwen4-max', name: 'Qwen4 Max', group: 'paid', contextWindow: 1_000_000, maxOutputTokens: 131_072, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', group: 'paid', contextWindow: 1_000_000, inputModalities: TEXT_ONLY, reasoningEfforts: [] },

  // Official API additions; display labels for undocumented entries are local formatting.
  { id: 'muse-ember-1.0', name: 'Muse Ember 1.0', group: 'paid' },
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', group: 'plan', contextWindow: 1_000_000, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_REASONING, defaultEffort: 'max' },
  // 厂商只说默认“由模型决定”；high 取自 Meta 合作客户端与网关实现的默认 effort。
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', group: 'paid', contextWindow: 1_048_576, inputModalities: TEXT_AND_IMAGE, reasoningEfforts: EFFORTS_MUSE, defaultEffort: 'high' },
  { id: 'muse-wonder', name: 'Muse Wonder', group: 'paid', contextWindow: 1_048_576 },
];

// Exact-ID API evidence, not vendor-prefix inference. DeepSeek's own Responses API is
// preferred over the gateway Chat path with outstanding effort/tool reports (#9232/#9368).
const NATIVE_PROTOCOLS: Readonly<Record<string, NonNullable<CatalogModel['nativeProtocol']>>> = {
  'gpt-6.1-sol': 'responses', 'gpt-6.1-terra': 'responses', 'gpt-6-astra': 'responses',
  'gpt-6-luna': 'responses', 'gpt-6-sol': 'responses', 'gpt-5.6-luna': 'responses', 'gpt-5.6-sol': 'responses', 'gpt-5.6-terra': 'responses',
  'claude-fable-5.2': 'messages', 'claude-fable-5.1': 'messages', 'claude-fable-5': 'messages',
  'claude-opus-5.5': 'messages', 'claude-opus-5': 'messages', 'claude-opus-4.8': 'messages',
  'claude-sonnet-5.5': 'messages', 'claude-sonnet-5': 'messages', 'claude-haiku-5.5': 'messages',
  'deepseek-v4.1-flash': 'responses', 'deepseek-v4-pro': 'responses', 'deepseek-v4-flash': 'responses', 'deepseek-v4-flash-vision-exp': 'responses',
  'kimi-k3.1-pro': 'chat-completions', 'kimi-k3': 'chat-completions', 'kimi-k2.7-code': 'chat-completions',
  'glm-5.3-flash': 'chat-completions', 'glm-5.3-flashx': 'chat-completions', 'glm-5.2': 'chat-completions',
  'mimo-v2.6-pro': 'chat-completions', 'mimo-v2.6-flash': 'chat-completions', 'qwen3.7-max': 'chat-completions', 'hy4-preview': 'chat-completions',
};
export const MODELS: readonly CatalogModel[] = REFERENCE_MODELS.map(row => ({ ...row, ...(NATIVE_PROTOCOLS[row.id] ? { nativeProtocol: NATIVE_PROTOCOLS[row.id]! } : {}) }));

const BY_ID = new Map(MODELS.map(model => [model.id, model] as const));

export function modelsFor(group: 'plan' | 'paid'): readonly CatalogModel[] {
  return MODELS.filter(model => model.group === group);
}

export function findModel(id: string): CatalogModel | undefined {
  return BY_ID.get(id);
}
