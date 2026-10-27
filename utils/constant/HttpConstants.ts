/**
 * 服务端 HTTP 层常量
 */
export class HttpConstants {
    /**
     * JSON 请求体解析上限（body-parser `limit` 语法，如 '10mb'）。
     *
     * express.json() 默认只有 100kb，而 AI 对话（POST /api/aiChat/conversations/:id/chat）会把整份
     * 「场景时间轴 + 画面识别 + 语音转写」拼进 content，长视频动辄数百 KB 甚至更多，默认值会让请求
     * 在 body 解析阶段就抛 PayloadTooLargeError。放宽到 10mb 覆盖完整时间轴，同时保留上限防止超大请求打爆内存。
     */
    public static readonly JSON_BODY_LIMIT: string = '10mb';
}
