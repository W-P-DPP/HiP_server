import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { narrationVideoService } from "../../src/narrationVideo/narrationVideo.service.ts";
import { voiceTrainV2VoiceService } from "../../src/voiceTrainV2/voiceTrainV2Voice.service.ts";
import { DEFAULT_SPEED_MODE, SYNTHESIS_SPEED_MODES } from "../../utils/constant/indextts.ts";
import { Logger } from '../../utils/Logger.ts';

const logger = Logger.getInstance();

/** 单个「细节段」出画片段（源视频时间轴，毫秒） */
const clipSchema = z.object({
    start: z.number().describe("片段起点（毫秒，含）"),
    end: z.number().describe("片段终点（毫秒，不含）"),
    description: z.string().optional().describe("片段内容描述（仅记录）"),
});

/** 单个解说分段：一段解说文案 + 其细节段原切片段 */
const segmentSchema = z.object({
    start: z.number().describe("分段起点（毫秒，含）"),
    end: z.number().describe("分段终点（毫秒，不含）"),
    text: z.string().min(1).describe("该段解说文案（需要配音）"),
    emotion: z.string().optional().describe("情感标签（仅记录）"),
    clips: z.array(clipSchema).optional().describe("细节段原切视频候选片段（取时长最短的一段，并列取起点最早，保留原声原字幕）；缺省用整段 [start,end]"),
});

/**
 * 解说视频 MCP 工具集：前端/调用方提交「解说结构化数据」+ 场景切分任务 id + 音色 → 成片。
 * 提交（异步）→ 返回 taskId → 轮询查询结果，最终拿到成品视频地址。
 * 音色按名称 voiceName 从当前会话用户各自的音色库中精确匹配，命中后转成 voiceId 再提交。
 */
export function registerNarrationVideoTools(mcpServer: McpServer, ctx: { userId?: string }): void {
    /**
     * 提交解说视频任务：从场景切分任务解析源视频 → 逐段「解说段（整段 [start,end] 画面去源字幕 +
     * IndexTTS 配音 + 解说字幕）+ 细节段（按 clips 裁剪拼接的原切视频，保留原声原字幕）」→ 拼接 →
     * 烧录解说字幕成片。
     */
    mcpServer.registerTool(
        "narration_video",
        {
            description: "提交解说视频任务（从场景切分任务解析源视频，逐段拆成两段：① 解说段——整段 [start,end] 画面去除源视频烧死字幕 + IndexTTS 配音 + 解说字幕；② 细节段——取 clips 中时长最短的一段（并列取起点最早）裁出的原切视频，保留原声原字幕、不叠解说字幕。两段拼接后烧录解说字幕成片）。sceneTaskId 须是已完成的场景切分任务；voiceName 必须与当前会话用户音色库中的名称完全一致。异步执行，立即返回 taskId，需用 nv_status 轮询进度与最终结果：stage:done 且 progress:1 表示成功，videoUrl 为成品视频下载地址。",
            inputSchema: z.object({
                sceneTaskId: z.string().min(1).describe("来源场景切分任务 id（status 须为 success）"),
                voiceName: z.string().min(1).describe("音色名称，须与当前用户音色库中的名称完全一致"),
                narration: z.object({
                    title: z.string().optional().describe("解说标题"),
                    summary: z.string().optional().describe("解说概要"),
                    segments: z.array(segmentSchema).min(1).describe("解说分段（start/end 为源视频毫秒）"),
                }).describe("解说结构化数据"),
                speedMode: z.enum(SYNTHESIS_SPEED_MODES).default(DEFAULT_SPEED_MODE).describe("配音速度档位：fast / balanced / quality，默认 balanced"),
            })
        },
        async ({ sceneTaskId, voiceName, narration, speedMode }) => {
            if (!ctx.userId) {
                logger.info('mcp 解说视频任务失败：无法解析当前用户');
                return { content: [{ type: "text", text: JSON.stringify({ error: '无法解析当前用户' }) }] };
            }
            logger.info(`mcp 解说视频任务开始,userId:${ctx.userId};sceneTaskId:${sceneTaskId};voiceName:${voiceName}`);

            const voice = await voiceTrainV2VoiceService.resolveByName(voiceName, ctx.userId);
            if ('error' in voice) {
                logger.info(`mcp 解说视频音色解析失败,userId:${ctx.userId};voiceName:${voiceName};error:${voice.error}`);
                return { content: [{ type: "text", text: JSON.stringify(voice) }] };
            }

            const result = await narrationVideoService.submit({
                sceneTaskId,
                voiceId: voice.data.id,
                narration,
                speedMode,
                userId: ctx.userId,
            });
            logger.info(`mcp 解说视频任务结束,userId:${ctx.userId};result:${JSON.stringify(result)}`);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
    );

    /**
     * 查询任务状态/结果：pending / running / success / failed，
     * stage 为 ASCII 阶段 key（stageLabel 为中文描述），progress 为 0..1 进度。
     */
    mcpServer.registerTool(
        "nv_status",
        {
            description: "按 taskId 查询解说视频任务的状态与结果。stage 表示任务阶段（stageLabel 为中文描述），progress 为 0..1 进度，message 为成功/失败消息；stage:done 且 progress:1 表示成功，videoUrl 为成品视频下载地址，stage:failed 时 message 为失败原因。",
            inputSchema: z.object({
                taskId: z.string().min(1).describe("narration_video 返回的任务 id"),
            })
        },
        async ({ taskId }) => {
            const result = await narrationVideoService.getTask(taskId, ctx.userId as string);
            logger.info(`mcp 解说视频任务状态查询,userId:${ctx.userId};taskId:${taskId}`);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
    );

    /**
     * 查询任务排队位置与全局队列计数。
     */
    mcpServer.registerTool(
        "nv_queue",
        {
            description: "按 taskId 查询解说视频任务所属队列位置。status:pending 时 position 表示当前任务在等待队列中的位次（1 为下一个被领取）、waitingAhead 为前方还需跑完的任务数；非 pending 时 position 为 null。queueDepth 为全局待处理任务数，running 为当前正在执行的任务数。",
            inputSchema: z.object({
                taskId: z.string().min(1).describe("narration_video 返回的任务 id"),
            })
        },
        async ({ taskId }) => {
            const result = await narrationVideoService.getQueuePosition(taskId, ctx.userId as string);
            logger.info(`mcp 解说视频队列查询,userId:${ctx.userId};taskId:${taskId}`);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
    );

    /**
     * 查询全局队列计数（不针对具体任务、不要求归属）。
     */
    mcpServer.registerTool(
        "nv_queue_status",
        {
            description: "查询解说视频任务队列计数（全局口径，跨 worker 一致）：total 为任务总数（= pending + running），pending 为等待中任务数、running 为运行中任务数。",
            inputSchema: z.object({})
        },
        async () => {
            const result = await narrationVideoService.getQueueStatus();
            logger.info(`mcp 解说视频队列计数查询,text:${JSON.stringify(result)}`);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
    );
}
