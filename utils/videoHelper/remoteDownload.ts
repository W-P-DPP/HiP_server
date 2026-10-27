// remoteDownload.ts —— 远程媒体安全下载（URL 入参专用）
//
// 为什么不复用 pixabay.ts 的 downloadVideo：那个是素材库内部调用（URL 由 Pixabay API 返回，可信），
// 因此**没有体积上限、没有地址校验、跟随任意重定向**。一旦把 URL 交给外部调用方，这三点都会变成漏洞：
//   ① 无上限 → 一个 10GB 链接就能打满磁盘；
//   ② 无地址校验 → `http://169.254.169.254/latest/meta-data/` 之类的云元数据地址、内网服务可被读取（SSRF）；
//   ③ 自动跟随重定向 → 即使首跳校验通过，302 到内网地址仍会被跟随，校验形同虚设。
// 故这里用原生 fetch + `redirect: 'manual'` **手动逐跳**跟跳，并把每一跳都过一遍地址校验。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { VIDEO_FILE_EXT } from '../constant/video.ts';

/** 字节数 → Mb 文案（错误提示用） */
const formatMb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MB`;

/** IPv4 内网/保留网段判定 */
const isPrivateIpv4 = (ip: string): boolean => {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const a = nums[0];
  const b = nums[1];
  if (a === undefined || b === undefined) return false;

  if (a === 0) return true; // 0.0.0.0/8「本网络」
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // link-local（云元数据 169.254.169.254 在此段）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 组播 + 保留段
  return false;
};

/** IPv6 内网/保留地址判定（含 IPv4-mapped 形式） */
const isPrivateIpv6 = (raw: string): boolean => {
  // 去掉 zone id（fe80::1%eth0）
  const ip = (raw.toLowerCase().split('%')[0] ?? '').trim();

  // IPv4-mapped / IPv4-compatible（::ffff:127.0.0.1）按其内嵌的 IPv4 判定
  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (embedded?.[1]) return isPrivateIpv4(embedded[1]);

  if (ip === '::' || ip === '::1') return true; // 未指定 / 回环
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 unique local
  if (ip.startsWith('ff')) return true; // 组播
  return false;
};

/**
 * 判定 IP 字面量是否属于内网/保留地址（纯函数，便于单测）。
 *
 * 空值一律按「不安全」处理 —— 解析不出地址时宁可拒绝，也不要放行一个未知目标。
 */
export const isPrivateAddress = (ip: string): boolean => {
  const value = (ip ?? '').trim();
  if (!value) return true;
  return value.includes(':') ? isPrivateIpv6(value) : isPrivateIpv4(value);
};

/** 是否为 IP 字面量（IPv4 点分十进制或含冒号的 IPv6），是则无需走 DNS */
const isIpLiteral = (hostname: string): boolean =>
  hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);

/** 通过校验的 URL 及其解析到的地址 */
export interface PublicUrlCheck {
  url: URL;
  /** 实际用于连接的目标地址（IPv4/IPv6 字面量或 DNS 解析结果） */
  address: string;
}

/**
 * 校验 URL 可安全访问：必须是 http/https，且解析后的地址不能落在内网/回环/保留段。
 *
 * 字面量 IP 直接判定；域名则解析 DNS 后**逐条**判定 —— 一个域名可能返回多条 A/AAAA 记录，
 * 攻击者可以故意让其中一条指向内网，只检查第一条会被绕过。
 *
 * 已知边界：不防 DNS rebinding（解析与真正连接之间存在 TOCTOU 窗口），这需要固定解析结果后
 * 直连 IP 才能彻底解决，超出本次范围。
 */
export const assertPublicHttpUrl = async (raw: string): Promise<PublicUrlCheck> => {
  const value = (raw ?? '').trim();
  if (!value) throw new Error('URL 不能为空');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL 格式不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议的 URL');
  }

  // IPv6 字面量在 URL 里带方括号（http://[::1]/），故剥掉再判定
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(`不允许访问内网地址：${hostname}`);
    return { url, address: hostname };
  }

  let records: LookupAddress[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`域名解析失败：${hostname}`);
  }
  if (records.length === 0) throw new Error(`域名解析失败：${hostname}`);

  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`不允许访问内网地址：${hostname} → ${record.address}`);
    }
  }
  return { url, address: records[0]?.address ?? hostname };
};

/** downloadRemoteMedia 选项 */
export interface DownloadRemoteOptions {
  /** 最大允许字节数，超出即中断并清理 */
  maxBytes: number;
  /** 总超时（ms），覆盖全部重定向跳数 */
  timeoutMs: number;
  /** 最大重定向跳数，默认 5 */
  maxRedirects?: number;
  /** 允许的 Content-Type 前缀；不给则不校验类型 */
  allowedMimePrefix?: readonly string[];
}

/** downloadRemoteMedia 结果 */
export interface DownloadRemoteResult {
  bytes: number;
  /** 响应头里的 Content-Type（已去掉 charset 等参数，小写） */
  contentType: string;
  /** 最终生效的地址（跟随重定向之后） */
  finalUrl: string;
}

/**
 * 下载远程媒体到 destAbs。
 *
 * - 逐跳校验地址（见 assertPublicHttpUrl），`redirect: 'manual'` 手动跟跳；
 * - 双重体积防护：先看 Content-Length 提前拒绝，再在流式写入时按实际字节计数兜底
 *   （Content-Length 可缺失也可撒谎，不能只信它）；
 * - 落盘走 `<dest>.part` → rename 的原子替换，失败清掉 .part，绝不留下半个文件冒充成品。
 */
export const downloadRemoteMedia = async (
  rawUrl: string,
  destAbs: string,
  options: DownloadRemoteOptions,
): Promise<DownloadRemoteResult> => {
  const maxRedirects = Math.max(0, options.maxRedirects ?? 5);
  const deadline = Date.now() + options.timeoutMs;

  let current = rawUrl;
  let response: Response | null = null;
  let finalUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const checked = await assertPublicHttpUrl(current);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`下载超时（${options.timeoutMs}ms）`);

    let res: Response;
    try {
      res = await fetch(checked.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(remaining),
        headers: { accept: '*/*' },
      });
    } catch (err) {
      throw new Error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    }

    // 3xx：丢弃响应体，按 Location 解析出下一跳（可能是相对地址），交给下一轮重新校验
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`下载失败：重定向缺少 Location（HTTP ${res.status}）`);
      if (hop === maxRedirects) throw new Error(`下载失败：重定向次数超过 ${maxRedirects} 次`);
      current = new URL(location, checked.url).toString();
      continue;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`下载失败：HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    }

    response = res;
    finalUrl = checked.url.toString();
    break;
  }

  const body = response?.body;
  if (!response || !body) throw new Error('下载失败：响应没有内容');

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const prefixes = options.allowedMimePrefix ?? [];
  if (prefixes.length > 0 && !prefixes.some((prefix) => contentType.startsWith(prefix))) {
    await body.cancel().catch(() => undefined);
    throw new Error(`不支持的文件类型：${contentType || '未知'}`);
  }

  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await body.cancel().catch(() => undefined);
    throw new Error(`文件大小超过上限（${formatMb(options.maxBytes)}）`);
  }

  await fsp.mkdir(path.dirname(destAbs), { recursive: true });
  const partPath = `${destAbs}.part`;
  let bytes = 0;

  try {
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > options.maxBytes) {
          callback(new Error(`文件大小超过上限（${formatMb(options.maxBytes)}）`));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
      counter,
      fs.createWriteStream(partPath),
    );
    await fsp.rename(partPath, destAbs);
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => undefined);
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (bytes === 0) {
    await fsp.rm(destAbs, { force: true }).catch(() => undefined);
    throw new Error('下载的内容为空');
  }

  return { bytes, contentType, finalUrl };
};

/** Content-Type → 扩展名兜底表（URL 路径里取不到扩展名时用） */
const MIME_EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpeg',
  'video/x-flv': '.flv',
};

/**
 * 推断落盘扩展名：优先 URL 路径里的视频扩展名，其次 Content-Type，最后 `.mp4`。
 *
 * 只认 VIDEO_FILE_EXT 里的扩展名 —— URL 常带 `?sign=...` 或被路由成无扩展名，
 * 若把任意后缀（如 `.php`）当扩展名落盘，静态目录下就成了可被解析的文件。
 */
export const guessMediaExt = (urlOrPath: string, contentType: string): string => {
  try {
    const ext = path.extname(new URL(urlOrPath, 'http://placeholder').pathname).toLowerCase();
    if (ext && VIDEO_FILE_EXT.test(ext)) return ext;
  } catch {
    // URL 解析失败就退回按 Content-Type 推断
  }
  return MIME_EXT[contentType] ?? '.mp4';
};
