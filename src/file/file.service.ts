import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileRepository } from './file.repository.ts';
import fileConfig from './file.config.ts';
import type { FileDocument } from './file.entity.ts';
import type { FileQueryDto, UpdateFileDto, UploadOptions } from './file.dto.ts';

class FileService {
  /**
   * 计算文件 MD5（流式）。
   *
   * 不用 readFileSync 一次性读入：分片上传合并后的素材可达 GB 级，整份读进内存既会顶爆堆，
   * 也会在超过 Buffer 上限时直接 ERR_FS_FILE_TOO_LARGE。流式读只占一个固定大小的缓冲。
   */
  private computeMd5(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      fs.createReadStream(filePath)
        .on('error', reject)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  /**
   * 处理单文件上传
   * 保存文件元数据到 MongoDB，返回文件记录
   */
  async upload(
    file: Express.Multer.File,
    options: UploadOptions = {},
  ): Promise<{ created: FileDocument }> {
    const absolutePath = file.path;
    // md5 仅作元数据存储，不参与去重
    const md5 = await this.computeMd5(absolutePath);

    const ext = path.extname(file.originalname);
    const storedName = path.basename(file.path);
    // 计算相对于 uploadDir 的相对路径
    const relativePath = path.relative(fileConfig.uploadDir, file.path).replace(/\\/g, '/');

    const created = await fileRepository.create({
      originalName: file.originalname,
      storedName,
      path: relativePath,
      size: file.size,
      mimeType: file.mimetype,
      ext,
      md5,
      ...(options.category ? { category: options.category } : {}),
      ...(options.createBy ? { createBy: options.createBy } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });

    return { created };
  }

  /**
   * 批量上传文件
   */
  async uploadMultiple(
    files: Express.Multer.File[],
    options: UploadOptions = {},
  ): Promise<{ created: FileDocument[] }> {
    const created: FileDocument[] = [];

    for (const file of files) {
      const result = await this.upload(file, options);
      created.push(result.created);
    }

    return { created };
  }

  /** 分页查询文件列表 */
  async list(query: FileQueryDto) {
    return fileRepository.findMany(query);
  }

  /** 按 ID 获取文件元数据 */
  async getById(id: string): Promise<FileDocument | null> {
    return fileRepository.findById(id);
  }

  /** 获取文件的绝对路径 */
  getAbsolutePath(doc: FileDocument): string {
    return path.join(fileConfig.uploadDir, doc.path);
  }

  /** 检查文件在磁盘上是否存在 */
  fileExistsOnDisk(doc: FileDocument): boolean {
    return fs.existsSync(this.getAbsolutePath(doc));
  }

  /** 下载文件（增加下载计数） */
  async recordDownload(id: string): Promise<void> {
    await fileRepository.incrementDownloadCount(id);
  }

  /** 更新文件元数据 */
  async update(id: string, dto: UpdateFileDto): Promise<{ updated: FileDocument } | { error: string }> {
    const file = await fileRepository.findById(id);
    if (!file) {
      return { error: '文件不存在' };
    }

    if (dto.originalName !== undefined) file.originalName = dto.originalName;
    if (dto.category !== undefined) file.category = dto.category;
    if (dto.metadata !== undefined) file.metadata = dto.metadata;

    const updated = await file.save();
    return { updated };
  }

  /** 假删除文件记录（flag 置 0，磁盘文件保留） */
  async delete(id: string): Promise<{ error?: string }> {
    const file = await fileRepository.findById(id);
    if (!file) {
      return { error: '文件不存在' };
    }

    await fileRepository.softDeleteById(id);
    return {};
  }
}

export const fileService = new FileService();
