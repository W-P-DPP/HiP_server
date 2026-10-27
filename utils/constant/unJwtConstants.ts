/**
 * JWT 免鉴权白名单路径前缀（匹配 req.path，即挂载点 /hip/api 之后的部分）。
 * 命中 req.path 前缀即跳过强制校验；提供 token 时 best-effort 解码填充 req.jwtPayload。
 */
export const UN_JWT: Record<string, string> = {
    // 覆盖 /voiceTrain/task/pipeline 及其子路由（/queue/status、/:taskId）
    // '/voiceTrain/task/pipeline': '/voiceTrain/task/pipeline',
    "/system/cloudVersion":"/system/cloudVersion",
    // 邮件服务：发送/状态接口不需要登录鉴权
    "/mailer":"/mailer"
}