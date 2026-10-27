// 冒烟测试：NODE_ENV=development npx tsx mcp/oauth/smoke.ts
// 需本机 Mongo 可用（开发环境默认已连接）。自动跑 OAuth 全流程：
// register → authorize → token → 访问 /hip/mcp → revoke → 验证吊销后 401
import { createHash } from 'node:crypto';
import '../../utils/env.ts';
import request from 'supertest';
import { createApp } from '../../app.ts';
import MongoDBService from '../../utils/MongoDB.ts';

const REDIRECT_URI = 'workbuddy://workbuddy/mcp/custom-mcp%3Ayy-workflow/oauth/callback';

const run = async () => {
  const mongo = MongoDBService.getInstance();
  await mongo.connect();

  const app = createApp();
  const client = request(app);

  // 0. 元数据发现
  const metaRes = await client.get('/.well-known/oauth-authorization-server');
  console.log('metadata:', metaRes.status, 'issuer=', metaRes.body?.issuer);

  // 1. 动态客户端注册（原 404 → 现在应 201）
  const regRes = await client.post('/register').send({
    redirect_uris: [REDIRECT_URI],
    client_name: 'WorkBuddy Connector (smoke)',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  console.log('register:', regRes.status, 'client_id=', regRes.body?.client_id);
  const clientId = regRes.body?.client_id as string;

  // 2. authorize（自动放行，应 302 带 code）
  const codeVerifier = 'smoke-code-verifier-abcdefghijklmnopqrstuvwxyz1234567890';
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const authRes = await client.get('/authorize').query({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: 'smoke-state',
  });
  const location = authRes.headers.location as string;
  const code = location ? new URL(location).searchParams.get('code') : null;
  console.log('authorize:', authRes.status, 'code=', code ? `${code.slice(0, 8)}...` : null);

  // 3. 授权码换 token（应 200）
  const tokenRes = await client.post('/token').type('form').send({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
  });
  const accessToken = tokenRes.body?.access_token as string | undefined;
  console.log('token:', tokenRes.status, 'has_access_token=', !!accessToken, 'expires_in=', tokenRes.body?.expires_in);

  // 4. 无 token 访问 MCP → 应 401 + WWW-Authenticate
  const noAuthRes = await client.post('/hip/mcp').send({});
  console.log('mcp 无 token:', noAuthRes.status, 'WWW-Authenticate=', noAuthRes.headers['www-authenticate']);

  // 5. 带 Bearer 访问 MCP → 不应 401（通过鉴权；body 为 MCP JSON-RPC 层响应）
  const authedRes = await client
    .post('/hip/mcp')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } } });
  console.log('mcp 带 token:', authedRes.status, authedRes.status !== 401 ? '(鉴权通过)' : '(仍 401!)');

  // 6. 吊销 token
  const revokeRes = await client.post('/revoke').type('form').send({
    token: accessToken,
    client_id: clientId,
    token_type_hint: 'access_token',
  });
  console.log('revoke:', revokeRes.status);

  // 7. 吊销后访问 → 应 401
  const revokedRes = await client.post('/hip/mcp').set('Authorization', `Bearer ${accessToken}`).send({});
  console.log('mcp 吊销后:', revokedRes.status, revokedRes.status === 401 ? '(已拒绝)' : '(未拒绝!)');

  await mongo.disconnect();
};

run().catch(err => {
  console.error(err);
  process.exit(1);
});
