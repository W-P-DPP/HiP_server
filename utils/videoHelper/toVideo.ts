// toVideo.ts
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import MongoDBService from '../../utils/MongoDB.ts'
import { fileService } from '../../src/file/file.service.ts'
import fileConfig from '../../src/file/file.config.ts'
import type { FileDocument } from '../../src/file/file.entity.ts'
import { runFfmpeg } from './ffmpeg.ts'

/** 视频生成结果（file 模块注册后的产物信息） */
export interface ToVideoResult {
    fileId: string;
    originalName: string;
    mimeType: string;
    size: number;
    url: string;
}

/** 把 file 模块记录映射为对外结果 */
const toFileResult = (doc: FileDocument): ToVideoResult => {
    const fileId = doc._id.toString();
    return {
        fileId,
        originalName: doc.originalName,
        mimeType: doc.mimeType,
        size: doc.size,
        url: `/api/files/${fileId}/download`,
    };
};

/**
 * 背景色规整：色名透传，#RRGGBB → 0xRRGGBB（ffmpeg lavfi color 解析），非法输入回落 black。
 * 白名单仅允许 #、数字、字母，隔离冒号/逗号/分号等滤镜分隔符注入。
 */
const sanitizeColor = (color?: string): string => {
    if (!color) return 'black';
    const t = color.trim();
    if (!/^[#0-9a-zA-Z]+$/.test(t)) return 'black';
    return t.startsWith('#') ? `0x${t.slice(1)}` : t;
};

/** 将已落盘文件按 file 模块规范注册 */
const uploadGenerated = async (absolutePath: string, originalName: string, mime: string): Promise<ToVideoResult> => {
    const buf = fs.readFileSync(absolutePath);
    const multerFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: originalName,
        encoding: '7bit',
        mimetype: mime,
        size: buf.length,
        destination: path.dirname(absolutePath),
        filename: path.basename(absolutePath),
        path: absolutePath,
        buffer: buf,
        stream: Readable.from(buf),
    };
    const result = await fileService.upload(multerFile);
    return toFileResult(result.created);
};

/**
 * 音频 + 字幕 → 视频，生成产物注册到 file 模块统一管理。
 * 视频落盘在 file 模块的 uploads/YYYY/MM/DD 目录，注册成功后返回可下载的 fileId + URL。
 * @param sound 音频文件路径
 * @param srt 字幕（SRT）文件路径
 * @param rename 可选：对外文件名（originalName），默认 toVideo-{uuid}.mp4
 * @param color 可选：视频背景色（色名或 #RRGGBB），默认 black；传入 background 时忽略
 * @param background 可选：已生成的背景视频（1280x720@30fps），替代纯色源作为第一输入
 */
export const toVideo = async (sound: string, srt: string, rename?: string, color?: string, background?: string): Promise<ToVideoResult> => {
    if (!fs.existsSync(sound)) {
        throw new Error(`音频文件不存在: ${sound}`);
    }
    if (!fs.existsSync(srt)) {
        throw new Error(`字幕文件不存在: ${srt}`);
    }
    if (background && !fs.existsSync(background)) {
        throw new Error(`背景视频不存在: ${background}`);
    }

    // 复用 file 模块上传目录 + 日期子目录
    const now = new Date();
    const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const dir = path.join(fileConfig.uploadDir, subDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const uuid = crypto.randomUUID();
    const storedName = `${uuid}.mp4`;
    const outputPath = path.join(dir, storedName);
    const originalName = rename ? path.basename(rename) : `toVideo-${storedName}`;

    // Windows 下 subtitles 滤镜路径转义规则：
    // 1. 反斜杠改为正斜杠（subfile 协议不转义正斜杠）
    // 2. 盘符冒号转义为 \:（否则被解析为滤镜选项分隔符）
    // 3. 用单引号包裹整个路径
    const escapedSrtPath = path.resolve(srt).replace(/\\/g, '/').replace(/:/g, '\\:');
    const soundPath = path.resolve(sound);

    // 第一输入：有背景视频则直接喂 mp4（数组传参零转义），否则 lavfi 纯色源
    const backgroundPath = background ? path.resolve(background) : undefined;
    const videoInput = backgroundPath
        ? ['-i', backgroundPath]
        : ['-f', 'lavfi', '-i', `color=c=${sanitizeColor(color)}:s=1280x720`];

    const args = [
        '-y',
        ...videoInput,
        '-i', soundPath,
        '-vf', `subtitles=filename='${escapedSrtPath}':force_style='Fontsize=24,FontName=Microsoft YaHei'`,
        '-c:v', 'libx264',
        ...(backgroundPath ? ['-preset', 'veryfast'] : []),
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-y',
        outputPath,
    ];

    try {
        await runFfmpeg(args);
        return await uploadGenerated(outputPath, originalName, 'video/mp4');
    } catch (err) {
        // 失败时清理本次落盘文件（已成功注册的由 file 记录持有）
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        throw err;
    }
}
