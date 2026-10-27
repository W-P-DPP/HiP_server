import { isValidObjectId } from 'mongoose';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import {
  DEFAULT_SPEED_MODE,
  PREVIEW_DEFAULT_TEXT,
  SYNTHESIS_SPEED_MODES,
  indexttsStageLabel,
} from '../../utils/constant/indextts.ts';
import {
  DEFAULT_SYNTHESIS_PURPOSE,
  SYNTHESIS_PURPOSES,
} from '../../utils/constant/voiceTrainV2.ts';
import indexttsConfig from '../../utils/indextts/indextts.config.ts';
import { getIndexttsEngine } from '../../utils/indextts/indexttsEngineFactory.ts';
import { voiceTrainV2VoiceService } from './voiceTrainV2Voice.service.ts';
import { voiceTrainV2SynthesisTaskRepository } from './voiceTrainV2SynthesisTask.repository.ts';
import { indexttsDispatcher } from './indexttsDispatcher.ts';
import type { VoiceTrainV2SynthesisTaskDocument } from './voiceTrainV2SynthesisTask.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { VoiceTrainV2 } from '../../type/index.d.ts';

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/**
 * 音色克隆合成服务。
 *
 * 提交只负责「建任务 + 唤醒调度器」，不在请求链路里执行合成 —— 一次合成要跑几秒到几分钟，
 * 且必须串行在唯一那个持有 GPU 模型的进程上，所以由 indexttsDispatcher 异步领取执行，
 * 客户端轮询 GET /synthesize/:taskId 取进度（与 V1 讯飞合成同一套客户端契约）。
 */
class VoiceTrainV2SynthesisService {
  /**
   * 提交合成任务。
   *
   * `purpose=preview`（试听）成功后会把结果回写到音色的试听字段；`synthesis`（正式合成，缺省）
   * 不回写 —— 否则正式内容合成会覆盖用户在音色列表里听到的试听。
   */
  async submit(dto: VoiceTrainV2.SynthesizeDto): Promise<ServiceResult<VoiceTrainV2.SynthesizeAccepted>> {
    if (!indexttsConfig.enabled) {
      return { error: 'IndexTTS 引擎未启用，暂不支持在线合成', code: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (!dto.voiceId || !isValidObjectId(dto.voiceId)) {
      return { error: '非法的 voiceId 参数', code: HttpStatus.BAD_REQUEST };
    }

    const text = (dto.text ?? '').trim() || PREVIEW_DEFAULT_TEXT;
    if (text.length > indexttsConfig.maxTextChars) {
      return {
        error: `文本长度不能超过 ${indexttsConfig.maxTextChars} 字（当前 ${text.length} 字）`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    const speedMode = (dto.speedMode ?? DEFAULT_SPEED_MODE) as string;
    if (!(SYNTHESIS_SPEED_MODES as readonly string[]).includes(speedMode)) {
      return {
        error: `不支持的速度档位「${speedMode}」，可选：${SYNTHESIS_SPEED_MODES.join(' / ')}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    // 用途缺省 synthesis（保守）：漏传时按正式合成处理，不回写音色试听字段，
    // 避免正式内容合成覆盖用户听到的试听效果。
    const purpose = (dto.purpose ?? DEFAULT_SYNTHESIS_PURPOSE) as string;
    if (!(SYNTHESIS_PURPOSES as readonly string[]).includes(purpose)) {
      return {
        error: `不支持的合成用途「${purpose}」，可选：${SYNTHESIS_PURPOSES.join(' / ')}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    const userId = dto.userId ?? '';
    // 提交时就校验音色归属与参考音可用性：让用户立刻拿到 403/409，
    // 而不是等任务跑起来才失败（那时只能通过轮询发现）。
    const resolved = await voiceTrainV2VoiceService.resolveReference(dto.voiceId, userId);
    if ('error' in resolved) {
      return { error: resolved.error, code: resolved.code };
    }

    const task = await voiceTrainV2SynthesisTaskRepository.create({
      voiceId: dto.voiceId,
      text,
      speedMode,
      purpose,
      ...(userId ? { userId } : {}),
    });

    // 懒启动调度器：没有这个调用，任务会一直躺在 pending 里（没 GPU 的开发机也不会加载模型）
    indexttsDispatcher.start();

    return { data: { taskId: String(task._id), status: task.status } };
  }

  /** 查询合成任务（带归属校验） */
  async getTask(taskId: string, userId: string): Promise<ServiceResult<VoiceTrainV2.SynthesisTaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await voiceTrainV2SynthesisTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    // V1 的 getSynthesisTask 没有做归属校验（按 id 谁都能读别人的任务），这里不复制那个缺口
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的合成任务', code: HttpStatus.FORBIDDEN };
    }
    return { data: this.toRecord(task) };
  }

  /**
   * 取消一条排队中的任务。
   *
   * 仅 status=pending 可取消：取消走仓储的原子条件更新（与 claimNextPending 互斥），
   * 已被领取执行、已完成/失败的任务一律拒绝。
   */
  async cancel(taskId: string, userId: string): Promise<ServiceResult<VoiceTrainV2.SynthesisTaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await voiceTrainV2SynthesisTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能取消当前用户自己的合成任务', code: HttpStatus.FORBIDDEN };
    }
    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await voiceTrainV2SynthesisTaskRepository.cancelPending(taskId);
    if (!cancelled) {
      // 读取与取消之间被 dispatcher 领取（条件更新与 claimNextPending 互斥）
      return { error: '任务已被调度器领取，无法取消', code: HttpStatus.CONFLICT };
    }
    return { data: this.toRecord(cancelled) };
  }

  /**
   * 查询任务排队位置。
   *
   * 位置口径与 claimNextPending 的领取顺序（createdAt 升序 FIFO）一致：
   * position = 队列中比我更早的 pending 数 + 1；waitingAhead 再额外算上正在执行的那条，
   * 即「还要等几个任务跑完才轮到我」。并发度恒为 1，故 running 通常 0 或 1。
   *
   * 注意 count 与领取不是原子的：返回值是查询瞬间的快照，位置会随调度推进而变小。
   */
  async getQueuePosition(
    taskId: string,
    userId: string,
  ): Promise<ServiceResult<VoiceTrainV2.SynthesisTaskQueuePosition>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await voiceTrainV2SynthesisTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的合成任务', code: HttpStatus.FORBIDDEN };
    }

    const [queueDepth, running] = await Promise.all([
      voiceTrainV2SynthesisTaskRepository.countPending(),
      voiceTrainV2SynthesisTaskRepository.countRunning(),
    ]);

    // 非 pending 说明已经轮到自己（running）或已结束，排队位置不再有意义
    let position: number | null = null;
    let waitingAhead = 0;
    if (task.status === 'pending') {
      const before = await voiceTrainV2SynthesisTaskRepository.countPendingBefore(task.createdAt);
      position = before + 1;
      waitingAhead = before + running;
    }

    return { data: { taskId, status: task.status, position, waitingAhead, queueDepth, running } };
  }

