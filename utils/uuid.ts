// utils/uuid.ts

import { randomUUID, randomBytes } from 'node:crypto'

/**
 * 生成标准 UUID v4（基于 crypto.randomUUID）
 * @param removeHyphens 是否去除连字符，默认 false
 * @example uuid() // '3a6c8f1e-9b2d-4e5f-8a7b-6c5d4e3f2a1b'
 * @example uuid(true) // '3a6c8f1e9b2d4e5f8a7b6c5d4e3f2a1b'
 */
export function uuid(removeHyphens = false): string {
  const id = randomUUID()
  return removeHyphens ? id.replace(/-/g, '') : id
}

/**
 * 生成短唯一 ID（业务主键/订单号常用）
 * 由时间戳 + 加密随机数组成，不可预测
 * @param prefix 可选前缀，如 'order_'
 * @example shortId('order_') // 'order_m1xkz4f2p8q9'
 */
export function shortId(prefix = ''): string {
  const timestamp = Date.now().toString(36)
  const random = randomBytes(6).toString('hex')
  return `${prefix}${timestamp}${random}`
}
