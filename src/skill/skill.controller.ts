import type { Request, Response } from 'express';
import { skillService } from './skill.service.ts';
import { fileService } from '../file/file.service.ts';
import type { CreateSkillDto, UpdateSkillDto, SkillQueryDto } from './skill.dto.ts';
import type { FileDocument } from '../file/file.entity.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { listZipFolders } from '../../utils/zip.ts';

/** GET /api/skills */
export const listSkills = async (req: Request, res: Response): Promise<void> => {
  try {
    const { category, tags, status, keyword, page, limit } = req.query;

    const query: SkillQueryDto = {
      ...(category && typeof category === 'string' ? { category } : {}),
      ...(tags && typeof tags === 'string' ? { tags } : {}),
      ...(status && typeof status === 'string' ? { status: status as SkillQueryDto['status'] } : {}),
      ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await skillService.list(query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/skills/:key */
export const getSkillByKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const { key } = req.params;
    if (!key) {
      res.sendFail('缺少 key 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const skill = await skillService.getByKey(key);
    if (!skill) {
      res.sendFail('Skill 不存在', HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(skill);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** 将上传的文件保存到文件服务，返回相对路径 */
async function handleUploadedFile(
  file: Express.Multer.File,
  category: string,
): Promise<{ path: string } | { error: string }> {
  try {
    const result = await fileService.upload(file, { category });
    return { path: result.created.path };
  } catch (err) {
    const message = err instanceof Error ? err.message : '文件上传失败';
    return { error: message };
  }
}

/** POST /api/skills */
export const createSkill = async (req: Request, res: Response): Promise<void> => {
  try {
    const dto = req.body as CreateSkillDto;

    // 校验 key、name 必填
    if (!dto.key || !dto.name) {
      res.sendFail('key、name 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    // 从 multer.fields() 中提取文件
    const files = req.files as { file?: Express.Multer.File[]; icon?: Express.Multer.File[] } | undefined;
    const skillFile = files?.file?.[0];
    const iconFile = files?.icon?.[0];

    // 处理 skill 文件上传
    if (skillFile) {
      const result = await handleUploadedFile(skillFile, 'skill');
      if ('error' in result) {
        res.sendFail(result.error, HttpStatus.CONFLICT);
        return;
      }
      dto.filePath = result.path;
    }
    // 处理 icon 图片上传
    if (iconFile) {
      const result = await handleUploadedFile(iconFile, 'icon');
      if ('error' in result) {
        res.sendFail(result.error, HttpStatus.CONFLICT);
        return;
      }
      dto.icon = result.path;
    }
   
    // 校验 filePath 最终存在
    if (!dto.filePath) {
      res.sendFail('filePath 为必填字段（可通过上传文件或直接传参提供）', HttpStatus.BAD_REQUEST);
      return;
    }

    // 从 zip 包中提取顶级文件夹名
    if (!dto.folders || dto.folders.length === 0) {
      const zipPath = fileService.getAbsolutePath({ path: dto.filePath } as FileDocument);
      dto.folders = listZipFolders(zipPath);
    }

    const result = await skillService.create(dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.CONFLICT);
      return;
    }
    res.sendSuccess(result.created, 'Skill 创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/skills/:key */
export const updateSkill = async (req: Request, res: Response): Promise<void> => {
  try {
    const { key } = req.params;
    if (!key) {
      res.sendFail('缺少 key 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const dto = req.body as UpdateSkillDto;

    // 从 multer.fields() 中提取文件
    const files = req.files as { file?: Express.Multer.File[]; icon?: Express.Multer.File[] } | undefined;
    const skillFile = files?.file?.[0];
    const iconFile = files?.icon?.[0];

    // 处理 skill 文件上传
    if (skillFile) {
      const result = await handleUploadedFile(skillFile, 'skill');
      if ('error' in result) {
        res.sendFail(result.error, HttpStatus.CONFLICT);
        return;
      }
      dto.filePath = result.path;
    }

    // 处理 icon 图片上传
    if (iconFile) {
      const result = await handleUploadedFile(iconFile, 'icon');
      if ('error' in result) {
        res.sendFail(result.error, HttpStatus.CONFLICT);
        return;
      }
      dto.icon = result.path;
    }

    // 更新了 zip 包时重新提取文件夹名
    if (dto.filePath && (!dto.folders || dto.folders.length === 0)) {
      const zipPath = fileService.getAbsolutePath({ path: dto.filePath } as FileDocument);
      dto.folders = listZipFolders(zipPath);
    }

    const result = await skillService.update(key, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.updated, 'Skill 更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/skills/:key */
export const deleteSkill = async (req: Request, res: Response): Promise<void> => {
  try {
    const { key } = req.params;
    if (!key) {
      res.sendFail('缺少 key 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const result = await skillService.delete(key);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(null, 'Skill 已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
