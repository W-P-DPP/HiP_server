import type { Request, Response } from 'express';
import crypto from 'crypto';
import { wxAccountService } from '../../src/wxAccount/wxAccount.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/**
 * GET /hip/wx — 微信服务器签名校验（公开路由，无 JWT）
 *
 * 凭证按 query.userId 从 wxAccounts 集合读取（env 不兜底）：
 * userId → 该用户公众号配置的 token。未配置或缺少 token 直接拒绝，验证通过原样回显 echostr。
 */
export const signature = async (req: Request, res: Response): Promise<void> => {
    const { signature, timestamp, nonce, echostr, userId } = req.query;

    if (typeof userId !== 'string' || !userId) {
        res.sendFail('缺少 userId', HttpStatus.BAD_REQUEST);
        return;
    }

    let token: string;
    try {
        token = await wxAccountService.getSignatureToken(userId);
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '获取公众号 token 失败', HttpStatus.FORBIDDEN);
        return;
    }

    const sortedParams = [token, timestamp, nonce].sort().join('');
    const hash = crypto.createHash('sha1');
    const sha1 = hash.update(sortedParams).digest('hex');
    if (sha1 === signature) {
        // 验证成功，返回 echostr
        res.send(echostr);
    } else {
        // 验证失败
        res.status(HttpStatus.FORBIDDEN).send('Forbidden');
    }
}
