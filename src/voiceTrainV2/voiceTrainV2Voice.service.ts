import fs from 'node:fs';
import path from 'node:path';
import { isValidObjectId } from 'mongoose';
import { Logger } from '../../utils/Logger.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { runFfmpeg } from '../../utils/videoHelper/ffmpeg.ts';
import { probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import { isDuplicateKeyError, voiceTrainV2VoiceRepository } from './voiceTrainV2Voice.repository.ts';
import {
  buildMulterFile,
  nextUploadPath,
  removeFileQuietly,
  sanitizeFileName,
} from './voiceTrainV2Upload.helper.ts';
import {
  MIN_REFERENCE_FILE_BYTES,
  MIN_TRAIN_AUDIO_DURATION_SEC,
  VOICE_REFERENCE_SAMPLE_RATE,
  VOICE_TRAIN_V2_REFERENCE_CATEGORY,
} from '../../utils/constant/voiceTrainV2.ts';
import type { VoiceTrainV2VoiceDocument } from './voiceTrainV2Voice.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { VoiceTrainV2 } from '../../type/index.d.ts';

const logger = Logger.getInstance();

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/**
 * 音色库服务（零样本克隆）。
 *
 * 核心认知：**创建音色不做任何训练**。只是把上传的原始音频归一化成 mono 22.05kHz 的
 * reference.wav 存起来；真正的「克隆」发生在合成时 —— 该 wav 作为 spk_audio_prompt
 * 传给 IndexTTS2。因此这条链路只需要 ffmpeg，完全不需要 GPU。
 */
class VoiceTrainV2VoiceService {
  /**
   * 上传训练音频并创建音色（一次请求完成，上传素材与音色同属一条记录）。
   *
   * 流程：名称校验 → 同用户重名预检 → 探原始素材时长（>= 10s）→ ffmpeg 归一化为 mono 22.05kHz
   * → 产出体积校验 → 落 reference 的 file 记录 → 写音色记录。
   *
   * 原始素材只是中间产物：归一化后不再被任何链路使用，故既不落 file 表也不留盘，磁盘临时文件
   * 无论成功失败都在 finally 里清掉。因此各失败分支只负责回滚自己产生的副作用（destAbs /
   * reference file 记录）并 `return { error }`，临时文件清理统一由 finally 兜底。
   */
  async createVoice(
    file: Express.Multer.File,
    options: { resourceName: string; promptText?: string; userId?: string },
  ): Promise<ServiceResult<VoiceTrainV2.VoiceRecord>> {
    const resourceName = (options.resourceName ?? '').trim();
    const userId = options.userId ?? '';

    try {
      if (!resourceName) {
        return { error: '音色名称不能为空', code: HttpStatus.BAD_REQUEST };
      }

      // 名称在同一用户内唯一。预检只保证大概率拦住，并发下仍可能撞唯一索引，故 create 一并兜底。
      if (await voiceTrainV2VoiceRepository.existsByUserAndName(userId, resourceName)) {
        return { error: `音色名称「${resourceName}」已存在，请换一个名称`, code: HttpStatus.CONFLICT };
      }

      // 先探原始素材时长：不达标就没必要做 ffmpeg 归一化
      let sourceDuration: number;
      try {
        sourceDuration = await probeDurationSec(file.path);
      } catch (err) {
        return {
          error: `音频文件解析失败：${err instanceof Error ? err.message : '无法读取音频时长'}`,
          code: HttpStatus.BAD_REQUEST,
        };
      }
      if (sourceDuration < MIN_TRAIN_AUDIO_DURATION_SEC) {
        return {
          error: `音频时长不能低于 ${MIN_TRAIN_AUDIO_DURATION_SEC} 秒（当前 ${sourceDuration.toFixed(1)} 秒）`,
          code: HttpStatus.BAD_REQUEST,
        };
      }

      // 归一化产物写到 uploads 的日期子目录，命名沿用 multer 的 UUID 约定
      const destAbs = nextUploadPath(fileConfig.uploadDir, '.wav');
      const cleanupDisk = (): void => {
        removeFileQuietly(destAbs, msg => logger.warn(`参考音临时文件清理失败（${destAbs}）：${msg}`));
      };

      let referenceDuration: number;
      try {
        await runFfmpeg([
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          file.path,
          '-vn',
          '-ac',
          '1',
          '-ar',
          String(VOICE_REFERENCE_SAMPLE_RATE),
          destAbs,
        ]);

        const size = fs.existsSync(destAbs) ? fs.statSync(destAbs).size : 0;
        if (size < MIN_REFERENCE_FILE_BYTES) {
          cleanupDisk();
          return { error: '参考音频转换后无效，请换一段清晰的人声（wav/mp3/m4a）', code: HttpStatus.BAD_REQUEST };
        }
        referenceDuration = await probeDurationSec(destAbs);
      } catch (err) {
        cleanupDisk();
        return {
          error: `参考音频归一化失败：${err instanceof Error ? err.message : 'ffmpeg 执行失败'}`,
          code: HttpStatus.BAD_REQUEST,
        };
      }

      // 落 file 记录：fileService 从 multer 文件的 path 推导 storedName/相对路径，故必须是 uploadDir 内的真实文件
      let referenceFileId: string;
      let referencePath: string;
      try {
        const { created } = await fileService.upload(
          // 下载时 res.download 会把 originalname 当作默认文件名，带上音色名便于用户辨认
          buildMulterFile(destAbs, `${sanitizeFileName(resourceName)}.wav`, 'audio/wav'),
          {
            category: VOICE_TRAIN_V2_REFERENCE_CATEGORY,
            ...(userId ? { createBy: userId } : {}),
            metadata: { duration: referenceDuration, sampleRate: VOICE_REFERENCE_SAMPLE_RATE },
          },
        );
        referenceFileId = String(created._id);
        referencePath = created.path;
      } catch (err) {
        cleanupDisk();
        return { error: err instanceof Error ? err.message : '参考音保存失败', code: HttpStatus.ERROR };
      }

      try {
        const voice = await voiceTrainV2VoiceRepository.create({
          resourceName,
          sourceOriginalName: file.originalname,
          sourceSize: file.size,
          sourceMimeType: file.mimetype,
          sourceDuration,
          referenceFileId,
          referencePath,
          referenceDuration,
          ...(options.promptText ? { promptText: options.promptText.trim() } : {}),
          ...(userId ? { userId } : {}),
        });
        return { data: this.toRecord(voice) };
      } catch (err) {
        // 音色记录落库失败：file 记录假删除 + 清掉刚写的磁盘文件，对调用方按整体失败返回
        logger.error(`音色记录落库失败（referenceFileId=${referenceFileId}）：${err instanceof Error ? err.message : err}`);
        try {
          await fileService.delete(referenceFileId);
        } catch (cleanupErr) {
          logger.warn(`file 记录回滚失败（referenceFileId=${referenceFileId}）：${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`);
        }
        cleanupDisk();
        if (isDuplicateKeyError(err)) {
          return { error: `音色名称「${resourceName}」已存在，请换一个名称`, code: HttpStatus.CONFLICT };
        }
        return { error: err instanceof Error ? err.message : '音色保存失败', code: HttpStatus.ERROR };
      }
    } finally {
      // 原始素材仅作中间产物，成功失败都不留盘
      removeFileQuietly(file.path, msg => logger.warn(`训练音频临时文件清理失败（${file.path}）：${msg}`));
    }
  }

  /** 分页查询音色：userId 精确 + resourceName 模糊（均可选，不传即不限制该维度） */
  async listVoices(query: VoiceTrainV2.VoiceQuery): Promise<ServiceResult<PaginatedResponse<VoiceTrainV2.VoiceRecord>>> {
    const page = await voiceTrainV2VoiceRepository.findPage({
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.resourceName ? { resourceName: query.resourceName } : {}),
      page: query.page,
      limit: query.limit,
    });
    return {
      data: {
        list: page.list.map(doc => this.toRecord(doc)),
        total: page.total,
        page: page.page,
        limit: page.limit,
      },
    };
  }

  /** 按 id 查询音色 */
  async getVoice(id: string): Promise<ServiceResult<VoiceTrainV2.VoiceRecord>> {
    if (!isValidObjectId(id)) {
      return { error: '音色不存在', code: HttpStatus.NOT_FOUND };
    }
    const voice = await voiceTrainV2VoiceRepository.findById(id);
    if (!voice) {
      return { error: '音色不存在', code: HttpStatus.NOT_FOUND };
    }
    return { data: this.toRecord(voice) };
  }

  /**
   * 按名称解析音色（仅当前用户自己的记录，精确匹配）。
   * 未命中时在错误里列出该用户可用音色名称，供 MCP 调用方改参重试。
   */
  async resolveByName(name: string, userId: string): Promise<ServiceResult<VoiceTrainV2.VoiceRecord>> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      return { error: '音色名称不能为空', code: HttpStatus.BAD_REQUEST };
    }
    if (!userId) {
      return { error: '无法解析当前用户', code: HttpStatus.UNAUTHORIZED };
    }

    const record = await voiceTrainV2VoiceRepository.findByUserAndName(userId, trimmed);
    if (record) {
      return { data: this.toRecord(record) };
    }

    const list = await this.listVoices({ userId, limit: 50 });
    const names = 'data' in list ? list.data.list.map(voice => voice.resourceName) : [];
    const hint = names.length ? `当前用户可用音色：${names.join('、')}` : '当前用户暂无可用音色';
    return { error: `未找到名称为「${trimmed}」的音色。${hint}`, code: HttpStatus.NOT_FOUND };
  }

  /** 修改音色名称：仅允许操作归属当前用户且未删除的记录 */
  async renameVoice(id: string, userId: string, resourceName: string): Promise<ServiceResult<VoiceTrainV2.VoiceRecord>> {
    const trimmed = (resourceName ?? '').trim();
    if (!trimmed) {
      return { error: '音色名称不能为空', code: HttpStatus.BAD_REQUEST };
    }

    const owned = await this.assertVoiceOwner(id, userId);
    if ('error' in owned) return owned;

    // 名称未变直接返回，省一次写库（也避免与自身撞唯一索引）
    if (owned.record.resourceName === trimmed) {
      return { data: this.toRecord(owned.record) };
    }

    if (await voiceTrainV2VoiceRepository.existsByUserAndName(userId, trimmed)) {
      return { error: `音色名称「${trimmed}」已存在，请换一个名称`, code: HttpStatus.CONFLICT };
    }

    try {
      const updated = await voiceTrainV2VoiceRepository.updateNameByOwner(id, userId, trimmed);
      if (!updated) {
        return { error: '音色不存在', code: HttpStatus.NOT_FOUND };
      }
      return { data: this.toRecord(updated) };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return { error: `音色名称「${trimmed}」已存在，请换一个名称`, code: HttpStatus.CONFLICT };
      }
      logger.error(`音色改名失败（id=${id}）：${err instanceof Error ? err.message : err}`);
      return { error: err instanceof Error ? err.message : '音色改名失败', code: HttpStatus.ERROR };
    }
  }

  /** 删除音色（假删除；file 记录与磁盘文件保留，便于排查历史问题） */
  async removeVoice(id: string, userId: string): Promise<ServiceResult<true>> {
    const owned = await this.assertVoiceOwner(id, userId);
    if ('error' in owned) return owned;

    const ok = await voiceTrainV2VoiceRepository.softDeleteByOwner(id, userId);
    if (!ok) {
      return { error: '音色不存在', code: HttpStatus.NOT_FOUND };
    }
    return { data: true };
  }

  /**
   * 解析音色参考音的绝对路径，供合成使用。
   * 参考音是零样本克隆的唯一输入，缺失就无法合成，因此这里用 409 明确区分于 404。
   */
  async resolveReference(
    voiceId: string,
    userId: string,
  ): Promise<ServiceResult<{ voice: VoiceTrainV2VoiceDocument; absPath: string }>> {
    const owned = await this.assertVoiceOwner(voiceId, userId);
    if ('error' in owned) return owned;

    const file = await fileService.getById(owned.record.referenceFileId);
    if (!file) {
      return { error: '音色参考音已失效，请重新创建音色', code: HttpStatus.CONFLICT };
    }
    // FILE_UPLOAD_DIR 是相对路径，交给 Python 前必须 resolve 成绝对路径
    const absPath = path.resolve(fileService.getAbsolutePath(file));
    if (!fs.existsSync(absPath)) {
      return { error: '音色参考音文件已丢失，请重新创建音色', code: HttpStatus.CONFLICT };
    }
    return { data: { voice: owned.record, absPath } };
  }

  /**
   * 合成成功后把试听结果回写到音色记录（仅 indexttsDispatcher 调用）。
   *
   * 单独开一个入口而不是让 dispatcher 直连仓库，是为维持 dispatcher → service 的分层
   * （dispatcher 已在用 resolveReference）。返回 false 表示未写入：音色已删除，
   * 或已存在更新的试听（见 repository.updatePreview 的 previewAt 条件）。
   */
  async attachPreview(
    voiceId: string,
    data: {
      previewFileId: string;
      previewUrl: string;
      previewText: string;
      previewDuration: number;
      previewAt: Date;
    },
  ): Promise<boolean> {
    if (!isValidObjectId(voiceId)) return false;
    return voiceTrainV2VoiceRepository.updatePreview(voiceId, data);
  }

  /**
   * 归属校验：记录不存在 → 404；存在但不属于当前用户 → 403。
   * 分两步查是为了区分两种失败原因，纯 owner 条件过滤会把「非本人」也报成 404。
   */
  private async assertVoiceOwner(
    id: string,
    userId: string,
  ): Promise<{ record: VoiceTrainV2VoiceDocument } | { error: string; code: number }> {
    if (!isValidObjectId(id)) {
      return { error: '音色不存在', code: HttpStatus.NOT_FOUND };
    }
    const record = await voiceTrainV2VoiceRepository.findById(id);
    if (!record) {
      return { error: '音色不存在', code: HttpStatus.NOT_FOUND };
    }
    if (record.userId !== userId) {
      return { error: '只能操作当前用户自己的音色', code: HttpStatus.FORBIDDEN };
    }
    return { record };
  }

  /** 落库文档 → 对外记录（_id 统一映射为 id，并补上免 JWT 的试听地址） */
  private toRecord(doc: VoiceTrainV2VoiceDocument): VoiceTrainV2.VoiceRecord {
    const referenceFileId = doc.referenceFileId;
    return {
      id: String(doc._id),
      resourceName: doc.resourceName,
      sourceOriginalName: doc.sourceOriginalName,
      sourceSize: doc.sourceSize,
      sourceMimeType: doc.sourceMimeType,
      sourceDuration: doc.sourceDuration,
      referenceFileId,
      referenceUrl: `/api/files/${referenceFileId}/download`,
      referenceDuration: doc.referenceDuration,
      promptText: doc.promptText,
      backend: doc.backend,
      sampleRate: doc.sampleRate,
      // 列表走 .lean() 查询，mongoose 不会补 schema 默认值，故对本次新增字段做兜底：
      // 改动前创建的老记录没有这些字段，不能把 undefined 直接透给前端。
      previewFileId: doc.previewFileId ?? '',
      previewUrl: doc.previewUrl ?? '',
      previewText: doc.previewText ?? '',
      previewDuration: doc.previewDuration ?? 0,
      ...(doc.previewAt ? { previewAt: doc.previewAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const voiceTrainV2VoiceService = new VoiceTrainV2VoiceService();
