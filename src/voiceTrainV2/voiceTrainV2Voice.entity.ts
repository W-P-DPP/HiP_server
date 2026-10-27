import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/**
 * 音色库记录（上传素材与音色合二为一：一次上传即一条记录）。
 *
 * 零样本方案：创建音色不做任何训练，只是把一份参考音频归一化（mono 22050Hz wav）后存起来，
 * 真正的「克隆」发生在合成时 —— 该 wav 作为 spk_audio_prompt 传给 IndexTTS2。
 * 归一化完成后原始素材即失去用处，故只留 `source*` 元数据留档，磁盘文件与 file 记录都不保留。
 */
export interface IVoiceTrainV2Voice extends IBaseMongoEntity {
  /** 音色名称（用户命名，同一用户内唯一） */
  resourceName: string;
  /** 上传素材的原始文件名（原始素材不入 file 表，仅在此留档） */
  sourceOriginalName: string;
  /** 上传素材大小（字节） */
  sourceSize: number;
  /** 上传素材 MIME 类型 */
  sourceMimeType: string;
  /** 上传素材时长（秒），入库前已保证 >= 10 */
  sourceDuration: number;
  /** 归一化 reference.wav 的 file 记录 id（取绝对路径、出试听 URL 都用它） */
  referenceFileId: string;
  /** reference.wav 相对 uploadDir 的路径（冗余存储，省一次 file 查询） */
  referencePath: string;
  /** reference.wav 时长（秒），由 ffprobe 得到 */
  referenceDuration: number;
  /** 参考音对应文本（仅作元数据；IndexTTS2 零样本不使用） */
  promptText: string;
  /** 合成后端，当前固定 indextts（预留多后端） */
  backend: string;
  /** 参考音采样率，固定 22050 */
  sampleRate: number;

  /**
   * 最近一次成功合成的试听信息（回写字段）。
   *
   * 试听由用户主动调 submitSynthesis 生成，dispatcher 合成成功后把结果回写到这里，
   * 使列表/详情无需关联合成任务表即可直接播放。从未成功合成时为空值。
   */
  /** 试听产物的 file 记录 id */
  previewFileId: string;
  /** 试听地址，形如 /api/files/<id>/download */
  previewUrl: string;
  /** 生成该试听所用文本 */
  previewText: string;
  /** 试听音频时长（秒） */
  previewDuration: number;
  /** 试听最近生成时间；null 表示尚未生成。兼作新旧判定排序键（见 repository.updatePreview） */
  previewAt: Date | null;

  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 音色库记录 Mongoose Document 类型 */
export type VoiceTrainV2VoiceDocument = BaseDocument & IVoiceTrainV2Voice;

const VoiceTrainV2VoiceSchema = new mongoose.Schema<VoiceTrainV2VoiceDocument>(
  {
    resourceName: { type: String, required: true, trim: true, index: true },
    sourceOriginalName: { type: String, default: '' },
    sourceSize: { type: Number, default: 0 },
    sourceMimeType: { type: String, default: '' },
    sourceDuration: { type: Number, default: 0 },
    referenceFileId: { type: String, required: true, index: true },
    referencePath: { type: String, required: true },
    referenceDuration: { type: Number, default: 0 },
    promptText: { type: String, default: '' },
    backend: { type: String, default: 'indextts' },
    sampleRate: { type: Number, default: 22050 },
    previewFileId: { type: String, default: '' },
    previewUrl: { type: String, default: '' },
    previewText: { type: String, default: '' },
    previewDuration: { type: Number, default: 0 },
    previewAt: { type: Date, default: null },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'voiceTrainV2Voices',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
VoiceTrainV2VoiceSchema.plugin(BaseMongoPlugin);

// 音色名称在同一用户内唯一；partialFilterExpression 只约束未删除记录，
// 使假删除（flag=0）后该名称可被重新使用（普通复合唯一索引会连已删除记录一起占用名称）。
VoiceTrainV2VoiceSchema.index(
  { userId: 1, resourceName: 1 },
  { unique: true, partialFilterExpression: { flag: 1 } },
);

// 列表查询默认按创建时间倒序
VoiceTrainV2VoiceSchema.index({ userId: 1, createdAt: -1 });

const VoiceTrainV2VoiceModel = MongoDBService.getInstance()
  .getMongoose()
  .model<VoiceTrainV2VoiceDocument>('VoiceTrainV2Voice', VoiceTrainV2VoiceSchema);

export default VoiceTrainV2VoiceModel;
