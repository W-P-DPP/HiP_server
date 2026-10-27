import { createApp } from '../app.ts';
import RedisService from './Redis.ts';
import MongoDBService from './MongoDB.ts';
import { drainShutdownHooks } from './shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS } from './constant/ClusterConstants.ts';
import indexttsConfig from './indextts/indextts.config.ts';
import heygemConfig from './heygem/heygem.config.ts';
import asrConfig from './asr/asr.config.ts';
import videoPipelineV2Config from './videoPipelineV2/videoPipelineV2.config.ts';
import narrationVideoConfig from './narrationVideo/narrationVideo.config.ts';
import aiDetectConfig from './aiDetect/aiDetect.config.ts';
import vlmConfig from './vlm/vlm.config.ts';
import vlmBatchConfig from './vlm/vlmBatch.config.ts';
import '../eventRegister.ts';

let server: import('node:http').Server | null = null;
let shuttingDown = false;

/**
 * worker（或单进程模式）启动：连接 Redis/Mongo → 组装 Express app → listen。
 * 单进程模式下等价于原 main.ts 的 bootstrap。
 */
export async function startWorker(): Promise<void> {
    try {
        console.log('ENV:', process.env.NODE_ENV || 'development');
        console.log('PORT:', process.env.PORT);
        await RedisService.getInstance().connect();
        // await initDataBase(); // MySQL 初始化保持注释
        await MongoDBService.getInstance().connect();
        const app = createApp();
        const PORT = process.env.PORT || 30010;
        server = app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
            // 通知 master 已就绪（单进程模式下 process.send 不存在，安全跳过）
            process.send?.({ type: 'ready', pid: process.pid });
        });
        installShutdownHandlers();
        // 调度器必须常驻：它只从 Mongo 领取 pending 任务，不加载模型（是否预热由
        // prewarmIfEnabled / INDEXTTS_AUTOSTART 控制）。旧实现把「启动调度循环」与
        // autostart 绑在一起，而生产 autostart=false ⇒ 重启后没有任何进程领取队列里
        // 已存在的任务，它们会永远停在 pending，只能等下一次 POST /synthesize 撞开
        // 懒启动 —— 这就是「重启后任务卡住」的根因。
        // 动态 import 是为了让不需要它的进程（以及启动路径）不为这棵依赖树买单。
        if (indexttsConfig.enabled) {
            const { indexttsDispatcher } = await import('../src/voiceTrainV2/indexttsDispatcher.ts');
            indexttsDispatcher.start();
        }
        // 数字人调度器同理：此前只在 POST /digitalHuman/tasks 时才懒启动，重启后队列同样冻结。
        if (heygemConfig.enabled) {
            const { digitalHumanDispatcher } = await import('../src/digitalHuman/digitalHumanDispatcher.ts');
            digitalHumanDispatcher.start();
        }
        // 字幕调度器同理：转写走云端/外部 HTTP，不加载本机模型，但队列同样必须常驻。
        if (asrConfig.enabled) {
            const { subtitleDispatcher } = await import('../src/subtitle/subtitleDispatcher.ts');
            subtitleDispatcher.start();
        }
        // 视频管道 V2 调度器同理：它只提交并轮询配音/字幕子任务，队列同样必须常驻。
        if (videoPipelineV2Config.enabled) {
            const { videoPipelineV2Dispatcher } = await import('../src/videoPipelineV2/videoPipelineV2Dispatcher.ts');
            videoPipelineV2Dispatcher.start();
        }
        // 解说视频调度器同理：它只提交并轮询配音子任务、其余走本机 ffmpeg，队列同样必须常驻，
        // 否则重启后已排队的任务会一直停在 pending，只能等下一次提交才被唤醒。
        if (narrationVideoConfig.enabled) {
            const { narrationVideoDispatcher } = await import('../src/narrationVideo/narrationVideoDispatcher.ts');
            narrationVideoDispatcher.start();
        }
        // 场景切分调度器同理：检测是纯 CPU 的本地子进程，不加载模型，但队列同样必须常驻，
        // 否则重启后已排队的任务会一直停在 pending，只能等下一次提交才被唤醒。
        if (aiDetectConfig.enabled) {
            const { aiDetectDispatcher } = await import('../src/aiDetect/aiDetectDispatcher.ts');
            aiDetectDispatcher.start();
        }
        // 图片理解调度器同理：它只把图片 HTTP 发给独立的 Qwen3-VL 容器，本进程不持有模型，
        // 但队列同样必须常驻，否则重启后已排队的任务会一直停在 pending。
        if (vlmConfig.enabled) {
            const { vlmDispatcher } = await import('../src/vlm/vlmDispatcher.ts');
            vlmDispatcher.start();
        }
        // 批量图像识别调度器同理：它把抽帧关键帧逐张 HTTP 发给同一个 Qwen3-VL 容器，本进程不持有模型，
        // 但队列同样必须常驻，否则重启后已排队的批次会一直停在 pending。
        if (vlmBatchConfig.enabled) {
            const { vlmBatchDispatcher } = await import('../src/vlmBatch/vlmBatchDispatcher.ts');
            vlmBatchDispatcher.start();
        }
    } catch (err) {
        console.error('Bootstrap error:', err);
        process.exit(1);
    }
}

/**
 * 优雅退出：停止接收新连接 → 等待业务排空钩子（任务队列结算）→ 退出。
 * 超时兜底强制退出；长任务超窗由下次启动的中断恢复流程重新入队（attempts 达上限才判失败）。
 */
async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => {
        console.error('[worker] 排空超时，强制退出');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();
    try {
        server?.close();
        server?.closeIdleConnections?.();
        await drainShutdownHooks();
        console.log('[worker] 排空完成，退出');
        process.exit(0);
    } catch (err) {
        console.error('[worker] 优雅退出异常：', err);
        process.exit(1);
    }
}

function installShutdownHandlers(): void {
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('message', (msg: { type?: string }) => {
        if (msg?.type === 'shutdown') void shutdown('master 通知');
    });
}
