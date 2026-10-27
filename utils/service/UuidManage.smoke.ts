// 冒烟测试：NODE_ENV=development npx tsx utils/service/UuidManage.smoke.ts
// 需本机 Mongo 可用（开发环境默认已连接）
import '../env.ts';
import MongoDBService from '../MongoDB.ts';
import { uuidManageService } from './UuidManageService.ts';
import { uuid } from '../uuid.ts';

const run = async () => {
  const mongo = MongoDBService.getInstance();
  await mongo.connect();

  const userId = 'smoke-user-1';

  // 默认 ttl（1 天）
  const id = await uuidManageService.issue(userId, 'smoke-test');
  console.log('issued:', id);
  console.log('status(before):', await uuidManageService.status(id));

  console.log('consume #1:', await uuidManageService.consume(userId, id));
  console.log('consume #2 (应 not_active):', await uuidManageService.consume(userId, id));

  // 永不过期
  const neverId = await uuidManageService.issue(userId, 'smoke-test', undefined, '*');
  const neverStatus = await uuidManageService.status(neverId);
  console.log('issued(never):', neverId, 'expireAt:', neverStatus?.expireAt);

  // 吊销
  const revokeId = await uuidManageService.issue(userId, 'smoke-test', undefined, 600);
  console.log('revoke:', await uuidManageService.revoke(userId, revokeId));
  console.log('status(revoked):', await uuidManageService.status(revokeId));

  // 不存在
  console.log('status(不存在):', await uuidManageService.status(uuid(false)));

  // 分页
  const page = await uuidManageService.listByUser(userId, { page: 1, limit: 10 });
  console.log('listByUser:', JSON.stringify({ total: page.total, count: page.list.length }));

  await mongo.disconnect();
};

run().catch(err => {
  console.error(err);
  process.exit(1);
});
