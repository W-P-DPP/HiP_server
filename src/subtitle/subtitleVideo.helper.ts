// src/subtitle/subtitleVideo.helper.ts
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { SUBTITLE_EXTRACT_SUBDIR, SUBTITLE_NO_AUDIO_MESSAGE } from '../../utils/constant/subtitle.ts';
import { removeFileQuietly } from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';

/** 提取出的音频在临时目录里的固定文件名 */
const EXTRACTED_AUDIO_NAME = 'audio.wav';

/**
 * 视频字幕任务的临时音频路径助手。
 *
 * 为什么是临时目录而不是 file 表记录：提取出的 wav 只是「视频 → 音频」的中间产物，
 * 任务终结后不再有消费方（SRT 才是产物）。落进 uploads 下的点号子目录可以同时拿到两个好处：
 * ① 与 fileService 的相对路径口径一致（`uploads/.subtitle/<uuid>/audio.wav`），
 * ② express.static 的 dotfiles 默认 ignore，不会被 `/static/files/.subtitle/...` 暴露出去。
 *
 * 生命周期：由 service 在提交时创建；由 dispatcher 在任务进入终态时删除（见 execute 的 finally）；
 * 排队中取消由 service.cancel 删除。
 */

/** 新建一个临时音频位，返回绝对路径与 uploads 相对路径（相对路径用于落库） */
export function newExtractedAudioPath(uploadDir: string): { abs: string; rel: string } {
  const dirName = crypto.randomUUID();
  const absDir = path.join(uploadDir, SUBTITLE_EXTRACT_SUBDIR, dirName);
  fs.mkdirSync(absDir, { recursive: true });
  return {
    abs: path.join(absDir, EXTRACTED_AUDIO_NAME),
    rel: `${SUBTITLE_EXTRACT_SUBDIR}/${dirName}/${EXTRACTED_AUDIO_NAME}`,
  };
}

/**
 * uploads 相对路径 → 绝对路径。
 *
 * 点号子目录与日期子目录（`YYYY/MM/DD`）都只是 uploadDir 下的普通层级，故与
 * fileService.getAbsolutePath 同一算法；单列一个函数是为了让 dispatcher 不必知道
 * 「临时音频按什么规则命名」。
 */
export function resolveExtractedAudio(uploadDir: string, rel: string): string {
  return path.resolve(path.join(uploadDir, rel));
}

/** 删除临时音频及其所在目录；尽力而为（调用方通常在错误清理或终态路径上，失败只记不抛） */
export function removeExtractedAudio(
  uploadDir: string,
  rel: string,
  onError?: (message: string) => void,
): void {
  if (!rel) return;
  const abs = resolveExtractedAudio(uploadDir, rel);
  removeFileQuietly(abs, onError);
  try {
    fs.rmdirSync(path.dirname(abs));
  } catch {
    // 目录非空（异常残留）或已被删；留给运维/后续任务覆盖，不因清理失败影响主流程
  }
}

/** 交给用户看的失败文案上限：足够放下一行 ffmpeg 错误，又不至于把整段日志甩出去 */
const EXTRACT_FAILURE_MAX_CHARS = 200;

/**
 * 把 ffmpeg 的原始报错收敛成一句可直接展示的话。
 *
 * runFfmpeg 的报错里带着完整 stderr（含 ANSI 色标、内部绝对路径、容器细节），原样回包既看不懂
 * 也算泄露路径。两类情形分开处理：
 * - **无音轨**（ffmpeg 报 “Output file does not contain any stream”，或显式 -map 落空时的
 *   “matches no streams”）是最常见的用户输入问题，给固定指引文案；
 * - 其余（文件损坏、编码不支持、ffmpeg 未安装…）取 stderr 最后一行 —— 真正的错误行在最后，
 *   前面的都是输入信息与进度刷屏 —— 并截断长度。
 *
 * 只匹配上述两种精确措辞，不用宽泛的 “Stream map”：ffmpeg 正常输出里也有 “Stream mapping:”，
 * 会把无关失败误判成无音轨，给出误导用户的建议。
 */
export function describeExtractFailure(message: string): string {
  if (/does not contain any stream|matches no streams/.test(message)) {
    return SUBTITLE_NO_AUDIO_MESSAGE;
  }
  const lastLine =
    message
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .pop() ?? '';
  if (!lastLine) return '视频音频提取失败：无法读取该视频';
  return `视频音频提取失败：${lastLine.slice(0, EXTRACT_FAILURE_MAX_CHARS)}`;
}
