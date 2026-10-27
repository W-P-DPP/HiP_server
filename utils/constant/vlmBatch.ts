// utils/constant/vlmBatch.ts
/** 批量图像识别（基于场景抽帧关键帧）业务常量 */
import type { VlmBatch } from '../../type/index.d.ts';

/** 提交口径：目前唯一支持的是「已完成的场景抽帧任务」（aiDetectFrameTasks） */
export const VLM_BATCH_SOURCE_TYPE: VlmBatch.SourceType = 'framesTask';

/**
 * 整批进度的分带：逐项完成度映射到 [START, START + SPAN]，剩余留给落库。
 *
 * 与单图任务（`vlmDispatcher.ts` 的 0.05/0.15–0.90/0.95）同一取舍：批次是逐张的重复调用，
 * 每完成一张推进一次；末尾 0.05 预留给结算写入，避免进度在最后一步「卡在 0.99」。
 */
export const VLM_BATCH_PROGRESS_START = 0.05;
export const VLM_BATCH_PROGRESS_SPAN = 0.9;

/**
 * 批次阶段中文标签。
 *
 * stage 在库里只存 ASCII key，中文映射集中在 Node 侧 —— 与 `vlmStageLabel` 同一策略，
 * 便于前端直接展示。key 与 `src/vlmBatch/vlmBatchDispatcher.ts` 上报的取值必须一致。
 */
const VLM_BATCH_STAGE_LABELS: Record<string, string> = {
  pending: '排队中',
  resolve_source: '解析关键帧',
  recognize: '识别画面中',
  persist: '保存结果',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** ASCII stage key → 中文描述；未知 key 原样返回，便于排障时发现漏配 */
export function vlmBatchStageLabel(stage: string): string {
  return VLM_BATCH_STAGE_LABELS[stage] ?? stage;
}
