import AxiosService from '../../Axios.ts';
import RedisService from '../../Redis.ts';
import { Logger } from '../../Logger.ts';
import { cmdc } from '../../constant/AIPlatform.ts';
import { CacheConstants } from '../../constant/CacheConstants.ts';
import type { AIPlatform } from '../../../type/index.d.ts';

/** cmdc /models 原始条目（OpenAI 兼容，内部形态，不对外） */
interface CmdcModelRaw {
  id: string;
  name?: string;
  context_length?: number;
}

/** cmdc /models 原始响应（内部形态） */
interface CmdcModelListResponse {
  object: string;
  data?: CmdcModelRaw[];
}

const axiosService = AxiosService.getInstance();
const redis = RedisService.getInstance();
const logger = Logger.getInstance();

/**
 * 拉取 cmdc 平台支持的模型列表（GET {baseurl}/models，公开接口，无需鉴权）。
 * 优先读 Redis 缓存（TTL 1 天），未命中再请求云端并回写缓存；
 * 缓存读写失败不影响主流程（Redis 不可用时降级直连云端）。
 * 返回简化字段：id / name / contextLength（缺省 name 回退 id，缺省 contextLength 记 0）。
 */
export async function listModels(): Promise<AIPlatform.Model[]> {
  try {
    const cached = await redis.getJSON<AIPlatform.Model[]>(CacheConstants.CMDC_MODEL_LIST_KEY);
    if (cached && cached.length > 0) return cached;
  } catch (err) {
    logger.warn(`[cmdc] 读取模型列表缓存失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const data = await axiosService.get<CmdcModelListResponse>(`${cmdc.baseurl}/models`, {
    timeout: 10_000,
  });
  const models: AIPlatform.Model[] = (data?.data ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.context_length ?? 0,
  }));

  try {
    await redis.setJSON(CacheConstants.CMDC_MODEL_LIST_KEY, models, CacheConstants.CMDC_MODEL_LIST_TTL);
  } catch (err) {
    logger.warn(`[cmdc] 写入模型列表缓存失败：${err instanceof Error ? err.message : String(err)}`);
  }

  return models;
}
