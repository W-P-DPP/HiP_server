import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { voiceTrainService } from "../../src/voiceTrain/voiceTrain.service.ts";
import { Logger } from '../../utils/Logger.ts';

const logger = Logger.getInstance();

/**
 * 自动生成视频 MCP 工具集：复用 voiceTrain 视频生成管道服务。
 * 提交任务（异步）→ 返回 taskId → 轮询查询结果，最终拿到合成视频地址。
 * resId 不要求调用方传入 resId，仅需传音色名称 res：由会话（hip-uuid）解析出当前用户，
 * 按名称在其成功训练记录中匹配（无用户记录/匹配分不足时兜底公共音色池）自动解析 resId。
 */
export function registerAutoVideoTools(mcpServer: McpServer, ctx: { userId?: string }): void {
    /**
     * 提交视频生成任务：讯飞TTS合成语音 → 转写生成字幕 → ffmpeg 合成带字幕视频。
     * 音色 resId 按名称 res 从当前会话用户成功训练记录中匹配（assetId 优先，回退 trainVcn），
     * 无成功可用记录或匹配分不足时兜底公共音色池（默认 公共女生）。
     * 异步执行，立即返回 taskId，用 get_video_status 轮询结果。
     */
    mcpServer.registerTool(
        "generate_video",
        {
            description: "提交自动生成视频任务（音色克隆TTS → 字幕 → ffmpeg合成带字幕视频）。音色名称 res 自动从当前会话用户的训练记录中匹配（匹配度最高的训练成功记录的 assetId，回退 trainVcn），公共音色兜底（默认公共女声）。异步执行，立即返回 taskId，需用 get_video_status 轮询任务状态与最终视频地址。",
            inputSchema: z.object({
                text: z.string().min(1).describe("待合成的视频旁白文本"),
                res: z.string().min(1).default('公共女生').describe("音色名称，默认 公共女生"),
                speed: z.number().optional().describe("语速，0-100，默认70"),
                volume: z.number().optional().describe("音量，0-100"),
                pitch: z.number().optional().describe("语调，0-100"),
                language: z.number().optional().describe("合成语种：0 中 / 1 英 / 2 日 / 3 韩 / 4 俄，默认 0"),
                encoding: z.string().optional().describe("音频编码，默认 lame(mp3)"),
                sampleRate: z.number().optional().describe("采样率，默认 24000"),
                color: z.string().optional().describe("视频背景色（色名或 #RRGGBB），默认 black"),
            })
        },
        async ({ text, speed, volume, pitch, language, encoding, sampleRate, color,res }) => {
            logger.info('mcp 视频生成任务开始,userId：' + ctx.userId)
            const resIdResult = await voiceTrainService.resolvePipelineResId(ctx.userId, res);
            if ('error' in resIdResult) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(resIdResult)
                        }
                    ]
                };
            }
            const result = await voiceTrainService.createPipelineTask({
                resId: resIdResult.resId,
                text,
                ...(speed != null ? { speed } : {}),
                ...(volume != null ? { volume } : {}),
                ...(pitch != null ? { pitch } : {}),
                ...(language != null ? { language } : {}),
                ...(encoding ? { encoding } : {}),
                ...(sampleRate != null ? { sampleRate } : {}),
                ...(color ? { color } : {}),
                ...(ctx.userId ? { userId: ctx.userId } : {}),
            });
            logger.info('mcp 视频生成任务成功,userId：' + ctx.userId)

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
     * 查询视频生成任务状态/结果：pending / running / success / failed，
     * 成功时返回 videoUrl、audioUrl、subtitleSrtUrl 等。
     */
    mcpServer.registerTool(
        "get_video_status",
        {
            description: "按 taskId 查询自动生成视频任务的状态与结果。status 为 success 时返回最终视频下载地址 videoUrl，failed 时返回 message 失败原因。",
            inputSchema: z.object({
                taskId: z.string().min(1).describe("generate_video 返回的任务 id"),
            })
        },
        async ({ taskId }) => {
            const result = await voiceTrainService.getPipelineTask(taskId, ctx.userId);
            logger.info(`mcp 视频查询,userId:${ctx.userId};taskId:${taskId};text:${JSON.stringify(result)}` )
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
