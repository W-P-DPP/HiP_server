// src/aiDetect/aiDetectMerge.helper.ts
//
// 场景合并口径的纯函数：把「哪些场景并成一个」翻译成一份新的场景划分。
//
// 与 controller/service 分开，是为了让合并规则脱离 Mongo 单测（见 __tests__/unit/aiDetectMerge.test.ts）：
// 这条规则一旦放宽或收紧（例如允许非相邻序号），影响的是一整份场景列表的时间区间，
// 而本接口是同步的、结果不落库 —— 事后无法从库里反查当时到底按什么口径算出来的。
import type { SceneDetect } from '../../type/index.d.ts';

/** 分组解析结果：升序且每组有序的分组，或用户可读的拒绝原因 */
type ParsedGroups = { groups: number[][] } | { error: string };

/**
 * 把请求体里的 groups 解析成合法分组。
 *
 * 一条链路判完四件事：形状（二维数组）→ 每组元素（整数序号）→ 每组规模（≥2）→
 * 序号本身（去重、范围、跨组重复、组内连续）。任何一条不成立都返回 error 文案，
 * 由 service 统一翻成 400 —— 非法入参不是系统错误。
 *
 * 组内顺序不敏感（[4,3] 视同 [3,4]，先排序再判连续），但**连续性必须成立**：
 * 跳过中间场景合并出的区间（如 [1,3]）会把场景 2 的时间段一并吞掉，
 * 而 scene 是时间区间而不是「若干片段的集合」，这种划分没有正确的时间语义。
 */
function parseGroups(groups: unknown, sceneCount: number): ParsedGroups {
  // 三类错误分开报：没传、传了但根本不是数组、传了空数组（后两者对客户端是不同的 bug）
  if (groups === undefined || groups === null) {
    return { error: 'groups 为必填字段（形如 [[1,2],[3,4,5]]）' };
  }
  if (!Array.isArray(groups)) {
    return { error: 'groups 必须是二维数组（形如 [[1,2],[3,4,5]]）' };
  }
  if (groups.length === 0) {
    return { error: 'groups 为必填字段（形如 [[1,2],[3,4,5]]）' };
  }

  const used = new Set<number>();
  const parsed: number[][] = [];

  for (let i = 0; i < groups.length; i += 1) {
    const raw = groups[i];
    if (!Array.isArray(raw)) {
      return { error: 'groups 必须是二维数组（形如 [[1,2],[3,4,5]]）' };
    }

    const indexes: number[] = [];
    for (const value of raw) {
      const sceneIndex = toSceneIndex(value);
      if (sceneIndex === undefined) {
        return { error: `第 ${i + 1} 组必须都是整数场景序号` };
      }
      indexes.push(sceneIndex);
    }

    if (indexes.length < 2) {
      return { error: `第 ${i + 1} 组至少包含 2 个场景` };
    }

    const unique = [...new Set(indexes)].sort((a, b) => a - b);
    if (unique.length !== indexes.length) {
      const duplicate = indexes.find((value, position) => indexes.indexOf(value) !== position);
      return { error: `场景序号重复：${duplicate}` };
    }

    // 越界与跨组重复分开判：前者多半是客户端拿错了任务（用了别的任务的序号），
    // 后者是分组本身写重叠了，两者的提示对排查毫无交集。
    for (const value of unique) {
      if (value < 1 || value > sceneCount) {
        return { error: `场景序号超出范围：${value}（有效范围 1..${sceneCount}）` };
      }
      if (used.has(value)) {
        return { error: `场景序号重复：${value}` };
      }
      used.add(value);
    }

    // 连续校验放在排序之后：组内顺序无关，但不能跳号
    let previous: number | undefined;
    for (const value of unique) {
      if (previous !== undefined && value !== previous + 1) {
        return { error: `第 ${i + 1} 组的场景序号必须连续（如 [3,4,5]）` };
      }
      previous = value;
    }

    parsed.push(unique);
  }

  return { groups: parsed };
}

/** 读场景序号：整值数字与整值数字字符串都收（与 controller 的宽容口径一致），其余视为非法 */
function toSceneIndex(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

/**
 * 按分组把场景合并成更少的新场景（序号从 1 连续重排）。
 *
 * 合并后的区间 = [组内首个场景.startMs, 组内末个场景.endMs)，durationMs 一律按区间**重算**：
 * 库里那份 durationMs 是 (endMs - startMs) 的冗余记录，此前各下游（抽帧/转写）也都以区间为准，
 * 这里同样不让冗余字段有机会把某段场景推出自己的边界。
 *
 * 未出现在任何分组里的场景原样保留（只重算 durationMs），因此输出始终覆盖整段视频、无缝无重叠。
 *
 * 分组按 index 查表而非按下标偏移：场景列表的顺序与序号是否一一对应不该由本函数承担，
 * 只要 index 唯一即可（上游 PySceneDetect 保证 index 从 1 连续编号）。
 */
export function mergeSceneGroups(
  scenes: readonly SceneDetect.Scene[],
  groups: unknown,
): { scenes: SceneDetect.Scene[] } | { error: string } {
  const parsed = parseGroups(groups, scenes.length);
  if ('error' in parsed) return parsed;

  const byIndex = new Map<number, SceneDetect.Scene>(scenes.map((scene) => [scene.index, scene]));

  /** 组内首个序号 → 整组序号；同时把这些组的非首个序号标为「已被并走」 */
  const headOf = new Map<number, number[]>();
  const absorbed = new Set<number>();
  for (const group of parsed.groups) {
    headOf.set(group[0] as number, group);
    for (const value of group.slice(1)) {
      absorbed.add(value);
    }
  }

  const merged: SceneDetect.Scene[] = [];
  for (const scene of [...scenes].sort((a, b) => a.startMs - b.startMs)) {
    if (absorbed.has(scene.index)) continue;

    const group = headOf.get(scene.index);
    const tailIndex = group?.[group.length - 1];
    const tail = tailIndex === undefined ? scene : (byIndex.get(tailIndex) ?? scene);

    merged.push({
      index: merged.length + 1,
      startMs: scene.startMs,
      endMs: tail.endMs,
      durationMs: tail.endMs - scene.startMs,
    });
  }

  return { scenes: merged };
}
