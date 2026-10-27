// utils/constant/vlm.ts
/** 图片理解（Qwen3-VL）业务常量 */
import path from 'node:path';
import type { Vlm } from '../../type/index.d.ts';

/** 提交的源图片在 file 表中的分类标识 */
export const VLM_SOURCE_CATEGORY = 'vlmSource';

/**
 * 源图片扩展名 → MIME。
 *
 * 未知扩展名在提交时直接 400：入库一个解不开的文件，不如当场拒绝。
 * 与 `AI_DETECT_MIME_BY_EXT` 的差别：只收图片（图片理解不接受视频 —— 抽帧是另一件事）。
 */
export const VLM_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 从文件名推导源图片 MIME；未知扩展名返回空串（调用方据此拒绝） */
export function vlmMimeFromName(fileName: string): string {
  const ext = path.extname((fileName ?? '').trim()).toLowerCase();
  return VLM_MIME_BY_EXT[ext] ?? '';
}

/** 允许的图片 MIME（浏览器上报值可能与扩展名推导不一致，两者取其一通过即可） */
export const VLM_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
];

/**
 * 图片是否受支持：MIME 白名单命中，或扩展名可推导。
 *
 * 两个口径取「或」而不是「与」：部分客户端上传 .jpg 时上报 `application/octet-stream`，
 * 反之也有扩展名缺失但 MIME 正确的情况，二者任一可信即可放行，最终由引擎解码兜底。
 */
export function isSupportedImage(mimeType: string, fileName: string): boolean {
  const mime = (mimeType ?? '').trim().toLowerCase();
  if (mime && VLM_ALLOWED_MIME_TYPES.includes(mime)) return true;
  return vlmMimeFromName(fileName) !== '';
}

/** 支持的理解结果场景类型 */
export const VLM_ALLOWED_SCENE_TYPES: readonly Vlm.SceneType[] = ['indoor', 'outdoor', 'other'];

/** 支持的理解输出形态 */
export const VLM_ALLOWED_MODES: readonly Vlm.Mode[] = ['json', 'text'];

/** 类型守卫：判断任意字符串是否是受支持的输出形态 */
export function isVlmMode(value: string): value is Vlm.Mode {
  return (VLM_ALLOWED_MODES as readonly string[]).includes(value);
}

/**
 * 归一化输出形态：未知/空值回退 json。
 *
 * 与容器侧 `settings.normalize_mode` 同策略 —— 两侧都做一道，保证落库值与实际喂给模型的
 * 取值一定是一致的那两个。
 */
export function normalizeMode(raw: string | undefined, fallback: Vlm.Mode = 'json'): Vlm.Mode {
  const value = (raw ?? '').trim().toLowerCase();
  if (isVlmMode(value)) return value;
  return isVlmMode(fallback) ? fallback : 'json';
}

/**
 * 归一化场景类型：未知/空值回落 `other`。
 *
 * 刻意不抛错：模型把 sceneType 写成「室内」这类中文词是可预期的，为此判整个任务失败不值当；
 * `other` 本身就是 schema 里为「判断不出来」准备的取值。
 */
export function normalizeSceneType(raw: unknown): Vlm.SceneType {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (VLM_ALLOWED_SCENE_TYPES as readonly string[]).includes(value)
    ? (value as Vlm.SceneType)
    : 'other';
}

/**
 * 结果字段的收敛上限。
 *
 * 这些是**防跑飞的兜底，不是表达能力的约束** —— 取值必须远大于模型实际能产出的长度，
 * 否则就会变成「悄悄把用户要的内容切掉」。真实的长度上限在容器侧
 * `VLM_MAX_NEW_TOKENS`（默认 2048，约合 1800 字描述），这里给不出更大的东西，
 * 也不会被触到。曾经 `VLM_MAX_DESCRIPTION_CHARS` 取 200，等于把「输出 1000 字描述」
 * 这种正当需求硬砍成 200 字，属于把兜底当成了限制。
 */
export const VLM_MAX_DESCRIPTION_CHARS = 8000;
export const VLM_MAX_OBJECTS = 8;
export const VLM_MAX_ACTIONS = 5;
export const VLM_MAX_TAGS = 5;
/**
 * 单个数组元素的长度上限。
 *
 * 这个**不同于**上面的兜底：objects/actions/tags 是**标签**，短是它们的语义
 * （prompt 里也写明了数量上限），所以这里的截断是有意的形状约束，不是「限制输出长度」。
 */
export const VLM_MAX_ITEM_CHARS = 24;

