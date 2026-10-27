import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../../utils/Logger.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS, TASK_MAX_ATTEMPTS } from '../../utils/constant/ClusterConstants.ts';
import { indexttsStageLabel } from '../../utils/constant/indextts.ts';
import {
  NARRATION_VIDEO_AUDIO_BITRATE,
  NARRATION_VIDEO_AUDIO_CHANNELS,
  NARRATION_VIDEO_AUDIO_SAMPLE_RATE,
  NARRATION_VIDEO_CATEGORY,
  NARRATION_VIDEO_FPS,
  NARRATION_VIDEO_NORMALIZE_VF,
  NARRATION_VIDEO_SRT_CATEGORY,
  narrationVideoStageLabel,
} from '../../utils/constant/narrationVideo.ts';
import { runFfmpeg } from '../../utils/videoHelper/ffmpeg.ts';
import { probeDurationMs, probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { burnSubtitlesIntoVideo, type BurnSubtitleStyle } from '../../utils/videoHelper/burnSubtitles.ts';
import type { SrtCue } from '../../utils/videoHelper/srt.ts';
import { runIsolatedContext } from '../../utils/requestContext.ts';
import { tryAcquireLeaderLease, type LeaderLease } from '../../utils/leaderLease.ts';
import narrationVideoConfig from '../../utils/narrationVideo/narrationVideo.config.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import { buildMulterFile, nextUploadPath, removeFileQuietly, sanitizeFileName } from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import { voiceTrainV2SynthesisService } from '../voiceTrainV2/voiceTrainV2Synthesis.service.ts';
import { voiceTrainV2SynthesisTaskRepository } from '../voiceTrainV2/voiceTrainV2SynthesisTask.repository.ts';
import { narrationVideoTaskRepository } from './narrationVideoTask.repository.ts';
import {
  buildSegmentCues,
  buildSubtitleMaskFilter,
  decideFootageFit,
  renderSrt,
  resolveDetailClip,
  type ClipRange,
  type SubtitleMaskOptions,
} from './narrationVideoBuild.helper.ts';
import type { INarrationSegment, NarrationVideoTaskDocument } from './narrationVideoTask.entity.ts';

const logger = Logger.getInstance();

/** 连续续期失败几次才判定失去 leader 地位（容忍一次 Redis 抖动） */
const MAX_RENEW_FAILURES = 2;

/**
 * 进度分带（总和到 0.98，落库 markSuccess 固定置满）。
 * 顺序：解析 → 逐段（配音 + 裁剪 + 适配 + 混流）→ 拼接 → 烧录 → 保存。
 */
const PROGRESS_RESOLVE = 0.02;
const SEGMENT_BAND_START = 0.05;
const SEGMENT_BAND_SPAN = 0.83; // 0.05 → 0.88
const RENDER_BAND = 0.9;
const BURN_BAND = 0.94;
const PROGRESS_PERSIST = 0.98;

/**
 * 解说视频调度器。
 *
 * 与 videoPipelineV2Dispatcher 同构：本服务跑在 node:cluster 下（生产 CLUSTER_WORKERS=10），
 * 用 Redis 租约把调度循环收敛到唯一进程。
 *
 * 本调度器**不直接调用 GPU 引擎**：配音走 voiceTrainV2 合成任务（IndexTTS），
 * 画面裁剪/拼接/烧录全走本机 ffmpeg。若在这里直调 getIndexttsEngine()，就会与 indexttsDispatcher
 * 争抢唯一那块 GPU，因此只做「提交 + 轮询 + 合成」。
 */
class NarrationVideoDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private lease: LeaderLease | null = null;
  private renewFailures = 0;
  private lastRenewAt = 0;
  /** 调度器并发上限（在途任务数），来自 NARRATION_VIDEO_CONCURRENCY */
  private readonly maxConcurrent = narrationVideoConfig.scheduler.concurrency;
  /** 当前在途任务数（由 claimAndRun 维护，恒 ≤ maxConcurrent） */
  private active = 0;
  private running = false;
  /** 上次卡死任务清理时间（leader 专属，按 taskStaleMs/2 节流） */
  private lastRecoveryAt = 0;

  /** 懒启动（幂等）。首次提交任务时调用 */
  start(): void {
    if (this.running) return;
    if (!narrationVideoConfig.enabled) return;
    this.running = true;
    logger.info(`[NarrationVideo] dispatcher 启动（worker=${getWorkerId()}）`);
    // 调度循环由 HTTP 请求触发，若不隔离，setTimeout 链会继承发起请求的 ALS 上下文，
    // 之后所有写库的 updateBy、新文档的 createBy 都会被填成那个用户的 id。
    runIsolatedContext(() => {
      void this.tick();
    });
  }

  isLeader(): boolean {
    return this.lease !== null;
  }

  /** 当前在途任务数 */
  getActiveCount(): number {
    return this.active;
  }

  /** 并发上限（经配置规整后的实际值） */
  getConcurrency(): number {
    return this.maxConcurrent;
  }

  /** 优雅关闭：停掉循环 → 等在途任务结算 → 释放租约 */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.active > 0) {
      // 一条任务含 N 段配音 + 多次 ffmpeg，SHUTDOWN_TIMEOUT_MS 装不下，等不到就放弃 ——
      // 由下一代的恢复流程把它重新入队（segmentStates 已落库，续跑会复用已完成的配音）。
      const deadline = Date.now() + Math.max(0, SHUTDOWN_TIMEOUT_MS - 1000);
      logger.info('[NarrationVideo] 等待在途任务结算…');
      while (this.active > 0 && Date.now() < deadline) {
        await sleep(200);
      }
    }

    if (this.lease) {
      await this.lease.release();
      this.lease = null;
    }
    logger.info('[NarrationVideo] dispatcher 已停止');
  }

  /** 调度循环：选举/续期 → 领取 pending 任务 → 执行 */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.electAndRenew();
      if (this.lease) {
        await this.recoverStuckTasks();
        await this.claimAndRun();
      }
    } catch (err) {
      logger.error(`[NarrationVideo] 调度循环异常：${err instanceof Error ? err.message : err}`);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), narrationVideoConfig.scheduler.pollIntervalMs);
    this.timer.unref();
  }

  /** 在并发额度内领取并启动任务，直到配额用尽或队列为空（单线程内同步推进，无竞态） */
  private async claimAndRun(): Promise<void> {
    while (this.running && this.active < this.maxConcurrent) {
      const task = await narrationVideoTaskRepository.claimNextPending(getWorkerId());
      if (!task) return;
      this.active += 1;
      // execute 自身不抛（异常都落到 markFailed），但 finally 派生出的 promise
      // 仍需兜底 catch —— 否则任何逸出异常都会变成 unhandledRejection 杀掉 worker
      void this.execute(task)
        .catch(err => logger.error(`[NarrationVideo] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  /** 首次由调用方按 pollIntervalMs 驱动，故续期也放在这里 */
  private async electAndRenew(): Promise<void> {
    const { leaseTtlMs } = narrationVideoConfig.scheduler;

    if (!this.lease) {
      this.lease = await tryAcquireLeaderLease({
        key: narrationVideoConfig.scheduler.leaderKey,
        ttlMs: leaseTtlMs,
      });
      if (this.lease) {
        this.renewFailures = 0;
        this.lastRenewAt = Date.now();
        logger.info(`[NarrationVideo] 获得 leader 租约（worker=${getWorkerId()}）`);
      }
      return;
    }

    if (Date.now() - this.lastRenewAt < leaseTtlMs / 2) return;
    this.lastRenewAt = Date.now();

    const ok = await this.lease.renew();
    if (ok) {
      this.renewFailures = 0;
      return;
    }

    this.renewFailures += 1;
    if (this.renewFailures < MAX_RENEW_FAILURES) {
      logger.warn(`[NarrationVideo] 租约续期失败（第 ${this.renewFailures} 次），下次重试`);
      return;
    }

    logger.error('[NarrationVideo] 连续续期失败，让出 leader');
    await this.lease.release();
    this.lease = null;
    this.renewFailures = 0;
  }

  /**
   * 卡死任务恢复（仅 leader 调用）。
   *
   * ① 接手租约时立刻清扫**任何 workerId** 的 running 孤儿（此刻本进程没有在途任务）。
   * ② 周期性按 updatedAt 阈值处理跨进程孤儿（阈值须大于一次完整任务耗时）。
   *
   * 以「重新入队」为主：中断多发生在进程重启/发布期间，此时配音子任务可能已完成或仍在跑，
   * 直接判失败会白费一次 GPU 合成。只有 attempts 达到 TASK_MAX_ATTEMPTS 才失败。
   */
  private async recoverStuckTasks(): Promise<void> {
    if (this.active > 0) return; // 本进程有在途任务，不做任何"恢复"，避免误伤自己
    const interval = Math.max(60_000, Math.floor(narrationVideoConfig.scheduler.taskStaleMs / 2));
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();

    const requeued = await narrationVideoTaskRepository.requeueOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeued > 0) {
      logger.warn(`[NarrationVideo] 恢复：${requeued} 条中断任务已重新入队（含其他 worker 遗留）`);
    }
    const exhausted = await narrationVideoTaskRepository.failExhaustedOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhausted > 0) {
      logger.warn(`[NarrationVideo] 恢复：${exhausted} 条达重试上限的任务已标记失败`);
    }

    const staleBefore = new Date(Date.now() - narrationVideoConfig.scheduler.taskStaleMs);
    const requeuedStale = await narrationVideoTaskRepository.requeueStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeuedStale > 0) {
      logger.warn(`[NarrationVideo] 恢复：${requeuedStale} 条超时未更新的任务已重新入队`);
    }
    const exhaustedStale = await narrationVideoTaskRepository.failExhaustedStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhaustedStale > 0) {
      logger.warn(`[NarrationVideo] 恢复：${exhaustedStale} 条超时且达重试上限的任务已标记失败`);
    }
  }

  /** 执行一条已领取的任务；任何异常都落到 markFailed，不向上抛 */
  private async execute(task: NarrationVideoTaskDocument): Promise<void> {
    const taskId = String(task._id);
    const userId = task.userId ?? '';
    // 临时工作目录（dot 前缀，Express static 默认忽略 dotfiles 不暴露）
    const workDir = path.join(fileConfig.uploadDir, '.narrationVideo', crypto.randomUUID());

    try {
      // ---- ① 解析源视频 ----
      await this.reportProgress(taskId, PROGRESS_RESOLVE, 'resolve', narrationVideoStageLabel('resolve'));
      const sourceAbs = await this.resolveSourceAbs(task.sourceFileId);
      const sourceDurationMs = task.sourceDurationMs > 0
        ? task.sourceDurationMs
        : await probeDurationMs(sourceAbs);

      fs.mkdirSync(workDir, { recursive: true });

      const segments = task.segments ?? [];
      const total = segments.length;
      if (total === 0) throw new Error('解说分段为空，请重新提交');

      const segmentVideoPaths: string[] = [];
      const cues: SrtCue[] = [];
      let accMs = 0;

      // ---- ② 逐段：配音 → 解说段（整段画面去源字幕 + 配音）/ 细节段（clips 原声原片） ----
      for (let i = 0; i < total; i += 1) {
        const segment = segments[i];
        if (!segment) continue;
        const pct = SEGMENT_BAND_START + (i / total) * SEGMENT_BAND_SPAN;
        await this.reportProgress(taskId, pct, 'segment', `分段合成中 · 第 ${i + 1}/${total} 段`);

        // 配音（复用 IndexTTS 合成子任务；中断重排按 voiceTaskId 复用）
        const voiceTaskId = await this.ensureSegmentVoice(task, i, segment);
        await this.waitForSegmentVoice(taskId, voiceTaskId, i, total);
        const audio = await this.resolveVoiceAudio(voiceTaskId);

        // 记录该段执行期状态（voiceTaskId 已在 ensureSegmentVoice 落库，这里补齐产物）
        await this.runIsolated(() =>
          narrationVideoTaskRepository.setSegmentState(taskId, i, {
            index: segment.index,
            voiceTaskId,
            audioFileId: audio.fileId,
            audioUrl: audio.url,
            audioDurationMs: audio.durationMs,
          }),
        );

        const targetMs = audio.durationMs;
        if (targetMs <= 0) throw new Error(`第 ${i + 1} 段配音时长为 0，请重试`);

        // ---- 解说段：整段 [start,end] 画面（去源字幕）+ 解说配音 + 解说字幕 ----
        const coveragePath = await this.buildCoverageFootage(workDir, sourceAbs, i, segment.startMs, segment.endMs);
        const alignedPath = await this.alignFootage(workDir, i, coveragePath, targetMs);
        const narrationSeg = await this.muxSegment(workDir, i, alignedPath, audio.absPath, targetMs);
        segmentVideoPaths.push(narrationSeg);

        // 字幕时间轴（累积偏移）—— 解说段解析说时长
        cues.push(...buildSegmentCues(segment.text, accMs, targetMs));
        accMs += targetMs;

        // ---- 细节段：单个最短 clip 的原切视频（并列取起点最早，保留原声原字幕，不遮罩）----
        const detailClip = resolveDetailClip(segment);
        const detailSeg = await this.buildDetailFootage(workDir, sourceAbs, i, detailClip);
        segmentVideoPaths.push(detailSeg);

        // 细节段无解说字幕，但仍占时间轴，避免后续分段字幕与画面对齐错位
        accMs += await probeDurationMs(detailSeg);
      }

      if (segmentVideoPaths.length === 0) throw new Error('没有可用的分段产物，请重新提交');

      // ---- ③ 拼接成片 ----
      await this.reportProgress(taskId, RENDER_BAND, 'render', narrationVideoStageLabel('render'));
      const finalPath = await this.concatSegments(workDir, segmentVideoPaths, true);

      // ---- ④ 字幕：SRT 直接落到 uploads（成片后仍供下载），并烧录进视频 ----
      const srtContent = renderSrt(cues);
      const outAbs = nextUploadPath(fileConfig.uploadDir, '.mp4');
      const safeTitle = sanitizeFileName(task.title || path.parse(task.sourceOriginalName).name || 'narration');
      await this.reportProgress(taskId, BURN_BAND, 'burn', narrationVideoStageLabel('burn'));

      let srtFileId = '';
      let srtUrl = '';
      if (srtContent) {
        const srtOutAbs = nextUploadPath(fileConfig.uploadDir, '.srt');
        fs.writeFileSync(srtOutAbs, srtContent, 'utf8');
        await burnSubtitlesIntoVideo(finalPath, srtOutAbs, outAbs, this.subtitleStyle());
        const { created } = await fileService.upload(buildMulterFile(srtOutAbs, `${safeTitle}.srt`, 'application/x-subrip'), {
          category: NARRATION_VIDEO_SRT_CATEGORY,
          ...(userId ? { createBy: userId } : {}),
        });
        srtFileId = String(created._id);
        srtUrl = `/api/files/${srtFileId}/download`;
      } else {
        // 无字幕：直接搬运拼接产物（同目录 rename，避免跨目录拷贝）
        fs.copyFileSync(finalPath, outAbs);
      }

      // ---- ⑤ 保存产物 ----
      await this.reportProgress(taskId, PROGRESS_PERSIST, 'persist', narrationVideoStageLabel('persist'));
      const { created: videoFile } = await fileService.upload(
        buildMulterFile(outAbs, `${safeTitle}.mp4`, 'video/mp4'),
        {
          category: NARRATION_VIDEO_CATEGORY,
          ...(userId ? { createBy: userId } : {}),
          metadata: { title: task.title, segmentCount: total },
        },
      );
      const videoDuration = await probeDurationSec(outAbs).catch(() => 0);

      await narrationVideoTaskRepository.markSuccess(taskId, {
        srtFileId,
        srtUrl,
        cueCount: cues.length,
        videoFileId: String(videoFile._id),
        videoUrl: `/api/files/${String(videoFile._id)}/download`,
        videoDuration,
        finishedAt: new Date(),
      });
      logger.info(
        `[NarrationVideo] 合成完成 task=${taskId} 分段=${total} 字幕=${cues.length} 条 file=${String(videoFile._id)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[NarrationVideo] 合成失败 task=${taskId}：${message}`);
      await narrationVideoTaskRepository
        .markFailed(taskId, message, new Date())
        .catch(markErr => logger.error(`[NarrationVideo] 标记失败态也失败了 task=${taskId}：${markErr}`));
    } finally {
      // 分段 clip / 拼接产物 / 中间音频全清（长片峰值可达 GB 级）
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响结果
      }
    }
  }

  // ---- 执行期内聚的小工具 ----

  /** 源视频文件的绝对路径（不存在直接失败，避免后续 ffmpeg 报难懂的错） */
  private async resolveSourceAbs(sourceFileId: string): Promise<string> {
    const file = await fileService.getById(sourceFileId);
    if (!file) throw new Error('源视频文件已失效，请重新提交');
    const abs = path.resolve(fileService.getAbsolutePath(file));
    if (!fs.existsSync(abs)) throw new Error('源视频文件已丢失，请重新提交');
    return abs;
  }

  /**
   * 确保有一段可用的配音子任务：优先复用已落库的 voiceTaskId。
   *
   * 中断（重启/发布）后重跑时，若不复用就会再烧一次完整 GPU 合成；而远端作业本身以
   * clientJobId(= 合成任务 id) 幂等，续用同一个配音任务即可命中同一作业。只有配音任务
   * 不存在或已 failed 时才重新提交。提交后立即落库 voiceTaskId，供再次中断时复用。
   */
  private async ensureSegmentVoice(
    task: NarrationVideoTaskDocument,
    index: number,
    segment: INarrationSegment,
  ): Promise<string> {
    const taskId = String(task._id);
    const existing = task.segmentStates[index]?.voiceTaskId;
    if (existing) {
      const doc = await voiceTrainV2SynthesisTaskRepository.findById(existing);
      if (doc && doc.status !== 'failed') return existing;
    }

    const submitted = await voiceTrainV2SynthesisService.submit({
      voiceId: task.voiceId,
      text: segment.text,
      speedMode: task.speedMode,
      purpose: 'synthesis',
      ...(task.userId ? { userId: task.userId } : {}),
    });
    if ('error' in submitted) throw new Error(`提交第 ${index + 1} 段配音任务失败：${submitted.error}`);
    const voiceTaskId = submitted.data.taskId;

    await this.runIsolated(() =>
      narrationVideoTaskRepository.setSegmentState(taskId, index, {
        index: segment.index,
        voiceTaskId,
        audioFileId: '',
        audioUrl: '',
        audioDurationMs: 0,
      }),
    );
    logger.info(`[NarrationVideo] 配音已提交 task=${taskId} 段=${index + 1} voiceTask=${voiceTaskId}`);
    return voiceTaskId;
  }

  /**
   * 轮询配音子任务直到成功/失败，失败即抛错。
   * 配音走 indexTTS 自己的调度器，这里只做等待与进度透传。
   */
  private async waitForSegmentVoice(
    taskId: string,
    voiceTaskId: string,
    index: number,
    total: number,
  ): Promise<void> {
    const deadline = Date.now() + narrationVideoConfig.voiceTimeoutMs;
    let lastWriteAt = 0;

    while (Date.now() < deadline) {
      const doc = await voiceTrainV2SynthesisTaskRepository.findById(voiceTaskId);
      if (!doc) throw new Error('配音任务不存在（可能已被清理），请重新提交');

      if (doc.status === 'success') return;
      if (doc.status === 'failed') {
        throw new Error(`第 ${index + 1} 段配音失败：${doc.message || '未知原因'}`);
      }

      const now = Date.now();
      if (now - lastWriteAt >= narrationVideoConfig.scheduler.progressMinIntervalMs) {
        lastWriteAt = now;
        // 透传配音任务自身的 message（形如「IndexTTS 合成中 · 段落 12/40」），
        // 否则长文本合成期间前端会看到一句恒定不变的提示，像卡死。
        const pct = SEGMENT_BAND_START + (index / total) * SEGMENT_BAND_SPAN;
        await this.reportProgress(
          taskId,
          pct,
          'segment',
          `第 ${index + 1}/${total} 段配音中 · ${doc.message || indexttsStageLabel(doc.stage)}`,
        );
      }
      await sleep(narrationVideoConfig.scheduler.pollIntervalMs);
    }
    throw new Error(`第 ${index + 1} 段配音超时，请缩短文案后重试`);
  }

  /** 配音子任务成功后就绪的音频（绝对路径 + fileId/url + 时长 ms） */
  private async resolveVoiceAudio(
    voiceTaskId: string,
  ): Promise<{ fileId: string; url: string; absPath: string; durationMs: number }> {
    const doc = await voiceTrainV2SynthesisTaskRepository.findById(voiceTaskId);
    if (!doc || doc.status !== 'success') throw new Error('配音任务未成功，无法取用产物');
    if (!doc.resultFileId) throw new Error('配音任务已完成但未产出音频，请重新提交');

    const file = await fileService.getById(doc.resultFileId);
    if (!file) throw new Error('配音产物已失效，请重新提交');
    const absPath = path.resolve(fileService.getAbsolutePath(file));
    if (!fs.existsSync(absPath)) throw new Error('配音产物文件已丢失，请重新提交');

    const durationMs = await probeDurationMs(absPath);
    return { fileId: doc.resultFileId, url: doc.resultUrl, absPath, durationMs };
  }

  /** 成片统一的音频编码参数（解说段/细节段一致，concat `-c copy` 才能安全拼接） */
  private get audioArgs(): string[] {
    return [
      '-c:a', 'aac',
      '-ar', String(NARRATION_VIDEO_AUDIO_SAMPLE_RATE),
      '-ac', String(NARRATION_VIDEO_AUDIO_CHANNELS),
      '-b:a', NARRATION_VIDEO_AUDIO_BITRATE,
    ];
  }

  /**
   * 解说段画面：整段 `[startMs, endMs]` 源画面，归一化到成片规格、静音，并对源视频烧死的字幕区域做
   * 模糊/遮罩（细节段则保留源字幕，见 buildDetailFootage）。
   * 生成后由 alignFootage 裁剪/循环到解说配音时长。
   */
  private async buildCoverageFootage(
    workDir: string,
    sourceAbs: string,
    index: number,
    startMs: number,
    endMs: number,
  ): Promise<string> {
    const durSec = (endMs - startMs) / 1000;
    if (durSec <= 0) throw new Error(`第 ${index + 1} 段区间非法，无法出画`);

    const mask = buildSubtitleMaskFilter(this.subtitleMaskOptions());
    const vf = mask ? `${NARRATION_VIDEO_NORMALIZE_VF},${mask}` : NARRATION_VIDEO_NORMALIZE_VF;
    const outPath = path.join(workDir, `seg${index}_coverage.mp4`);
    await runFfmpeg([
      '-y',
      // -ss 在 -i 之前 = 输入侧快速定位（跳到目标点前最近的关键帧再解码），长视频上快得多
      '-ss', (startMs / 1000).toFixed(3),
      '-i', sourceAbs,
      '-t', durSec.toFixed(3),
      '-vf', vf,
      '-r', String(NARRATION_VIDEO_FPS),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-an',
      outPath,
    ]);
    return outPath;
  }

  /**
   * 细节段画面：从源视频裁剪单个 clip（该段最短的一段，并列取起点最早，见 resolveDetailClip），
   * 归一化到成片规格并保留原声（按成片音频规格编码）。
   * 不施加字幕遮罩 —— 细节段按设计保留源片原字幕。
   */
  private async buildDetailFootage(
    workDir: string,
    sourceAbs: string,
    index: number,
    clip: ClipRange,
  ): Promise<string> {
    const durSec = (clip.endMs - clip.startMs) / 1000;
    if (durSec <= 0) throw new Error(`第 ${index + 1} 段细节片段区间非法，无法出画`);

    const outPath = path.join(workDir, `seg${index}_detail.mp4`);
    await runFfmpeg([
      '-y',
      // -ss 在 -i 之前 = 输入侧快速定位（跳到目标点前最近的关键帧再解码），长视频上快得多
      '-ss', (clip.startMs / 1000).toFixed(3),
      '-i', sourceAbs,
      '-t', durSec.toFixed(3),
      '-vf', NARRATION_VIDEO_NORMALIZE_VF,
      '-r', String(NARRATION_VIDEO_FPS),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      ...this.audioArgs,
      outPath,
    ]);
    return outPath;
  }

  /**
   * 画面适配解说时长：以解说音频时长 targetMs 为准。
   * 画面过短 → 循环整段画面补齐；过长/基本相等 → 直接裁剪到目标（-c copy）。
   */
  private async alignFootage(
    workDir: string,
    index: number,
    footagePath: string,
    targetMs: number,
  ): Promise<string> {
    const footageMs = await probeDurationMs(footagePath);
    const fit = decideFootageFit(footageMs, targetMs);
    if (fit === 'exact') return footagePath;

    const alignedPath = path.join(workDir, `seg${index}_aligned.mp4`);
    const seconds = (targetMs / 1000).toFixed(3);
    if (fit === 'trim') {
      await runFfmpeg(['-y', '-i', footagePath, '-t', seconds, '-c', 'copy', alignedPath]);
    } else {
      // 循环整个画面轨补齐到解说时长（重编码；-an 保证无音轨）
      await runFfmpeg([
        '-y',
        '-stream_loop', '-1',
        '-i', footagePath,
        '-t', seconds,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-an',
        alignedPath,
      ]);
    }
    return alignedPath;
  }

  /**
   * 把解说段画面与解说配音混流成一段（画面轨本身无音轨，此处只带解说音轨）。
   * `-t targetMs` 锁死段长，使解说段与解说字幕时间轴严格对齐。
   * 音轨按统一规格编码，保证与细节段（原声）拼接时 concat `-c copy` 安全。
   */
  private async muxSegment(
    workDir: string,
    index: number,
    alignedPath: string,
    audioAbs: string,
    targetMs: number,
  ): Promise<string> {
    const segPath = path.join(workDir, `seg${index}.mp4`);
    await runFfmpeg([
      '-y',
      '-i', alignedPath,
      '-i', audioAbs,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      ...this.audioArgs,
      '-t', (targetMs / 1000).toFixed(3),
      '-movflags', '+faststart',
      segPath,
    ]);
    return segPath;
  }

  /** 拼接所有分段成片（带音轨） */
  private async concatSegments(workDir: string, paths: string[], hasAudio: boolean): Promise<string> {
    const finalPath = path.join(workDir, 'final.mp4');
    await this.concatWith(workDir, 'final', paths, finalPath, hasAudio);
    return finalPath;
  }

  /**
   * concat demuxer 拼接：先尝试 `-c copy`（各段规格已统一），失败回退重编码。
   * list 文件 LF 结尾、路径 `\` → `/` 且单引号包裹、`-safe 0` 放行绝对路径。
   */
  private async concatWith(
    workDir: string,
    stem: string,
    paths: string[],
    outputPath: string,
    hasAudio: boolean,
  ): Promise<void> {
    const listPath = path.join(workDir, `${stem}_list.txt`);
    const lines = paths.map((p) => `file '${path.resolve(p).replace(/\\/g, '/')}'`);
    fs.writeFileSync(listPath, `${lines.join('\n')}\n`, 'utf8');

    try {
      await runFfmpeg(['-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
    } catch (err) {
      logger.warn(
        `[NarrationVideo] concat -c copy 失败，回退重编码：${err instanceof Error ? err.message : err}`,
      );
      await runFfmpeg([
        '-y',
        '-fflags', '+genpts',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', NARRATION_VIDEO_AUDIO_BITRATE] : ['-an']),
        outputPath,
      ]);
    }
  }

  /** 字幕烧录样式（缺省项交给 burnSubtitles 的默认值） */
  private subtitleStyle(): BurnSubtitleStyle {
    const { subtitle } = narrationVideoConfig;
    return {
      ...(subtitle.fontSize !== undefined ? { fontSize: subtitle.fontSize } : {}),
      ...(subtitle.fontName !== undefined ? { fontName: subtitle.fontName } : {}),
      ...(subtitle.colorHex !== undefined ? { colorHex: subtitle.colorHex } : {}),
      position: subtitle.position,
      ...(subtitle.marginV !== undefined ? { marginV: subtitle.marginV } : {}),
    };
  }

  /** 源字幕遮罩参数（仅作用于解说段的整段画面） */
  private subtitleMaskOptions(): SubtitleMaskOptions {
    const { subtitleMask } = narrationVideoConfig;
    return {
      enabled: subtitleMask.enabled,
      mode: subtitleMask.mode,
      x: subtitleMask.x,
      y: subtitleMask.y,
      w: subtitleMask.w,
      h: subtitleMask.h,
      blurStrength: subtitleMask.blurStrength,
    };
  }

  /** 写一次进度（关键节点不受节流限制）；隔离 ALS，避免把请求用户写成后台记录归属 */
  private async reportProgress(
    taskId: string,
    progress: number,
    stage: string,
    message: string,
  ): Promise<void> {
    await this.runIsolated(() =>
      narrationVideoTaskRepository.updateProgress(taskId, { progress, stage, message }).catch(() => {
        // 进度上报失败不影响合成本身
      }),
    );
  }

  /** 在无身份的独立 ALS 上下文中执行（后台调度不继承 HTTP 请求上下文） */
  private runIsolated<T>(fn: () => Promise<T>): Promise<T> {
    return runIsolatedContext(fn);
  }
}

export const narrationVideoDispatcher = new NarrationVideoDispatcher();

// 关机钩子：与 IndexTTS/字幕/数字人/视频管道同样的排空语义
registerShutdownHook(() => narrationVideoDispatcher.stop());
