// utils/constant/envParse.ts
/**
 * 环境变量解析辅助。
 *
 * 环境变量的唯一读取点是 utils/constant/** 下的常量文件，本模块集中提供「读 + 默认值 + 解析」
 * 的统一口径（与各 *.config.ts 原先各自维护的 envInt/envBool 同语义），避免每加一个域就复制一份。
 *
 * 入参一律是 **环境变量名（key）** 而非值 —— 因为调用方（常量文件）自身就是读取点。
 */
import path from 'node:path';

/** 读字符串；未设置或全空白时回退默认值 */
export function envStr(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

/** 读整数；非法值/缺省回退默认值（?x=abc 类输入不应让配置变成 NaN） */
export function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 读浮点数；非法值/缺省回退默认值（阈值类参数需要小数，故不能复用 envInt） */
export function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 读布尔；仅显式 'true'/'1' 为真（其余一律按 fallback 处理） */
export function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** 读列表（默认逗号分隔）；去空白、去空项，缺省或全空返回空数组 */
export function envList(key: string, separator = ','): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(separator).map((s) => s.trim()).filter(Boolean);
}

/** 相对路径按 Node 的 cwd 绝对化（dev 从仓库根跑，prod WORKDIR=/app，均稳定） */
export function resolveFromCwd(raw: string): string {
  return path.resolve(process.cwd(), raw);
}

/** 去掉末尾斜杠（用于 URL 基址拼接） */
export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** 把比例类参数夹到 [0,1]：超范围的值会让下游行为不可预期 */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
