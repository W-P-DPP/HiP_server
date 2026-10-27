import dayjs from 'dayjs';

/**
 * 距下一个自然日 00:00:00 的剩余秒数，用于「每天 0 点过期」的缓存 TTL。
 *
 * 说明：启动时 env.ts 已设 TZ=Asia/Shanghai，dayjs 按本地（东八区）0 点计算，
 * 返回秒数与当前时刻相关（凌晨刚过约 86400，临近午夜约 1），而非固定 86400。
 *
 * @param now 计算基准时间，默认当前时刻
 */
export const getSecondsToNextMidnight = (now: Date = new Date()): number => {
  const d = dayjs(now);
  // 当天最后一刻 23:59:59.999 距 now 的整秒差 +1，保证过 0 点后才过期
  return d.endOf('day').diff(d, 'second') + 1;
};