  /**
   * 音色合成任务队列计数。
   *
   * 与 getQueuePosition 的区别：不针对具体任务、也不要求归属，返回的是全局计数。
   * pending/running 直接来自 Mongo（只统计 flag=1），跨 worker 全局一致；total = pending + running，
   * 即当前仍在排队或正在执行的任务数。
   */
  async getQueueStatus(): Promise<ServiceResult<VoiceTrainV2.SynthesisQueueStatus>> {
    const [pending, running] = await Promise.all([
      voiceTrainV2SynthesisTaskRepository.countPending(),
      voiceTrainV2SynthesisTaskRepository.countRunning(),
    ]);
    return { data: { total: pending + running, pending, running } };
  }

  /** 分页查询当前用户的合成任务 */
  async listTasks(
    userId: string,
    query: VoiceTrainV2.SynthesisTaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<VoiceTrainV2.SynthesisTaskRecord>>> {
    const page = await voiceTrainV2SynthesisTaskRepository.findPageByUser({
      userId,
      ...(query.status ? { status: query.status } : {}),
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

  /**
   * 引擎状态。
   *
   * 这是**进程内视角**：模型与 leader 租约全机只有一份，所以只有 leader 进程会返回
   * leader=true / workerReady=true，其余进程如实返回 false。带上 workerId 让调用方
   * 能区分「负载均衡换了个进程」和「状态真的变了」；queueDepth 取自 Mongo，是全局口径。
   *
   * GPU 利用率/显存请调用已有的 GET /api/system/resources（src/system/system.service.ts
   * 的 nvidia-smi 实现），此处不重复造一遍。
   */
  async getEngineStatus(): Promise<ServiceResult<VoiceTrainV2.EngineStatus>> {
    const engine = getIndexttsEngine(indexttsConfig);
    const last = engine.getLastProgress();
    const queueDepth = await voiceTrainV2SynthesisTaskRepository.countPending().catch(() => 0);
    // 远端探测失败时降级返回最近一次缓存，不让状态接口本身变成故障点
    const info = await engine.getEngineInfo().catch(() => null);

    return {
      data: {
        workerId: getWorkerId(),
        enabled: indexttsConfig.enabled,
        mode: indexttsConfig.mode,
        workerEnabled: indexttsConfig.workerEnabled,
        workerReady: engine.isReady(),
        leader: indexttsDispatcher.isLeader(),
        healthy: indexttsConfig.enabled && !engine.isUnhealthy(),
        workerPid: engine.getPid(),
        queueDepth,
        lastProgress: last ? { pct: last.pct, stage: last.stage } : null,
        engine: info ?? { kind: engine.kind, modelReady: engine.isReady() },
      },
    };
  }

  /** 落库文档 → 对外记录（_id 映射为 id，并附带阶段中文描述） */
  private toRecord(doc: VoiceTrainV2SynthesisTaskDocument): VoiceTrainV2.SynthesisTaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      voiceId: doc.voiceId,
      text: doc.text,
      speedMode: doc.speedMode,
      purpose: (doc.purpose ?? DEFAULT_SYNTHESIS_PURPOSE) as VoiceTrainV2.SynthesisPurpose,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: indexttsStageLabel(doc.stage),
      message: doc.message,
      duration: doc.duration,
      resultUrl: doc.resultUrl,
      resultFileId: doc.resultFileId,
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const voiceTrainV2SynthesisService = new VoiceTrainV2SynthesisService();
