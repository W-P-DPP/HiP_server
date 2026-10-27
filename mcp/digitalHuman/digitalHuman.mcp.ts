import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { digitalHumanAvatarService } from "../../src/digitalHuman/digitalHumanAvatar.service.ts";
import { voiceTrainV2VoiceService } from "../../src/voiceTrainV2/voiceTrainV2Voice.service.ts";
import { digitalHumanTaskService } from "../../src/digitalHuman/digitalHumanTask.service.ts";
import { DEFAULT_SPEED_MODE, SYNTHESIS_SPEED_MODES } from "../../utils/constant/indextts.ts";
import { Logger } from '../../utils/Logger.ts';

const logger = Logger.getInstance();
export function registerDigitalHumanTools(mcpServer: McpServer, ctx: { userId?: string }): void {
    /**
     * 提交数字人合成任务：IndexTTS 合成配音 → duix(HeyGem) 对口型产出成片。
     * 形象与音色按名称从当前会话用户各自的库中精确匹配，命中后转成 id 再提交。
     * 异步执行，立即返回 taskId，用 dh_queue 轮询排队位置、dh_status 轮询进度与结果。
     * 当 dh_status 的 stage:done 且 progress:1 时表示当前任务合成成功。
     */
    mcpServer.registerTool(
        "digital_human",
        {
            description: "提交数字人合成任务（IndexTTS 合成配音 → duix/HeyGem 对口型产出成片）。avatarName / voiceName 必须与当前会话用户形象库、音色库中的名称完全一致（未命中时错误信息会列出可用名称）。异步执行，立即返回 taskId，需用 dh_queue 轮询排队位置、dh_status 轮询进度与最终结果：stage:done 且 progress:1 表示成功，resultUrl 为成片下载地址。burnSubtitles=true 时会对配音音频生成字幕并烧录进成片，resultUrl 为带字幕版本、rawVideoUrl 为烧录前原片、srtUrl 为字幕文件。",
            inputSchema: z.object({
                text: z.string().min(1).describe("驱动数字人的口播文案"),
                avatarName: z.string().min(1).describe("数字人形象名称，须与当前用户形象库中的名称完全一致"),
                voiceName: z.string().min(1).describe("音色名称，须与当前用户音色库中的名称完全一致"),
                speedMode: z.enum(SYNTHESIS_SPEED_MODES).default(DEFAULT_SPEED_MODE).describe("配音速度档位：fast / balanced / quality，默认 balanced"),
                burnSubtitles: z.boolean().default(true).describe("是否把字幕烧录进成片：true 时先对配音音频生成字幕再烧录，默认 true"),
                subtitleOptions: z.object({
                    fontSize: z.number().optional().describe("字幕字号（像素），默认 24"),
                    fontName: z.string().optional().describe("字幕字体名，默认 微软雅黑"),
                    colorHex: z.string().optional().describe("字幕颜色 #RRGGBB，默认 #FFFFFF"),
                    outline: z.number().optional().describe("描边宽度，默认 1"),
                    position: z.enum(['bottom', 'top']).optional().describe("字幕垂直位置，默认 bottom"),
                    marginV: z.number().optional().describe("距上/下边缘边距（像素），默认 底部 24 / 顶部 16"),
                }).optional().describe("字幕烧录样式，仅 burnSubtitles=true 时生效；不传用服务端默认样式"),
            })
        },
        async ({ text, avatarName, voiceName, speedMode, burnSubtitles, subtitleOptions }) => {
            if (!ctx.userId) {
                logger.info('mcp 数字人合成任务失败：无法解析当前用户');
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: '无法解析当前用户' })
                        }
                    ]
                };
            }
            logger.info(`mcp 数字人合成任务开始,userId:${ctx.userId};avatarName:${avatarName};voiceName:${voiceName}`);

            // 形象名称 → 形象 id（仅当前用户自己的记录，精确匹配）
            const avatar = await digitalHumanAvatarService.resolveByName(avatarName, ctx.userId);
            if ('error' in avatar) {
                logger.info(`mcp 数字人形象解析失败,userId:${ctx.userId};avatarName:${avatarName};error:${avatar.error}`);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(avatar)
                        }
                    ]
                };
            }

            // 音色名称 → 音色 id（仅当前用户自己的记录，精确匹配）
            const voice = await voiceTrainV2VoiceService.resolveByName(voiceName, ctx.userId);
            if ('error' in voice) {
                logger.info(`mcp 数字人音色解析失败,userId:${ctx.userId};voiceName:${voiceName};error:${voice.error}`);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(voice)
                        }
                    ]
                };
            }

            const result = await digitalHumanTaskService.submit({
                avatarId: avatar.data.id,
                voiceId: voice.data.id,
                text,
                speedMode,
                ...(burnSubtitles ? { burnSubtitles: true } : {}),
                ...(subtitleOptions ? { subtitleOptions } : {}),
                userId: ctx.userId,
            });
            logger.info(`mcp 数字人合成任务结束,userId:${ctx.userId};result:${JSON.stringify(result)}`);

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
        "status": "running",
        "position": null,
        "waitingAhead": 0,
        "queueDepth": 1,
        "running": 2
    }。
     */
    mcpServer.registerTool(
        "dh_queue",
        {
            description: "按 taskId 查询数字人合成任务所属队列位置，position:null & status:running 时表示该任务处于运行中的状态，position有值且status:pending时position的值表示当前任务所处队列的位置",
            inputSchema: z.object({
                taskId: z.string().min(1).describe("digital_human 返回的任务 id"),
            })
        },
        async ({ taskId }) => {
            const result = await digitalHumanTaskService.getQueuePosition(taskId, ctx.userId as string);
            logger.info(`mcp 数字人队列查询,userId:${ctx.userId};taskId:${taskId};text:${JSON.stringify(result)}`)
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
     * {
        "id": "6aa3701d8c621384ac9f4ab6",
        "status": "failed",
        "avatarId": "6aa36f088c621384ac9f4ab5",
        "voiceId": "6aa29546dea139fa4c72a851",
        "text": "同一套产品，同一个交付团队，在A客户三个月上线，在B客户拖了一年。你猜差别在哪？不在代码里。做交付的FDE凑在一起，聊不过三句就是那句话：不是产品不行，是客户环境太差。这话对了一半。环境确实差，但环境不是机房里那堆机器，是客户的组织。今天我用五分钟讲三件事：四种客户各自死在哪，三个病根是什么，还有进场第一周，怎么提前看出一个项目的结局。先说外企。我接触下来，外企往往是对接最顺的一类。文档齐全，接口规范，问题清单提前三天发过来。刚进场你会觉得，这单稳了。然后卡住。生产权限批不下来，安全评审要过区域总部。你等的那个人，不在这栋楼里，甚至不在这个时区里。我见过一个项目，技术对接两周就完事，之后大半年，全在等一份几百道题的安全问卷。问卷先翻成英文答一轮，总部提了意见，再答一轮。FDE在这个项目里的主要产出，是一份越来越厚的邮件存档。所以外企的问题不是能不能做，是谁有权批准做。方案书写得合不合总部的口味，通常比代码质量更影响上线日期。那国企和政务项目呢？流程倒是全在本地，但节奏被预算日历框死了。上半年立项，年中采购，年底验收，留给开发的，就中间那么几周。系统是新的，日历是旧的，你得在这几周里，干完别处三个月的活。而且FDE花在方案、投标、验收材料上的时间，通常超过写代码的时间。更扎心的是，验收通过那天拿到回款，不代表有人在用。半年后回访，登录记录寥寥无几。你交付的是一套合规文档，加一个能跑的系统，这是两套评价体系天然的错位。民企又是另一种画风。老板看完演示，下周就要用，爽快得让人感动。但三个月后，他在别处听了个新概念，回来开两小时会，方向就变了，之前俩月的定制作废。民企的问题不是慢，是快带来的反复。真正的功课，是把每次需求变更的代价写到纸面上，让签字的人看见。还有一类民企是例外：管理层里有真用系统长大的职业经理人，有速度也有章法，这种客户通常最好做，遇到了要珍惜。初创呢？CEO亲自拉群，CTO亲自导数据，一周上线，体验相当好。然后三个月后，那位CTO离职了。没人维护，没人更新数据，系统还挂在服务器上，但已经死了。部署越顺利，死得越安静。所以FDE在这里真正干的活，是替客户把本来不存在的东西补上一部分：谁负责数据，谁负责日常运营，出了问题第一通电话打给谁。这些事客户自己想不到，想到了也觉得不急。把四种环境摆在一起，病根其实就三个。第一，决策权在谁手里。外企在总部，国企在流程，民企在老板个人，初创在那个人身上，而那个人随时可能走。第二，数据事实上归谁管。进第一天看一眼数据的真实状态，项目一半的工作量，心里就有数了。第三，上线之后谁养。没人运营的系统，就是个摆设。这个判断不靠天赋，进场第一周就能做。看会议纪要里谁最后发言，看上一份需求文档改了几版、谁签的字，看数据是从系统里导的，还是有人手工在表格里攒的。四件事看下来，这个目会以哪种方式卡住，基本心里有数。当然也得说清边界。老产线内外网隔离这种硬约束，那就是技术问题，别什么都往组织上归因。同一个客户内部也分层，总部像国企，子公司创新部门像初创，具体项目要看具体的人。如果你是设这个岗位的管理者，结论也一样：别拿统一的项目模板套所有客户。在民企堆流程人天是浪费，在国企不留足审批周期是自欺。招人的时候，技术底子是门槛，真正稀缺的是场一周内看出项目会死在哪的判断力。这种判断力面试里考不出来，只能靠一轮轮项目复盘攒出来。有位同行说过一句话，我一直记得。他说，客户忘了你的产品叫什么都没关系，只要还记得周五要更新数据就行。流程，比功能活得久。说白了，FDE部署的从来不只是产品，是产品和一种组织相处的方式。如果你的团队里也有踩过坑的老FDE，替我珍惜他。",
        "speedMode": "fast",
        "progress": 0.45,
        "stage": "failed",
        "stageLabel": "失败",
        "message": "HeyGem 合成失败：{\"code\":10000,\"data\":{\"code\":\"9ad0c4d474a242d889b7c3a04b7a0660\",\"msg\":\"三次获取音频时长失败\",\"progress\":0,\"result\":\"\",\"status\":3},\"msg\":\"\",\"success\":true}",
        "audioTaskId": "6aa3701f8c621384ac9f4ab7",
        "audioFileId": "6aa372748c621384ac9f4ab8",
        "audioUrl": "/api/files/6aa372748c621384ac9f4ab8/download",
        "audioDuration": 334.423492,
        "resultUrl": "",
        "resultFileId": "",
        "videoDuration": 0,
        "startedAt": "2026-09-11T03:06:07.009Z",
        "finishedAt": "2026-09-11T03:16:07.096Z",
        "userId": "6aa108adab93a58154718c1c",
        "createdAt": "2026-09-11T03:06:05.947Z",
        "updatedAt": "2026-09-11T03:16:07.097Z"
}
     */
    mcpServer.registerTool(
        "dh_status",
        {
            description: "按 taskId 查询数字人合成任务状态，stage表示任务状态，message表示成功或者失败消息，progress表示当前的任务进度",
            inputSchema: z.object({
                taskId: z.string().min(1).describe("digital_human 返回的任务 id"),
            })
        },
        async ({ taskId }) => {
            const result = await digitalHumanTaskService.getTask(taskId, ctx.userId as string);
            logger.info(`mcp 数字人任务状态查询,userId:${ctx.userId};taskId:${taskId};text:${JSON.stringify(result)}`)
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