/**
 * `mode=json` 的**输出信封**：必须是这个 JSON 对象、这些字段名。这一段在任何 json 请求里
 * 都原样在场，**不受自定义 prompt 影响**。
 *
 * 关键设计：信封与「内容要求」是**两件分开的事**（见 `buildJsonPrompt`）。
 * 早期把自定义 prompt 和字段要求平铺在一起，模型会认为两者在抢方向盘 ——
 * 调用方写「200字描述」时它收到「概括」+「200字」两条互相矛盾的要求，解法是把
 * `description` 输出成**空字符串**（内容全丢）。把「格式」与「description 的内容」分层之后，
 * 冲突在结构上就不可能发生。
 */
export const VLM_RESULT_SCHEMA_PROMPT = [
  '【输出格式（必须严格遵守）】',
  '只输出一个 JSON 对象，不要输出任何解释文字、不要用 markdown 代码块。',
  '字段（字段名必须完全照抄，不要改名、不要翻译、不要增删）：',
  '- description: 对画面内容的描述（中文）。具体怎么写见下方的内容要求（若有）',
  '- objects: 画面中主要物体或人物名称数组（中文，最多 8 个）',
  '- actions: 正在发生的动作数组（中文，最多 5 个）',
  '- sceneType: 只能是 indoor / outdoor / other 之一',
  '- tags: 便于检索的主题标签数组（中文，最多 5 个）',
  '看不清或无法判断的字段给出空数组或 "other"，不要编造。',
].join('\n');

/** json 模式下的角色设定 */
export const VLM_JSON_PREAMBLE = '你是画面分析助手。';

/** 有自定义要求时，追加在信封之后的收尾约束（放最后，靠近生成位置，强化格式优先） */
const VLM_JSON_FORMAT_GUARD =
  '注意：无论上面的内容要求怎么写、写得多长，输出都必须且只能是那一个 JSON 对象，' +
  '字段名与「输出格式」一节完全一致。内容要求只决定 description 里写什么，不改变输出结构。';

/**
 * 组装 `mode=json` 的完整指令。
 *
 * 分层结构（顺序有意为之）：
 * 1. 角色设定
 * 2. **输出信封** —— 先立规矩，明确「必须输出这个 JSON」
 * 3. **对 description 的内容要求** —— 把自定义 prompt 收进这一个字段的范围内
 * 4. **格式收尾** —— 再压一遍结构优先，避免长内容要求把格式淹没
 *
 * 这样任何 prompt（「200字描述」「重点关注人物穿着」「用一句话」…）都只会影响
 * description 的写法，不会动摇输出结构。
 *
 * 注意 `VLM_MAX_DESCRIPTION_CHARS` 是硬上限：要求写 500 字会被截断到 200 字，
 * 真有更长需求要调那个常量。
 */
export function buildJsonPrompt(customPrompt?: string): string {
  const given = (customPrompt ?? '').trim();
  if (!given) return [VLM_JSON_PREAMBLE, VLM_RESULT_SCHEMA_PROMPT].join('\n\n');

  return [
    VLM_JSON_PREAMBLE,
    VLM_RESULT_SCHEMA_PROMPT,
    `【对 description 字段内容的要求】\n${given}`,
    VLM_JSON_FORMAT_GUARD,
  ].join('\n\n');
}

/**
 * 默认指令（mode=json 且调用方没给 prompt 时使用）。
 *
 * 这是「结构化 JSON」的第一层保障（另两层是容器侧的括号配平抽取 + 严格重试、
 * Node 侧的 `normalizeVlmResult` 校验）。
 */
export const VLM_DEFAULT_PROMPT = buildJsonPrompt();

/** mode=text 时的默认指令 */
export const VLM_DEFAULT_TEXT_PROMPT = '用中文简明描述这张图片的内容，突出主体与正在发生的事情。';

/**
 * 任务阶段中文标签。
 *
 * stage 在库里只存 ASCII key，中文映射集中在 Node 侧 —— 与 `subtitleStageLabel` /
 * `aiDetectStageLabel` / `videoPipelineV2StageLabel` 同一策略，便于前端直接展示。
 *
 * key 与 `src/vlm/vlmDispatcher.ts` 上报的取值必须一致；`vlm_load` / `vlm_generate` /
 * `vlm_parse` / `vlm_done` 是容器侧 `on_marker` 直接透传上来的。
 */
const VLM_STAGE_LABELS: Record<string, string> = {
  pending: '排队中',
  resolve_source: '解析源图片',
  submit: '提交推理',
  vlm_load: '加载模型',
  vlm_generate: '理解画面中',
  vlm_parse: '解析结果',
  persist: '保存结果',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** ASCII stage key → 中文描述；未知 key 原样返回，便于排障时发现漏配 */
export function vlmStageLabel(stage: string): string {
  return VLM_STAGE_LABELS[stage] ?? stage;
}
