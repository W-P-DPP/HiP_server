import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WX_CONTENT_IMAGE_EXTENSIONS, WX_CONTENT_IMAGE_MAX_BYTES } from '../constant/wx.ts';

/** 压缩档位：限制宽度 + JPEG 质量，逐级尝试直到小于 1MB */
const COMPRESS_ATTEMPTS = [
  { maxWidth: 1600, quality: 4 },
  { maxWidth: 1600, quality: 8 },
  { maxWidth: 1280, quality: 8 },
  { maxWidth: 1280, quality: 14 },
  { maxWidth: 1024, quality: 16 },
  { maxWidth: 800, quality: 20 },
];

export interface PreparedContentImage {
  /** 可直接上传的文件路径（原文件，或压缩后的临时文件） */
  filePath: string;
  /** 是否为压缩产生的临时文件，上传完成后需删除 */
  temporary: boolean;
}

/** 调 ffmpeg 转 JPEG 并限制宽度（宽度不足时不放大） */
const convertToJpeg = (
  sourcePath: string,
  targetPath: string,
  maxWidth: number,
  quality: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const ffmpegProcess = spawn('ffmpeg', [
      '-y',
      '-i', sourcePath,
      '-vf', `scale=min(${maxWidth}\\,iw):-2`,
      '-q:v', String(quality),
      targetPath,
    ]);

    let stderrOutput = '';
    ffmpegProcess.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg 压缩图片失败，退出码 ${code}\n${stderrOutput}`));
    });

    ffmpegProcess.on('error', (err) => {
      reject(new Error(`启动 ffmpeg 失败: ${err.message}`));
    });
  });

/**
 * 准备用于微信 media/uploadimg 的正文图片。
 * uploadimg 仅支持 jpg/png 且必须小于 1MB，超限图片用 ffmpeg 按档位转 JPEG 压缩。
 */
export const prepareContentImage = async (sourcePath: string): Promise<PreparedContentImage> => {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`图片文件不存在：${sourcePath}`);
  }

  const ext = path.extname(sourcePath).toLowerCase();
  if (
    WX_CONTENT_IMAGE_EXTENSIONS.includes(ext) &&
    fs.statSync(sourcePath).size < WX_CONTENT_IMAGE_MAX_BYTES
  ) {
    return { filePath: sourcePath, temporary: false };
  }

  const tempPath = path.join(os.tmpdir(), `wx-content-image-${crypto.randomUUID()}.jpg`);
  for (const { maxWidth, quality } of COMPRESS_ATTEMPTS) {
    await convertToJpeg(sourcePath, tempPath, maxWidth, quality);
    if (fs.statSync(tempPath).size < WX_CONTENT_IMAGE_MAX_BYTES) {
      return { filePath: tempPath, temporary: true };
    }
  }

  fs.rmSync(tempPath, { force: true });
  throw new Error(`图片压缩后仍超过 1MB，无法上传为正文图片：${path.basename(sourcePath)}`);
};
