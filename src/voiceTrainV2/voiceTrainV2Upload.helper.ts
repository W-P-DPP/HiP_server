import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 文件名中需要剔除的字符：路径分隔符 + Windows 保留字符 */
const UNSAFE_NAME_CHARS = '\\/:*?"<>|';

/**
 * 清洗文件名：去掉控制字符与路径/保留字符，避免下载时被当作路径解析。
 * 用字符遍历而非正则，一是不必为转义序列费神，二是「哪些字符不安全」在这里一眼可读。
 */
export function sanitizeFileName(name: string, fallback = 'voice'): string {
  const cleaned = Array.from(name ?? '')
    .filter(ch => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return false;
      return !UNSAFE_NAME_CHARS.includes(ch);
    })
    .join('')
    .trim();
  return cleaned.slice(0, 60) || fallback;
}

/**
 * 把磁盘上**已存在**的文件包装成 Express.Multer.File，以便复用 fileService.upload
 * 的元数据落库逻辑（md5 / storedName / 相对 uploadDir 路径推导），而不是重写一遍。
 *
 * 注意：absolutePath 必须已经位于 FILE_UPLOAD_DIR 之内，否则 fileService 推导出的
 * 相对路径会带 `../`，下载与静态访问都会失效。
 *
 * 刻意不构造 `stream`/`buffer`：fileService.upload 只读 path / originalname / size /
 * mimeType，而 `fs.createReadStream()` 在构造时就打开文件描述符，没人消费就等于每次调用
 * 泄漏一个 fd（实测 20 次调用 fd 从 21 涨到 41），长跑进程最终会耗尽 fd 让所有文件操作失败。
 * 下方断言把它收敛到「只满足 fileService 实际读取的字段」。
 */
export function buildMulterFile(
  absolutePath: string,
  originalName: string,
  mimeType: string,
): Express.Multer.File {
  const stat = fs.statSync(absolutePath);
  return {
    fieldname: 'file',
    originalname: originalName,
    encoding: '7bit',
    mimetype: mimeType,
    size: stat.size,
    destination: path.dirname(absolutePath),
    filename: path.basename(absolutePath),
    path: absolutePath,
  } as Express.Multer.File;
}

/**
 * 在 FILE_UPLOAD_DIR 下按 multer 同款日期子目录约定新建一个空文件位，返回其绝对路径。
 * 与 utils/middleware/uploadMiddleware.ts 的 `YYYY/MM/DD/<uuid><ext>` 布局保持一致，
 * 使 fileService 的相对路径推导、静态目录访问都无需特殊处理。
 */
export function nextUploadPath(uploadDir: string, ext: string): string {
  const now = new Date();
  const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const dir = path.join(uploadDir, subDir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${crypto.randomUUID()}${ext}`);
}

/** 删除磁盘文件；失败只记不抛（调用方通常在错误清理路径上） */
export function removeFileQuietly(absolutePath: string, onError?: (message: string) => void): void {
  try {
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
  }
}
