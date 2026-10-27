/** 视频生成管道 V2（本地 IndexTTS 配音 + Whisper 字幕 → ffmpeg 烧录）业务常量 */

/**
 * 任务阶段中文标签。
 *
 * stage 在库里只存 ASCII key，中文映射集中在 Node 侧 —— 与 subtitleStageLabel /
 * digitalHumanStageLabel / indexttsStageLabel 同一策略，便于前端直接展示。
 */
const VIDEO_PIPELINE_V2_STAGE_LABELS: Record<string, string> = {
  pending: '排队中',
  resolve: '解析音色',
  voice_synth: '语音合成中',
  subtitle_asr: '语音识别中',
  compose: '视频合成中',
  background: '构建背景',
  render: '合成视频',
  persist: '保存产物',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** ASCII stage key → 中文描述；未知 key 原样返回，便于排障时发现漏配 */
export function videoPipelineV2StageLabel(stage: string): string {
  return VIDEO_PIPELINE_V2_STAGE_LABELS[stage] ?? stage;
}
