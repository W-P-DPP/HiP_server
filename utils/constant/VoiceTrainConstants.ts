// utils/constant/VoiceTrainConstants.ts
/** 音色训练（voiceTrain，V1）常量 */

export class VoiceTrainConstants {
  /**
   * 单用户未删除训练记录数上限。
   * /task/submit 提交前校验。
   */
  public static readonly MAX_PER_USER: number = 10;
}
