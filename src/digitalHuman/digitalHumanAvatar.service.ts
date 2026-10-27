import fs from 'node:fs';
import path from 'node:path';
import { isValidObjectId } from 'mongoose';
import { Logger } from '../../utils/Logger.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { runFfmpeg } from '../../utils/videoHelper/ffmpeg.ts';
import { probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import {
  isDuplicateKeyError,
  digitalHumanAvatarRepository,
} from './digitalHumanAvatar.repository.ts';
import {
  buildMulterFile,
  nextUploadPath,
  removeFileQuietly,
  sanitizeFileName,
} from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import {
  DIGITAL_HUMAN_REFERENCE_CATEGORY,
  MAX_REFERENCE_VIDEO_DURATION_SEC,
  MIN_REFERENCE_VIDEO_DURATION_SEC,
} from '../../utils/constant/digitalHuman.ts';
import type { DigitalHumanAvatarDocument } from './digitalHumanAvatar.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { DigitalHuman } from '../../type/index.d.ts';

const logger = Logger.getInstance();

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/** 归一化 mp4 的最小有效体积（字节）：过小说明 ffmpeg 产出无效 */
const MIN_NORMALIZED_VIDEO_BYTES = 1024;

/**
 * 数字人形象库服务。
 *
 * 与音色库的差异：参考音归一化后原始素材即可丢弃，而参考视频**每次合成都被复用**，
 * 因此归一化产物要长期保留（file 表 + 磁盘），只在任务阶段才 stage 进 HeyGem 挂载目录。
 * 这条链路同样只需要 ffmpeg，不需要 GPU。
 */
class DigitalHumanAvatarService {
  /**
   * 上传参考视频并创建形象。
   *
   * 流程：名称校验 → 同用户重名预检 → 探原始时长（5–45s）→ ffmpeg 归一化为 mp4(h264/yuv420p)
   * → 产出体积校验 → 落 reference 的 file 记录 → 写形象记录。
   * 上传的原始素材是中间产物，无论成败都在 finally 里清掉。
   */
  async createAvatar(
    file: Express.Multer.File,
    options: { name: string; userId?: string },
  ): Promise<ServiceResult<DigitalHuman.AvatarRecord>> {
    const name = (options.name ?? '').trim();
    const userId = options.userId ?? '';

    try {
      if (!name) {
        return { error: '形象名称不能为空', code: HttpStatus.BAD_REQUEST };
      }

      if (await digitalHumanAvatarRepository.existsByUserAndName(userId, name)) {
        return { error: `形象名称「${name}」已存在，请换一个名称`, code: HttpStatus.CONFLICT };
      }

      // 先探原始素材时长：不达标就不必做 ffmpeg 归一化
      let sourceDuration: number;
      try {
        sourceDuration = await probeDurationSec(file.path);
      } catch (err) {
        return {
          error: `视频文件解析失败：${err instanceof Error ? err.message : '无法读取视频时长'}`,
          code: HttpStatus.BAD_REQUEST,
        };
      }
      if (sourceDuration < MIN_REFERENCE_VIDEO_DURATION_SEC) {
        return {
          error:
            `参考视频过短（${sourceDuration.toFixed(1)}s）。` +
            `建议上传 ${MIN_REFERENCE_VIDEO_DURATION_SEC}–${MAX_REFERENCE_VIDEO_DURATION_SEC} 秒正脸口播 mp4/mov`,
          code: HttpStatus.BAD_REQUEST,
        };
      }
      if (sourceDuration > MAX_REFERENCE_VIDEO_DURATION_SEC) {
        return {
          error:
            `参考视频过长（${sourceDuration.toFixed(0)}s）。` +
            `建议裁剪到 ${MIN_REFERENCE_VIDEO_DURATION_SEC}–${MAX_REFERENCE_VIDEO_DURATION_SEC} 秒，合成更快`,
          code: HttpStatus.BAD_REQUEST,
        };
      }

      // 归一化产物写到 uploads 的日期子目录，命名沿用 multer 的 UUID 约定
      const destAbs = nextUploadPath(fileConfig.uploadDir, '.mp4');
      const cleanupDisk = (): void => {
        removeFileQuietly(destAbs, msg => logger.warn(`参考视频临时文件清理失败（${destAbs}）：${msg}`));
      };

      let referenceDuration: number;
      try {
        // 统一转成 h264/yuv420p mp4，保证 duix 容器一定能解码；参考视频的音轨无意义故丢弃
        await runFfmpeg([
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          file.path,
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          destAbs,
        ]);

        const size = fs.existsSync(destAbs) ? fs.statSync(destAbs).size : 0;
        if (size < MIN_NORMALIZED_VIDEO_BYTES) {
          cleanupDisk();
          return { error: '参考视频转换后无效，请换一段清晰的正脸口播视频（mp4/mov）', code: HttpStatus.BAD_REQUEST };
        }
        referenceDuration = await probeDurationSec(destAbs);
      } catch (err) {
        cleanupDisk();
        return {
          error: `参考视频归一化失败：${err instanceof Error ? err.message : 'ffmpeg 执行失败'}`,
          code: HttpStatus.BAD_REQUEST,
        };
      }

      let referenceFileId: string;
      let referencePath: string;
      try {
        const { created } = await fileService.upload(
          buildMulterFile(destAbs, `${sanitizeFileName(name, 'avatar')}.mp4`, 'video/mp4'),
          {
            category: DIGITAL_HUMAN_REFERENCE_CATEGORY,
            ...(userId ? { createBy: userId } : {}),
            metadata: { duration: referenceDuration },
          },
        );
        referenceFileId = String(created._id);
        referencePath = created.path;
      } catch (err) {
        cleanupDisk();
        return { error: err instanceof Error ? err.message : '参考视频保存失败', code: HttpStatus.ERROR };
      }

      try {
        const avatar = await digitalHumanAvatarRepository.create({
          name,
          sourceOriginalName: file.originalname,
          sourceSize: file.size,
          sourceMimeType: file.mimetype,
          sourceDuration,
          referenceFileId,
          referencePath,
          referenceDuration,
          ...(userId ? { userId } : {}),
        });
        return { data: this.toRecord(avatar) };
      } catch (err) {
        logger.error(`形象记录落库失败（referenceFileId=${referenceFileId}）：${err instanceof Error ? err.message : err}`);
        try {
          await fileService.delete(referenceFileId);
        } catch (cleanupErr) {
          logger.warn(`file 记录回滚失败（referenceFileId=${referenceFileId}）：${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`);
        }
        cleanupDisk();
        if (isDuplicateKeyError(err)) {
          return { error: `形象名称「${name}」已存在，请换一个名称`, code: HttpStatus.CONFLICT };
        }
        return { error: err instanceof Error ? err.message : '形象保存失败', code: HttpStatus.ERROR };
      }
    } finally {
      // 上传的原始素材仅作中间产物，成功失败都不留盘
      removeFileQuietly(file.path, msg => logger.warn(`参考视频临时文件清理失败（${file.path}）：${msg}`));
    }
  }

  /** 分页查询形象：userId 精确 + name 模糊（均可选） */
  async listAvatars(
    query: DigitalHuman.AvatarQuery,
  ): Promise<ServiceResult<PaginatedResponse<DigitalHuman.AvatarRecord>>> {
    const page = await digitalHumanAvatarRepository.findPage({
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.name ? { name: query.name } : {}),
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

  /** 按 id 查询形象 */
  async getAvatar(id: string): Promise<ServiceResult<DigitalHuman.AvatarRecord>> {
    const owned = await this.assertOwner(id, '');
    if ('error' in owned) return owned;
    return { data: this.toRecord(owned.record) };
  }

  /**
   * 按名称解析形象（仅当前用户自己的记录，精确匹配）。
   * 未命中时在错误里列出该用户可用形象名称，供 MCP 调用方改参重试。
   */
  async resolveByName(name: string, userId: string): Promise<ServiceResult<DigitalHuman.AvatarRecord>> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      return { error: '形象名称不能为空', code: HttpStatus.BAD_REQUEST };
    }
    if (!userId) {
      return { error: '无法解析当前用户', code: HttpStatus.UNAUTHORIZED };
    }

    const record = await digitalHumanAvatarRepository.findByUserAndName(userId, trimmed);
    if (record) {
      return { data: this.toRecord(record) };
    }

    const list = await this.listAvatars({ userId, limit: 50 });
    const names = 'data' in list ? list.data.list.map(avatar => avatar.name) : [];
    const hint = names.length ? `当前用户可用形象：${names.join('、')}` : '当前用户暂无可用形象';
    return { error: `未找到名称为「${trimmed}」的形象。${hint}`, code: HttpStatus.NOT_FOUND };
  }

  /** 修改形象名称：仅允许操作归属当前用户且未删除的记录 */
  async renameAvatar(
    id: string,
    userId: string,
    name: string,
  ): Promise<ServiceResult<DigitalHuman.AvatarRecord>> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      return { error: '形象名称不能为空', code: HttpStatus.BAD_REQUEST };
    }

    const owned = await this.assertOwner(id, userId);
    if ('error' in owned) return owned;

    if (owned.record.name === trimmed) {
      return { data: this.toRecord(owned.record) };
    }

    if (await digitalHumanAvatarRepository.existsByUserAndName(userId, trimmed)) {
      return { error: `形象名称「${trimmed}」已存在，请换一个名称`, code: HttpStatus.CONFLICT };
    }

    try {
      const updated = await digitalHumanAvatarRepository.updateNameByOwner(id, userId, trimmed);
      if (!updated) {
        return { error: '形象不存在', code: HttpStatus.NOT_FOUND };
      }
      return { data: this.toRecord(updated) };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return { error: `形象名称「${trimmed}」已存在，请换一个名称`, code: HttpStatus.CONFLICT };
      }
      logger.error(`形象改名失败（id=${id}）：${err instanceof Error ? err.message : err}`);
      return { error: err instanceof Error ? err.message : '形象改名失败', code: HttpStatus.ERROR };
    }
  }

  /** 删除形象（假删除；file 记录与磁盘文件保留，便于排查历史问题） */
  async removeAvatar(id: string, userId: string): Promise<ServiceResult<true>> {
    const owned = await this.assertOwner(id, userId);
    if ('error' in owned) return owned;

    const ok = await digitalHumanAvatarRepository.softDeleteByOwner(id, userId);
    if (!ok) {
      return { error: '形象不存在', code: HttpStatus.NOT_FOUND };
    }
    return { data: true };
  }

  /**
   * 解析参考视频的绝对路径，供数字人合成使用。
   * 参考视频是 HeyGem 的唯一形象输入，缺失就无法合成，故用 409 明确区分于 404。
   */
  async resolveReference(
    avatarId: string,
    userId: string,
  ): Promise<ServiceResult<{ avatar: DigitalHumanAvatarDocument; absPath: string }>> {
    const owned = await this.assertOwner(avatarId, userId);
    if ('error' in owned) return owned;

    const file = await fileService.getById(owned.record.referenceFileId);
    if (!file) {
      return { error: '形象参考视频已失效，请重新创建形象', code: HttpStatus.CONFLICT };
    }
    // FILE_UPLOAD_DIR 是相对路径，交给 ffmpeg/挂载前必须 resolve 成绝对路径
    const absPath = path.resolve(fileService.getAbsolutePath(file));
    if (!fs.existsSync(absPath)) {
      return { error: '形象参考视频文件已丢失，请重新创建形象', code: HttpStatus.CONFLICT };
    }
    return { data: { avatar: owned.record, absPath } };
  }

  /**
   * 归属校验：记录不存在 → 404；存在但不属于当前用户 → 403。
   * userId 为空串时（如详情接口未强制登录）跳过归属判定。
   */
  private async assertOwner(
    id: string,
    userId: string,
  ): Promise<{ record: DigitalHumanAvatarDocument } | { error: string; code: number }> {
    if (!isValidObjectId(id)) {
      return { error: '形象不存在', code: HttpStatus.NOT_FOUND };
    }
    const record = await digitalHumanAvatarRepository.findById(id);
    if (!record) {
      return { error: '形象不存在', code: HttpStatus.NOT_FOUND };
    }
    if (userId && record.userId !== userId) {
      return { error: '只能操作当前用户自己的形象', code: HttpStatus.FORBIDDEN };
    }
    return { record };
  }

  /** 落库文档 → 对外记录（_id 统一映射为 id，并补上免 JWT 的下载地址） */
  private toRecord(doc: DigitalHumanAvatarDocument): DigitalHuman.AvatarRecord {
    const referenceFileId = doc.referenceFileId;
    return {
      id: String(doc._id),
      name: doc.name,
      sourceOriginalName: doc.sourceOriginalName,
      sourceSize: doc.sourceSize,
      sourceMimeType: doc.sourceMimeType,
      sourceDuration: doc.sourceDuration,
      referenceFileId,
      referenceUrl: `/api/files/${referenceFileId}/download`,
      referenceDuration: doc.referenceDuration,
      backend: doc.backend,
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const digitalHumanAvatarService = new DigitalHumanAvatarService();
