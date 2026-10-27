// utils/vlm/validateResult.ts
import {
  VLM_MAX_ACTIONS,
  VLM_MAX_DESCRIPTION_CHARS,
  VLM_MAX_ITEM_CHARS,
  VLM_MAX_OBJECTS,
  VLM_MAX_TAGS,
  normalizeSceneType,
} from '../constant/vlm.ts';
import type { Vlm } from '../../type/index.d.ts';

/**
 * 把容器返回的 `json` 字段收敛成 `Vlm.Result`。
 *
 * 这是「结构化 JSON」三层保障的最后一层（前两层在容器侧：括号配平抽取 + 一次严格重试）。
 * 容器已保证拿到的是一个可解析的 JSON **对象**，但它不保证字段齐备、类型正确、内容克制 ——
 * 模型把 objects 写成字符串、给 30 个 tag、把 sceneType 写成「室内」都是可预期的。
 * 这里做纯函数的收敛，好写单测，也避免这些判断散落到 service/dispatcher 里。
 *
 * 返回 `{ data }` 或 `{ error }`：**不抛异常**，由调用方决定是判任务失败还是降级。
 * 注意 description 为空是**硬失败**（不是回落空串）：描述是这张结果的骨架，空的 description
 * 说明模型在字段契约与自定义要求之间打架了，静默存下来只会让下游拿到一个看似成功、实则无用的结果。
 */
export function normalizeVlmResult(raw: unknown): { data: Vlm.Result } | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '模型返回的 json 字段不是对象' };
  }

  const source = raw as Record<string, unknown>;

  const rawDescription = source.description;
  if (typeof rawDescription !== 'string') {
    return { error: '模型返回的结果缺少 description 字段' };
  }
  const description = rawDescription.trim();
  if (!description) {
    // 与「缺字段」分开报：这两种情况的成因完全不同 —— 缺字段是模型自造了字段名（prompt 没给契约），
    // 空字段是模型收到了契约但内容没写（典型是自定义 prompt 与字段要求互相打架）。
    // 合成一句「缺少」会让排查方向跑偏，实测就吃过这个亏。
    return { error: '模型返回的 description 字段为空' };
  }

  return {
    data: {
      description: truncate(description, VLM_MAX_DESCRIPTION_CHARS),
      objects: normalizeStringArray(source.objects, VLM_MAX_OBJECTS),
      actions: normalizeStringArray(source.actions, VLM_MAX_ACTIONS),
      sceneType: normalizeSceneType(source.sceneType),
      tags: normalizeStringArray(source.tags, VLM_MAX_TAGS),
    },
  };
}

/**
 * 字符串数组收敛：非数组 → 空数组；元素非字符串 → 丢弃；去空白；去重；逐项截断；总数截断。
 *
 * 刻意容忍这些偏差而不报错：它们是模型的「格式噪音」，不影响这张结果能不能用，
 * 为它们判整个任务失败属于过度反应（真正致命的只有 description 缺失）。
 */
function normalizeStringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = truncate(item.trim(), VLM_MAX_ITEM_CHARS);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/** 按字符数截断（不追加省略号：下游展示层自己决定怎么标注被截断） */
function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
