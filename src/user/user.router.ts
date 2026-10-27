import { Router } from 'express';
import {
  register,
  login,
  logout,
  getProfile,
  updateUser,
  deleteUser,
  createChildUser,
  listChildUsers,
  getUserStatistics,
} from './user.controller.ts';
import { decryptPasswordMiddleware } from '../../utils/middleware/decryptPasswordMiddleware.ts';

/**
 * 用户模块路由
 *
 * - authRouter：公开路由（注册/登录），挂载于 /hip/auth，无需 JWT
 * - router：受保护路由（个人资料），挂载于 /hip/api/users，经过 jwtMiddleware
 *
 * 凡接收前端加密 password 的路由（注册/登录/建子用户/改用户）统一先过 decryptPasswordMiddleware，
 * 把 base64 密文换成明文后 controller 才拿得到 dto.password。
 */
const router = Router();
const authRouter = Router();

// ---- 公开：认证 ----
/** POST /hip/auth/register */
authRouter.post('/register', decryptPasswordMiddleware, register);
/** POST /hip/auth/login */
authRouter.post('/login', decryptPasswordMiddleware, login);

// ---- 受保护：用户 ----
/** POST /hip/api/users/logout */
router.post('/logout', logout);
/** GET /hip/api/users/profile */
router.get('/profile', getProfile);
/** POST /hip/api/users/children — 当前 admin/sadmin 创建子用户（parentId=操作者本人） */
router.post('/children', decryptPasswordMiddleware, createChildUser);
/** GET /hip/api/users/children — 当前 admin/sadmin 的完整后代树（data.list=[以操作者为根的递归树]） */
router.get('/children', listChildUsers);
/** GET /hip/api/users/stats — 用户数据统计（仅 admin/sadmin：总数 / 今日新增 / 角色分布 / 近半个月每日新增） */
router.get('/stats', getUserStatistics);
/** PUT /hip/api/users/:id — 更新用户（password 可选，非空时前端必定加密） */
router.put('/:id', decryptPasswordMiddleware, updateUser);
/** DELETE /hip/api/users/:id — 删除用户 */
router.delete('/:id', deleteUser);

export default router;
export { authRouter };
