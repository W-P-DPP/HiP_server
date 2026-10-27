// mediaKind.ts — 背景素材媒体类型判定与 ffmpeg 输入参数（纯函数，无外部依赖）

/**
 * 素材媒体类型：
 * - image 静帧图片：ffmpeg image2 解复用器对单帧输入需要 `-loop 1` 才会把它撑满整段时长；
 * - video 动态视频：普通视频用 `-stream_loop -1` 循环输入流。
 * 两者不可互换，原因见 clipInputArgs 注释。
 */
export type ClipMediaKind = 'image' | 'video';

/**
 * 由 MIME 判定素材类型。用户自有素材池里可能存的是 png/jpg/webp 等图片，
 * 视频素材库（Pixabay 下载）则恒为 video/mp4；两者在 ffmpeg 侧走不同的循环参数，
 * 因此解析素材时必须把 MIME 一并带出来（见 materialLibrary 的 ResolvedClip）。
 */
export const clipMediaKind = (mimeType: string): ClipMediaKind =>
    String(mimeType ?? '').toLowerCase().startsWith('image/') ? 'image' : 'video';

/**
 * 素材作为 ffmpeg 输入的参数。两种循环方式不可互换：
 * 对图片（至少 mjpeg/jpg）误用 `-stream_loop -1` 时，解复用器会不停重读但帧时间戳不推进，
 * 输出端 `-t` 永远达不到 → ffmpeg 无限循环卡死；而 runFfmpeg 只等进程 close、没有超时，
 * 背景轨那个「失败回退纯色」的 catch 根本触发不了，整条合成任务会被挂到 taskStaleMs 超时重排。
 * 实测：png 用 -stream_loop -1 能出帧（60 帧/2s），jpg 则会卡死；故统一改为图片走 image2
 * 原生的 `-loop 1`，视频仍走 `-stream_loop -1`。
 */
export const clipInputArgs = (kind: ClipMediaKind, clipPath: string): string[] =>
    kind === 'image' ? ['-loop', '1', '-i', clipPath] : ['-stream_loop', '-1', '-i', clipPath];
