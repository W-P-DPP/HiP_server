import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { videoPipelineV2Service } from "../../src/videoPipelineV2/videoPipelineV2.service.ts";
import { voiceTrainV2VoiceService } from "../../src/voiceTrainV2/voiceTrainV2Voice.service.ts";
import { DEFAULT_SPEED_MODE, SYNTHESIS_SPEED_MODES } from "../../utils/constant/indextts.ts";
import { Logger } from '../../utils/Logger.ts';

const logger = Logger.getInstance();

/**
 * 视频生成管道 V2 MCP 工具集：本地 IndexTTS 配音 → Whisper 字幕 → 背景轨 → ffmpeg 烧录成片。
 * 提交任务（异步）→ 返回 taskId → 轮询查询进度与结果，最终拿到成品视频地址。
 * 音色按名称 voiceName 从当前会话用户各自的音色库中精确匹配，命中后转成 voiceId 再提交。
 */
export function registerVideoPipelineV2Tools(mcpServer: McpServer, ctx: { userId?: string }): void {
    /**
     * 提交视频生成管道 V2 任务：IndexTTS 合成配音 → Whisper 生成字幕 → [背景轨] → 烧录封装 mp4。
     * 音色 voiceName 按名称从当前会话用户音色库精确匹配（未命中时错误信息会列出可用名称）。
     * 异步执行，立即返回 taskId，用 vpv2_queue 轮询排队位置、vpv2_status 轮询进度与最终结果。
     */
    mcpServer.registerTool(
        "video_pipeline_v2",
        {
            description: "提交视频生成管道 V2 任务（本地 IndexTTS 合成配音 → Whisper 生成字幕 → [背景素材轨] → ffmpeg 烧录封装成 mp4）。voiceName 必须与当前会话用户音色库中的名称完全一致（未命中时错误信息会列出可用名称）。异步执行，立即返回 taskId，需用 vpv2_queue 轮询排队位置、vpv2_status 轮询进度与最终结果：stage:done 且 progress:1 表示成功，videoUrl 为成品视频下载地址。",
            inputSchema: z.object({
                text: z.string().min(1).describe("驱动视频的旁白文案"),
                voiceName: z.string().min(1).describe("音色名称，须与当前用户音色库中的名称完全一致"),
                speedMode: z.enum(SYNTHESIS_SPEED_MODES).default(DEFAULT_SPEED_MODE).describe("配音速度档位：fast / balanced / quality，默认 balanced"),
                color: z.string().optional().describe("背景色（色名或 #RRGGBB），缺省 black"),
                keywords: z.array(z.string()).optional().describe("每个字幕段落对应的 Pixabay 素材搜索词，用于构建背景轨"),
            })
        },
        async ({ text, voiceName, speedMode, color, keywords }) => {
            if (!ctx.userId) {
                logger.info('mcp 视频生成管道 V2 任务失败：无法解析当前用户');
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: '无法解析当前用户' })
                        }
                    ]
                };
            }
            logger.info(`mcp 视频生成管道 V2 任务开始,userId:${ctx.userId};voiceName:${voiceName};speedMode:${speedMode}`);

            // 音色名称 → 音色 id（仅当前用户自己的记录，精确匹配）
            const voice = await voiceTrainV2VoiceService.resolveByName(voiceName, ctx.userId);
            if ('error' in voice) {
                logger.info(`mcp 视频生成管道 V2 音色解析失败,userId:${ctx.userId};voiceName:${voiceName};error:${voice.error}`);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(voice)
                        }
                    ]
                };
            }

            const result = await videoPipelineV2Service.submit({
                voiceId: voice.data.id,
                text,
                speedMode,
                ...(color ? { color } : {}),
                ...(keywords?.length ? { keywords } : {}),
                userId: ctx.userId,
            });
            logger.info(`mcp 视频生成管道 V2 任务结束,userId:${ctx.userId};result:${JSON.stringify(result)}`);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result)
                    }
                ]
            };
        }
    );

    /**
     * 查询任务状态/结果：pending / running / success / failed，
     * stage 为 ASCII 阶段 key（stageLabel 为中文描述），progress 为 0..1 进度，
     * 成功时 videoUrl 为成品地址、srtUrl / audioUrl 为字幕与配音产物。
     */
    mcpServer.registerTool(
        "vpv2_status",
        {
            description: "按 taskId 查询视频生成管道 V2 任务的状态与结果。stage 表示任务阶段（stageLabel 为中文描述），progress 为 0..1 进度，message 为成功/失败消息；stage:done 且 progress:1 表示成功，videoUrl 为成品视频下载地址，stage:failed 时 message 为失败原因。",
            inputSchema: z.object({
                taskId: z.string().min(1).describe("video_pipeline_v2 返回的任务 id"),
            })
        },
        async ({ taskId }) => {
            const result = await videoPipelineV2Service.getTask(taskId, ctx.userId as string);
            logger.info(`mcp 视频生成管道 V2 任务状态查询,userId:${ctx.userId};taskId:${taskId};text:${JSON.stringify(result)}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result)
                    }
                ]
            };
        }
    );

    /**
     * 成功时返回 {
        "taskId": "6aa4a57b76398445bfb8a885",
        "status": "pending",
        "position": 2,
        "waitingAhead": 2,
        "queueDepth": 3,
        "running": 0
    }。
     */
    mcpServer.registerTool(
        "vpv2_queue",
        {
            description: "按 taskId 查询视频生成管道 V2 任务所属队列位置。status:pending 时 position 表示当前任务在等待队列中的位次（1 为下一个被领取）、waitingAhead 为前方还需跑完的任务数（含正在执行的那条）；非 pending 时 position 为 null。queueDepth 为全局待处理任务数，running 为当前正在执行的任务数。",
            inputSchema: z.object({
                taskId: z.string().min(1).describe("video_pipeline_v2 返回的任务 id"),
            })
        },
        async ({ taskId }) => {
            const result = await videoPipelineV2Service.getQueuePosition(taskId, ctx.userId as string);
            logger.info(`mcp 视频生成管道 V2 队列查询,userId:${ctx.userId};taskId:${taskId};text:${JSON.stringify(result)}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result)
                    }
                ]
            };
        }
    );

    /**
     * 成功时返回 { "total": 3, "pending": 2, "running": 1 }。
     * 全局口径、跨 worker 一致，不针对具体任务、也不要求归属，供队列看板展示积压与在跑数量。
     */
    mcpServer.registerTool(
        "vpv2_queue_status",
        {
            description: "查询视频合成任务队列计数（全局口径，跨 worker 一致）：total 为任务总数（= pending + running），pending 为等待中任务数、running 为运行中任务数。",
            inputSchema: z.object({})
        },
        async () => {
            const result = await videoPipelineV2Service.getQueueStatus();
            logger.info(`mcp 视频生成管道 V2 队列计数查询,text:${JSON.stringify(result)}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result)
                    }
                ]
            };
        }
    );
}
