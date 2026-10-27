import fs from 'node:fs';
import path from 'node:path';
import { isValidObjectId } from 'mongoose';
import {
  addMaterial as wxAddMaterial,
  uploadTempMedia as wxUploadTempMedia,
  uploadContentImage as wxUploadContentImage,
  delMaterial as wxDelMaterial,
  getMaterial as wxGetMaterial,
  batchGetMaterial as wxBatchGetMaterial,
  getMaterialCount as wxGetMaterialCount,
  getMedia as wxGetMedia,
} from '../../utils/wx/wxMaterial.ts';
import { wxMaterialRepository } from './wxMaterial.repository.ts';
import fileConfig from '../../src/file/file.config.ts';
import { fileService } from '../../src/file/file.service.ts';
import type {
  AddMaterialDto,
  CreateWxMaterialRecord,
  BatchGetMaterialDto,
  DelMaterialResult,
} from './wxMaterial.dto.ts';
import type { WxMaterialDocument } from './wxMaterial.entity.ts';
import type {
  IWxAddMaterialResponse,
  IWxResponse,
  IWxGetResponse,
  IWxGetBathcResponse,
  IWxMaterialCount,
  IWxGetMediaResponse,
} from '../../utils/wx/wx.d.ts';

class WxMaterialService {
  /**
   * 上传素材到微信公众号并保存上传记录
   * 复用 multer 落盘后的临时文件：调微信 add_material → 成功后落库 → 无论成败清理临时文件
   */
  async addMaterial(
    userId: string,
    file: Express.Multer.File,
    dto: AddMaterialDto,
  ): Promise<{ created: WxMaterialDocument } | { error: string }> {
    try {
      const result = await wxAddMaterial(
        userId,
        dto.type,
        file.path,
        dto.type === 'video' && dto.title && dto.introduction
          ? { title: dto.title, introduction: dto.introduction }
          : undefined,
      );

      const record: CreateWxMaterialRecord = {
        type: dto.type,
        mediaId: result.media_id,
        url: result.url,
        fileName: file.originalname,
        fileSize: file.size,
        filePath: path.relative(fileConfig.uploadDir, file.path).replace(/\\/g, '/'),
        title: dto.title,
        introduction: dto.introduction,
      };

      const created = await wxMaterialRepository.create(record);
      return { created };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '素材上传失败' };
    } finally {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
  }

  /**
   * 新增永久素材（按 files 集合的 fileId 引用托管文件）
   * MCP 工具专用：REST 的 addMaterial 会 finally 删除 multer 临时文件；
   * 此处 file 为 files 集合持久化托管的文件，成功后绝不能删除磁盘文件（否则破坏文件服务）。
   */
  async addMaterialByFileId(
    userId: string,
    fileId: string,
    dto: AddMaterialDto,
  ): Promise<{ created: WxMaterialDocument } | { error: string }> {
    try {
      // 快失败：非法 id / 记录不存在 / 磁盘文件缺失，错误信息与文件下载工具保持一致
      if (!isValidObjectId(fileId)) return { error: '文件不存在' };
      const file = await fileService.getById(fileId);
      if (!file) return { error: '文件不存在' };
      if (!fileService.fileExistsOnDisk(file)) return { error: '文件在磁盘上不存在' };

      const result = await wxAddMaterial(
        userId,
        dto.type,
        fileService.getAbsolutePath(file),
        dto.type === 'video' && dto.title && dto.introduction
          ? { title: dto.title, introduction: dto.introduction }
          : undefined,
      );

      const record: CreateWxMaterialRecord = {
        type: dto.type,
        mediaId: result.media_id,
        url: result.url,
        fileName: file.originalName,
        fileSize: file.size,
        // files 集合中 doc.path 已是相对 uploadDir 的相对路径，无需再 relative
        filePath: file.path,
        title: dto.title,
        introduction: dto.introduction,
      };

      const created = await wxMaterialRepository.create(record);
      return { created };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '素材上传失败' };
    }
  }

  /**
   * 上传临时素材到微信公众号（不落库）
   * 复用 multer 落盘后的临时文件：调微信 media/upload → 返回 media_id → finally 清理临时文件
   */
  async uploadTempMedia(
    userId: string,
    file: Express.Multer.File,
    dto: AddMaterialDto,
  ): Promise<{ data: IWxAddMaterialResponse } | { error: string }> {
    try {
      const data = await wxUploadTempMedia(
        userId,
        dto.type,
        file.path,
        dto.type === 'video' && dto.title && dto.introduction
          ? { title: dto.title, introduction: dto.introduction }
          : undefined,
      );
      return { data };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '临时素材上传失败' };
    } finally {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
  }

  /**
   * 解析图文正文图片的 media_id 为可渲染的微信正文图片 URL。
   * draft/add 正文只接受 media/uploadimg 返回的 URL，故优先取本地文件重新上传换取正文 URL；
   * 本地文件缺失时退回上传时微信返回的永久素材 url（该 url 可能被正文过滤，仅作兜底）。
   */
  async getContentImageUrl(userId: string, mediaId: string): Promise<{ url: string } | { error: string }> {
    try {
      const record = await wxMaterialRepository.findByMediaId(mediaId);
      if (!record) return { error: `正文图片素材不存在：${mediaId}` };

      const absolutePath = record.filePath ? path.join(fileConfig.uploadDir, record.filePath) : '';
      if (absolutePath && fs.existsSync(absolutePath)) {
        return { url: await wxUploadContentImage(userId, absolutePath) };
      }
      if (record.url) return { url: record.url };

      return { error: `正文图片本地文件缺失且无可用 URL：${mediaId}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '正文图片上传失败' };
    }
  }

  /**
   * 删除永久素材：微信删除成功后，假删除（flag:0）本地 wxMaterials 记录
   */
  async delMaterial(userId: string, mediaId: string): Promise<{ data: DelMaterialResult } | { error: string }> {
    try {
      const data = await wxDelMaterial(userId, mediaId);
      const localDeletedCount = await wxMaterialRepository.softDeleteByMediaId(mediaId);
      return { data: { ...data, localDeletedCount } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '素材删除失败' };
    }
  }

  /** 获取永久素材详情（透传微信响应） */
  async getMaterial(userId: string, mediaId: string): Promise<{ data: IWxGetResponse & IWxResponse } | { error: string }> {
    try {
      const data = await wxGetMaterial(userId, mediaId);
      return { data };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '素材获取失败' };
    }
  }

  /** 获取永久素材列表（透传微信响应） */
  async batchGetMaterial(
    userId: string,
    dto: BatchGetMaterialDto,
  ): Promise<{ data: IWxGetBathcResponse & IWxResponse } | { error: string }> {
    try {
      const data = await wxBatchGetMaterial(userId, dto.type, dto.offset, dto.count);
      return { data };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '素材列表获取失败' };
    }
  }

  /** 获取永久素材数量（透传微信响应） */
  async getMaterialCount(userId: string): Promise<{ data: IWxMaterialCount & IWxResponse } | { error: string }> {
    try {
      const data = await wxGetMaterialCount(userId);
      return { data };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '素材数量获取失败' };
    }
  }

  /**
   * 获取临时素材（JSON 透传）
   * 注意：image/voice/thumb 微信返回二进制，本接口仅对 video（video_url）适用
   */
  async getMedia(userId: string, mediaId: string): Promise<{ data: IWxGetMediaResponse } | { error: string }> {
    try {
      const data = await wxGetMedia(userId, mediaId);
      return { data };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '临时素材获取失败' };
    }
  }
}

export const wxMaterialService = new WxMaterialService();
