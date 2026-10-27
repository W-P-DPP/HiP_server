// pixabay.ts
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import axios from 'axios'
import AxiosService from '../Axios.ts'
import { MaterialConstants } from '../constant/MaterialConstants.ts'

interface PixabayVideoFile {
    url?: string;
}

interface PixabayHit {
    videos?: {
        large?: PixabayVideoFile;
        medium?: PixabayVideoFile;
    };
}

const axiosService = AxiosService.getInstance();

/**
 * 搜索 Pixabay 视频素材，返回素材直接下载 URL（优先 large，缺省回退 medium）。
 * 无 key / 无命中 / 异常 → null（上层回退纯色背景，不抛错）。
 */
export async function searchVideo(query: string): Promise<string | null> {
    const key = MaterialConstants.PIXABAY_API_KEY.trim();
    if (!key) return null;
    try {
        const data = await axiosService.get<{ hits?: PixabayHit[] }>('https://pixabay.com/api/videos/', {
            params: {
                key,
                q: query,
                per_page: 3,
                min_width: 1280,
                min_height: 720,
                orientation: 'horizontal',
                video_type: 'film',
                safesearch: true,
            },
            timeout: 15_000,
        });
        for (const hit of data?.hits ?? []) {
            const url = hit?.videos?.large?.url || hit?.videos?.medium?.url;
            if (url) return url;
        }
        return null;
    } catch (err) {
        return null;
    }
}

/**
 * 流式下载素材视频到本地文件。
 * 直接走原生 axios（不走 AxiosService 单例）：其响应拦截器会对 response.data 做
 * JSON.stringify，流对象含循环引用会抛 "Converting circular structure to JSON"。
 * 覆盖单例默认 5s 超时（Pixabay large 5-30MB），失败抛错由调用方兜底。
 */
export async function downloadVideo(url: string, destAbs: string): Promise<void> {
    const response = await axios.get<Readable>(url, {
        responseType: 'stream',
        timeout: 60_000,
    });
    await pipeline(response.data, fs.createWriteStream(destAbs));
}

