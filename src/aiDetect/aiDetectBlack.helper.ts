// src/aiDetect/aiDetectBlack.helper.ts
//
// 首尾黑场的业务口径（纯函数）：把「贴着头/尾的黑场」在场景序列里另立为独立场景，并给出标记。
//
// 与 ffmpeg 调用（utils/videoHelper/blackDetect.ts）分开，是为了让「算不算片头片尾黑场」「要不要切开
// 场景」这两条规则脱离 ffmpeg 单测（见 __tests__/unit/aiDetectBlack.test.ts）：它们决定的是整份场景
// 划分的边界，切错一位就等于给下游（抽帧/转写）多算或少算一段视频，而结果不落库、事后无法反查原因。
import { BLACK_BOUNDARY_TOLERANCE_MS } from '../../utils/constant/video.ts';
import type { AiDetect, SceneDetect } from '../../type/index.d.ts';

/** 从检出的黑场区间里挑出的、真正贴边的首尾黑场边界（没有则对应字段为 undefined） */
export interface HeadTailBlack {
  /** 片头黑场的结束时刻（ms）：首场景应从它开始；undefined = 没有片头黑场 */
  headEndMs?: number;
  /** 片尾黑场的起始时刻（ms）：末场景应到它结束；undefined = 没有片尾黑场 */
  tailStartMs?: number;
}

/**
 * 只挑**紧贴首/尾**的黑场。
 *
 * 为什么必须贴边才算：检测窗口是首尾各 N 秒，窗口里完全可能夹着一段中景黑场（转场黑屏、
 * 黑底字幕卡）。它不是「片头/片尾黑屏」，把它当片头会在视频中间凭空插一个「黑场场景」。
 * 判定用 BLACK_BOUNDARY_TOLERANCE_MS 容差 —— blackdetect 报的是首/末黑帧的 pts，
 * 与 0 / 总时长之间天然差一帧左右（25fps 下 0.04s），要求严格相等会漏判掉真正的片尾黑场。
 *
 * 全片黑场（同一段黑场既贴头又贴尾）只按片头记一次：否则同一段区间会被切成两个场景。
 */
export function selectHeadTailBlack(
  blackRanges: readonly SceneDetect.BlackRange[],
  durationMs: number,
): HeadTailBlack {
  if (blackRanges.length === 0) return {};

  const sorted = [...blackRanges].sort((a, b) => a.startMs - b.startMs);

  // 片头：最早的那段只要起点贴 0 就是它（解析器已合并相接区间，故不会有第二段也贴 0）
  const first = sorted[0];
  const headEndMs = first && first.startMs <= BLACK_BOUNDARY_TOLERANCE_MS ? first.endMs : undefined;

  // 片尾：最晚的那段只要终点贴视频末尾就是它；时长未知（<=0）时无从判断，直接不做片尾
  const last = durationMs > 0 ? sorted[sorted.length - 1] : undefined;
  let tailStartMs =
    last && last.endMs >= durationMs - BLACK_BOUNDARY_TOLERANCE_MS ? last.startMs : undefined;

  // 全片黑场 / 两段黑场相接：同一段区间不能既当片头又当片尾
  if (headEndMs !== undefined && tailStartMs !== undefined && headEndMs >= tailStartMs) {
    tailStartMs = undefined;
  }

  return {
    ...(headEndMs !== undefined ? { headEndMs } : {}),
    ...(tailStartMs !== undefined ? { tailStartMs } : {}),
  };
}

/**
 * 把首尾黑场在场景序列里另立为独立场景（并标记），返回新的场景列表与标记。
 *
 * 两条规则：
 * - **跨边界的场景被切开**：黑场那部分独立成一段，剩下的留给原来的内容。
 * - **完全落在黑场内的场景只标记、不切开**：PySceneDetect 自己常常已经在黑场边界上切过一刀
 *   （淡入淡出本身就是内容突变），这种情况不需要再打散它的切点。
 *
 * 结果仍是「按时间升序、区间无重叠、无缝覆盖 [0, durationMs)」，只是编号重排 1..N ——
 * 编号必然变，因为插入新场景会让后面所有场景的序号后移。
 * 没有贴边黑场时原样返回（只做浅拷贝），场景编号都不变。
 */
export function applyHeadTailBlackScenes(
  scenes: readonly SceneDetect.Scene[],
  blackRanges: readonly SceneDetect.BlackRange[],
  durationMs: number,
): { scenes: SceneDetect.Scene[]; marks: AiDetect.BlackSceneMark[] } {
  const { headEndMs, tailStartMs } = selectHeadTailBlack(blackRanges, durationMs);

  if (headEndMs === undefined && tailStartMs === undefined) {
    return { scenes: scenes.map((scene) => ({ ...scene })), marks: [] };
  }

  const head = headEndMs === undefined ? undefined : Math.max(0, headEndMs);
  const tail = tailStartMs === undefined ? undefined : Math.max(0, tailStartMs);

  const merged: SceneDetect.Scene[] = [];
  const marks: AiDetect.BlackSceneMark[] = [];

  for (const scene of [...scenes].sort((a, b) => a.startMs - b.startMs)) {
    // 场景内部需要落刀的位置：黑场边界若落在场景中间，就得把它切成两段
    const cuts = [head, tail]
      .filter((point): point is number => point !== undefined && point > scene.startMs && point < scene.endMs)
      .sort((a, b) => a - b);

    const bounds = [scene.startMs, ...cuts, scene.endMs];
    for (let i = 1; i < bounds.length; i += 1) {
      const startMs = bounds[i - 1] as number;
      const endMs = bounds[i] as number;
      if (endMs <= startMs) continue;

      const mark: AiDetect.BlackSceneMark | undefined =
        head !== undefined && startMs < head
          ? { position: 'head', sceneIndex: 0, startMs, endMs, durationMs: endMs - startMs }
          : tail !== undefined && endMs > tail
            ? { position: 'tail', sceneIndex: 0, startMs, endMs, durationMs: endMs - startMs }
            : undefined;

      merged.push({ index: merged.length + 1, startMs, endMs, durationMs: endMs - startMs });
      if (mark) {
        // sceneIndex 要等编号定下来才能填，故先用占位值入列、最后统一回填
        marks.push({ ...mark, sceneIndex: merged.length });
      }
    }
  }

  return { scenes: merged, marks };
}
