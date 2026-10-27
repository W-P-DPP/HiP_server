import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { responseMiddleware } from './utils/middleware/responseMiddleware.ts';
import { requestContextMiddleware } from './utils/middleware/requestContextMiddleware.ts';
import { bodyParserErrorMiddleware } from './utils/middleware/bodyParserErrorMiddleware.ts';
import { HttpConstants } from './utils/constant/HttpConstants.ts';
import { jwtMiddleware } from './utils/middleware/jwtMiddleware.ts';
import { trainsCallback } from './src/voiceTrain/voiceTrain.controller.ts';
import { downloadFile } from './src/file/file.controller.ts';
import router from './src/index.ts';
import mcp_router from './mcp/index.router.ts';
import wx_router from './wx/wx.router.ts';
import wx_business_router from './wx/wx.business.router.ts';
import { buildOAuthAuthRouter } from './mcp/oauth/index.ts';
import { authRouter } from './src/user/user.router.ts';
import { RequestLogger, ErrorLogger } from './utils/index.ts';
import fileConfig from './src/file/file.config.ts';
import serveIndex from 'serve-index'
import path from 'path'
import fileRouter from '@/file/file.router.ts';
export function createApp() {
  const env = process.env.NODE_ENV
  const prefix= env==='development'?"/dev":""
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: HttpConstants.JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true }));
  app.use(bodyParser.text({ type: 'text/xml' }));
  // body 解析失败（PayloadTooLargeError 等）在此翻成业务 400 信封。
  // 必须紧跟解析器：解析出错时 Express 会跳过其后所有普通中间件（含 responseMiddleware / RequestLogger），
  // 故本中间件不经 res.sendFail 而是自己构造信封；其余错误交回 next，仍由末尾 ErrorLogger 收口。
  app.use(bodyParserErrorMiddleware);
  app.use(RequestLogger.middleware());
  app.use(fileConfig.staticPrefix, express.static(fileConfig.uploadDir));
  app.use(responseMiddleware);
  app.use(requestContextMiddleware);
  // OAuth 2.0 授权服务器（SDK mcpAuthRouter：/authorize /token /register /revoke /.well-known/...）
  // 必须挂在应用根路径；需在 /hip 业务路由与静态兜底之前
  // app.use(buildOAuthAuthRouter());
  const frontendDir = path.resolve(process.cwd(), 'public/front');
  const loginDir = path.resolve(process.cwd(), 'public/login');
  // app.get(`${prefix}/hip`, (req,res)=>{res.send('welcome HiP')});
  app.use(`${prefix}/hip/auth`, authRouter);
  // 讯飞音色训练完成回调：XFYun 服务端推送，公网可达，不要求 JWT。
  // 必须注册在 /hip/api JWT 挂载之前，否则外部推送会被 jwtMiddleware 401 拦截。
  app.all(`${prefix}/hip/api/voiceTrain/trainsCallback`, trainsCallback);
  // 文件下载免 JWT：MCP 客户端走 session(uuid) 鉴权无法携带 JWT，
  // 下载接口在 JWT 挂载之前注册（与 trainsCallback 同策略，Express 先命中更精确的 app.get）。
  // app.get(`${prefix}/hip/api/files/:id/download`, downloadFile);

  app.use(`${prefix}/hip/api/files`,  fileRouter);
  app.use(`${prefix}/hip/api`, jwtMiddleware, router);
  app.use(`${prefix}/hip/mcp`, mcp_router);
  // 微信服务器签名校验回调：必须公开（微信服务端推送无 JWT），先注册，仅匹配 GET /hip/wx
  app.use(`${prefix}/hip/wx`, wx_router);
  // 微信公众号业务接口：需要 JWT 携带用户上下文（material / summary / draft / getToken）
  app.use(`${prefix}/hip/wx`, jwtMiddleware, wx_business_router);
  // 静态资源 + 目录浏览放最后，仅兜底 ${prefix}/hip 下未匹配路由的 GET
  app.use(`${prefix}/hip`, express.static(frontendDir));
  app.use(`${prefix}/hip`, serveIndex(frontendDir, { icons: true }));
  // app.use(`${prefix}/hip/login`, express.static(loginDir));
  // app.use(`${prefix}/hip/login`, serveIndex(loginDir, { icons: true }));
  app.use(ErrorLogger.middleware());
  return app;
}
