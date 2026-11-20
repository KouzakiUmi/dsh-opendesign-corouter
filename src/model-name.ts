/**
 * 新发现模型的显示名归一化。
 *
 * 网关 `GET /models` 对新 ID 往往只回 id 本身或一个未格式化的名字。这里把 id 本地
 * 格式化成与内置目录一致的可读显示名（如 `gpt-7-sol` → `GPT-7 Sol`、
 * `claude-3-5-sonnet-20241022` → `Claude 3.5 Sonnet 20241022`）。
 *
 * 边界：
 * - 这是**纯本地显示格式化**，不是能力、容量、协议或权益证据；已知 ID 仍沿用目录取证名。
 * - 上游若给出一个与 id 不同的真实名字，尊重上游选择，只做 trim 与空白折叠。
 * - 纯函数、无 I/O、不抛异常；输出有界（≤128），无法格式化时回退原始 id。
 * - 不从名字推断任何能力字段（见 AGENTS.md：能力来自证据或显式覆盖）。
 */

/** 与 model-discovery / remote 的显示名上限一致。 */
export const MAX_MODEL_NAME_LENGTH = 128;

/** 品牌与缩略词的固定大小写；其余词走通用规则。 */
const WORDS: Readonly<Record<string, string>> = {
  gpt: 'GPT', glm: 'GLM', ai: 'AI', api: 'API', llm: 'LLM', vl: 'VL',
  ocr: 'OCR', tts: 'TTS', asr: 'ASR', rl: 'RL', sft: 'SFT', dpo: 'DPO',
  moe: 'MoE', oss: 'OSS', cpu: 'CPU', gpu: 'GPU', tpu: 'TPU', ui: 'UI',
  deepseek: 'DeepSeek', minimax: 'MiniMax', mimo: 'MiMo', chatglm: 'ChatGLM',
  qwq: 'QwQ', hunyuan: 'Hunyuan', ernie: 'ERNIE', flashx: 'Flash-X',
};

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** 单个 id 片段 → 显示词。版本号、日期、尺寸后缀各有规则，其余首字母大写。 */
function mapToken(raw: string): string {
  const fixed = WORDS[raw.toLowerCase()];
  if (fixed !== undefined) return fixed;
  // 紧凑日期（20241022）与已折叠日期（2024-10-22）原样保留。
  if (/^\d{8}$/u.test(raw) || /^\d{4}-\d{2}-\d{2}$/u.test(raw)) return raw;
  // 字母-数字-字母（a3b）整体大写：A3B。
  if (/^[a-z]\d+[a-z]$/iu.test(raw)) return raw.toUpperCase();
  // 数字+尺寸后缀（7b / 32k / 120b）后缀大写：7B / 32K / 120B；4o 这类型号后缀保持小写。
  if (/^\d+[bkm]$/iu.test(raw)) return raw.slice(0, -1) + raw.slice(-1).toUpperCase();
  // 字母开头接数字（v4.1 / k3 / hy4 / qwen4）只大写首字母：V4.1 / K3 / Hy4 / Qwen4。
  if (/^[a-z]\d/iu.test(raw)) return titleCase(raw);
  // 纯数字或数字开头（6.1 / 5 / 1.0）原样。
  if (/^\d/u.test(raw)) return raw;
  // o 系列（o3 / o4-mini）保持厂商小写写法。
  if (/^o\d/iu.test(raw)) return raw;
  return titleCase(raw);
}

/** 拆分并折叠 id 片段：年-月-日合并为日期词，相邻 1–2 位整数合并为版本号。 */
function collapse(id: string): string[] {
  const parts = id.split(/[-_/:]+/u).filter(part => part !== '');
  const out: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const next = parts[index + 1] ?? '';
    const after = parts[index + 2] ?? '';
    if (/^\d{4}$/u.test(part) && /^\d{2}$/u.test(next) && /^\d{2}$/u.test(after)) {
      out.push(`${part}-${next}-${after}`);
      index += 2;
      continue;
    }
    const previous = out[out.length - 1];
    if (previous !== undefined && /^\d{1,2}$/u.test(previous) && /^\d{1,2}$/u.test(part)) {
      out[out.length - 1] = `${previous}.${part}`;
      continue;
    }
    out.push(part);
  }
  return out;
}

/** 按目录惯例连接显示词：GPT/GLM 与版本用连字符，Qwen/Hy 的版本紧贴品牌，其余空格。 */
function joinTokens(raws: readonly string[]): string {
  let out = '';
  let previous = '';
  for (const raw of raws) {
    const token = mapToken(raw);
    if (out === '') { out = token; previous = token; continue; }
    if ((previous === 'GPT' || previous === 'GLM') && /^\d/u.test(raw)) out += `-${token}`;
    else if ((previous === 'Qwen' || previous === 'Hy') && /^\d+(?:\.\d+)*$/u.test(raw)) out += token;
    else out += ` ${token}`;
    previous = token;
  }
  return out;
}

/** 仅由 id 生成显示名；结果越界或为空时回退原始 id。 */
export function modelNameFromId(id: string): string {
  const raws = collapse(id);
  if (raws.length === 0) return id;
  const name = joinTokens(raws).trim();
  if (name === '' || name.length > MAX_MODEL_NAME_LENGTH) return id;
  return name;
}

/**
 * 归一化一个发现行的显示名。
 *
 * @param id 网关报告的精确模型 id（已通过 MODEL_ID 校验）。
 * @param offered 网关可选提供的名字；与 id 不同且未越界时直接采用（trim+折叠空白）。
 * @returns 有界、非空的显示名；绝不抛异常。
 */
export function normalizeModelName(id: string, offered?: string): string {
  const trimmed = typeof offered === 'string' ? offered.trim().replace(/\s+/gu, ' ') : '';
  if (trimmed !== '' && trimmed.length <= MAX_MODEL_NAME_LENGTH && trimmed.toLowerCase() !== id.toLowerCase()) {
    return trimmed;
  }
  return modelNameFromId(id);
}
