import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import heygemConfig from './heygem.config.ts';
import {
  HEYGEM_RESULT_SUBDIR,
  HEYGEM_TASKS_SUBDIR,
  HEYGEM_TEMP_SUBDIR,
  MIN_RESULT_MP4_BYTES,
} from '../constant/digitalHuman.ts';

/** 删除文件；失败只记不抛（调用方通常在错误清理路径上） */
function unlinkQuietly(absPath: string): void {
  try {
    fs.rmSync(absPath, { force: true });
  } catch {
    // 清理失败无妨，下一次任务会覆盖同名文件
  }
}

/** 建立挂载目录骨架（tasks/ temp/ result/），保证 duix 需要的目录存在 */
export function ensureMountLayout(): string {
  for (const sub of [HEYGEM_TASKS_SUBDIR, HEYGEM_TEMP_SUBDIR, HEYGEM_RESULT_SUBDIR]) {
    fs.mkdirSync(path.join(heygemConfig.mountDir, sub), { recursive: true });
  }
  return heygemConfig.mountDir;
}

/** 挂载目录是否可写（engine/status 用；不可写则任何任务都会失败） */
export function isMountWritable(): boolean {
  try {
    fs.mkdirSync(heygemConfig.mountDir, { recursive: true });
    fs.accessSync(heygemConfig.mountDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Node 侧路径 → duix 容器内路径。
 *
 * 两者靠「同一宿主机目录分别挂到两侧」对齐，所以只需把挂载目录前缀替换成容器前缀。
 * 不在挂载目录内时直接抛错 —— 否则 duix 读不到文件，只会给出「任务不存在 / 获取音频时长失败」
 * 这类难以定位的报错。
 */
export function toContainerPath(hostPath: string): string {
  const mount = heygemConfig.mountDir;
  const resolved = path.resolve(hostPath);
  const rel = path.relative(mount, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`素材必须位于 HeyGem 挂载目录内：${mount}（当前 ${resolved}）`);
  }
  return `${heygemConfig.containerPrefix}/${rel.split(path.sep).join('/')}`;
}

/** 把素材拷进挂载目录，返回 (宿主路径, 容器路径)，供提交时上行容器路径 */
export function stageFile(
  srcAbs: string,
  subdir: string,
  name: string,
): { hostPath: string; containerPath: string } {
  const dir = path.join(heygemConfig.mountDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  fs.copyFileSync(srcAbs, dest);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
    throw new Error(`HeyGem 素材写入失败：${dest}`);
  }
  return { hostPath: dest, containerPath: toContainerPath(dest) };
}

/** 任务素材子目录（相对挂载根），形如 tasks/<code> */
export function taskSubdir(code: string): string {
  return `${HEYGEM_TASKS_SUBDIR}/${code}`;
}

/** duix 可能落盘的候选产物路径（不同版本/配置下位置略有差异） */
export function candidateResultPaths(code: string): string[] {
  const mount = heygemConfig.mountDir;
  return [
    path.join(mount, HEYGEM_TEMP_SUBDIR, `${code}-r.mp4`),
    path.join(mount, HEYGEM_TEMP_SUBDIR, `${code}.mp4`),
    path.join(mount, HEYGEM_RESULT_SUBDIR, `${code}-r.mp4`),
    path.join(mount, HEYGEM_RESULT_SUBDIR, `${code}.mp4`),
    path.join(mount, HEYGEM_TASKS_SUBDIR, code, 'result.mp4'),
  ];
}

/**
 * 把 duix 返回的 result 字段解析为宿主侧真实路径。
 *
 * 兼容三类形态：容器内绝对路径（`/code/data/...`）、宿主绝对路径、以及形如
 * `/{code}-r.mp4` 的“看似绝对实则相对 temp/result” 的返回（duix 的怪癖）。
 */
export function resolveResultHostPath(raw: string): string | null {
  const mount = heygemConfig.mountDir;
  const prefix = heygemConfig.containerPrefix;
  const value = (raw || '').trim();
  if (!value) return null;

  if (value.startsWith(prefix)) {
    const rel = value.slice(prefix.length).replace(/^[\\/]+/, '');
    if (!rel) return null;
    return path.join(mount, ...rel.split('/'));
  }
  if (path.isAbsolute(value) && fs.existsSync(value)) return value;

  const name = value.replace(/^[\\/]+/, '');
  for (const candidate of [
    path.join(mount, name),
    path.join(mount, HEYGEM_TEMP_SUBDIR, name),
    path.join(mount, HEYGEM_RESULT_SUBDIR, name),
    path.join(mount, HEYGEM_TEMP_SUBDIR, path.basename(name)),
    path.join(mount, HEYGEM_RESULT_SUBDIR, path.basename(name)),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 判断 mp4 是否已写完。
 *
 * duix 的 ffmpeg 落盘期间文件就已存在，直接取会拿到播不了的半成品。判据是
 * ① 体积达标 ② 头部或尾部存在 moov 原子 ③ 短等待后体积不再变化。
 */
export async function mp4LooksComplete(
  absPath: string,
  minSize: number = MIN_RESULT_MP4_BYTES,
): Promise<boolean> {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return false;
    const size = stat.size;
    if (size < minSize) return false;

    const fd = fs.openSync(absPath, 'r');
    try {
      const headLen = Math.min(size, 2_048_000);
      const head = Buffer.alloc(headLen);
      fs.readSync(fd, head, 0, headLen, 0);
      let tail = Buffer.alloc(0);
      if (size > 2_048_000) {
        const tailLen = Math.min(size, 2_048_000);
        tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      }
      if (!Buffer.concat([head, tail]).includes('moov')) return false;
    } finally {
      fs.closeSync(fd);
    }

    await sleep(800);
    return fs.statSync(absPath).size === size;
  } catch {
    return false;
  }
}

/** 把已写完的 mp4 拷到目标路径（先写 .partial 再 rename，避免暴露半成品） */
export async function copyCompleteResult(src: string, destAbs: string): Promise<string | null> {
  if (!(await mp4LooksComplete(src))) return null;
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.partial`;
  try {
    fs.copyFileSync(src, tmp);
    if (!(await mp4LooksComplete(tmp, 50_000))) {
      unlinkQuietly(tmp);
      return null;
    }
    fs.renameSync(tmp, destAbs);
    return destAbs;
  } catch {
    unlinkQuietly(tmp);
    return null;
  }
}

/** 遍历候选路径，收集第一个完整的产物；都没有则返回 null */
export async function collectResult(code: string, destAbs: string): Promise<string | null> {
  for (const candidate of candidateResultPaths(code)) {
    const collected = await copyCompleteResult(candidate, destAbs);
    if (collected) return collected;
  }
  return null;
}

/** 清理任务素材目录（任务结束后 best-effort） */
export function removeTaskDir(code: string): void {
  try {
    fs.rmSync(path.join(heygemConfig.mountDir, HEYGEM_TASKS_SUBDIR, code), {
      recursive: true,
      force: true,
    });
  } catch {
    // 清理失败无妨，下次任务用新的 code 目录
  }
}
