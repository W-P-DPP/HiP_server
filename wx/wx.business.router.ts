import express, { Router } from "express";
import { getToken } from '../utils/wx/getToken.ts';
import wxMaterialRouter from './material/wxMaterial.router.ts';
import summaryRouter from './summary/summary.router.ts';
import wxDraftRouter from './draft/wxDraft.router.ts';
import { HttpStatus } from '../utils/constant/HttpStatus.ts';

/**
 * 微信公众号业务路由（需 JWT，携带用户上下文）
 *
 * 凭证按 req.jwtPayload.id 从 DB 配置读取（wxAccounts 集合），env 不兜底。
 * 在 app.ts 中挂载为：app.use(`${prefix}/hip/wx`, jwtMiddleware, wxBusinessRouter)
 */
const router: Router = express.Router();

// GET /hip/wx/getToken — 诊断：返回当前用户的默认公众号 access_token
router.get('/getToken', async (req, res) => {
    const userId = req.jwtPayload?.id as string | undefined;
    if (!userId) {
        res.sendFail('未登录或缺少用户身份', HttpStatus.UNAUTHORIZED);
        return;
    }
    try {
        const token = await getToken(userId)
        res.sendSuccess(token)
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '获取 token 失败', HttpStatus.ERROR)
    }
});

// POST /hip/wx/material — 新增永久素材（multipart：file + type + title/introduction）
router.use('/material', wxMaterialRouter);
// GET /hip/wx/summary/getSummary — 发表内容统计
router.use('/summary', summaryRouter);
// POST /hip/wx/draft/publish — Markdown 发布为公众号草稿（JSON）
router.use('/draft', wxDraftRouter);

export default router;
