import express, { Router } from "express";
import { signature } from './signature/signature.controller.ts';

/**
 * 微信公众号公开路由（免 JWT）
 *
 * 仅承载微信服务器签名校验回调：GET /hip/wx（微信服务端推送无 JWT，必须公开）。
 * 其余业务接口（material / summary / draft / getToken）见 wx.business.router.ts，挂 JWT。
 */
const router: Router = express.Router();

router.get('/', signature);

export default router;
