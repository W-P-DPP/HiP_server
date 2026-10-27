// src/vlmBatch/vlmBatch.helper.ts
/**
 * 批量图像识别的纯函数（可单测，不碰 Mongo/Redis/HTTP）。
 *
 * 抽出来而不是内联在 dispatcher 里：这些换算决定了「items 的顺序 / 进度 / 批次终态」，
 * 一旦写错会影响整批上百条结果，且不易在集成测试里覆盖（要跑真的容器）。纯函数好写单测。
 */
import {
  VLM_BATCH_PROGRESS_SPAN,
  VLM_BATCH_PROGRESS_START,
} from '../../utils/constant/vlmBatch.ts';
import type { VlmBatch } from '../../type/index.d.ts';
import type { IAiDetectSceneFrames } from '../aiDetect/aiDetectFrameTask.entity.ts';
import type { VlmBatchItemInput } from './vlmBatch.dto.ts';

/**
 * 把来源抽帧任务的 frameScenes 展平成批次的逐项列表。
 *
 * 顺序：按场景序号升序，场景内按帧位出现顺序（与 `resolveSceneFrameTimes` 产出一致）。
 * 保证 `index` 与「源视频时间轴」单调对应，前端可按序展示、也能据 sceneIndex/timeMs 回溯到画面。
 * 不假设入参已排序（库里的数组顺序不保证），故显式排序；场景序号相同则保持原相对顺序。
 */
export function flattenFrameItems(frameScenes: IAiDetectSceneFrames[]): VlmBatchItemInput[] {
  const scenes = [...(frameScenes ?? [])].sort((a, b) => a.index - b.index);

  const items: VlmBatchItemInput[] = [];
  for (const scene of scenes) {
    for (const frame of scene.frames ?? []) {
      items.push({
        index: items.length,
        sceneIndex: scene.index,
        frameKind: frame.kind,
        timeMs: frame.timeMs,
        fileId: frame.fileId,
        url: frame.url,
      });
    }
  }
  return items;
}

/**
 * 整批进度：已完成占比映射到 [START, START + SPAN]。
 *
 * total<=0 / 非有限值时落到起点（不抛错）：批次理论上不该有空 items（提交期已挡），
 * 但中断恢复后若来源任务的帧被清空，这里仍要给出一个合法进度而不是 NaN。
 */
export function batchProgress(done: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return VLM_BATCH_PROGRESS_START;
  const ratio = Math.min(1, Math.max(0, done / total));
  return VLM_BATCH_PROGRESS_START + ratio * VLM_BATCH_PROGRESS_SPAN;
}

/**
 * 批次终态：有任意一项成功即 success，全失败（含空批次）才 failed。
 *
 * 刻意用 `succeeded > 0` 而不是 `failed === 0` 判成功：批次里个别关键帧解码失败是常态
 * （损坏帧、极短场景抽出的边界帧），逐项状态与 failed 计数已完整暴露部分失败，
 * 为一张坏图把整批判 failed 会让其余上百条可用结果在状态上「消失」。
 */
export function resolveBatchStatus(succeeded: number): VlmBatch.TaskStatus {
  return succeeded > 0 ? 'success' : 'failed';
}
