// sceneDetect.ts —— PySceneDetect 场景切分：视频 → 场景时间段
//
// 恒走独立部署的 scenedetect HTTP 容器（utils/scenedetect/ScenedetectHttpClient.ts），
// 结果经 utils/scenedetect/normalize.ts 收敛成 SceneDetect.Result，调用方无感。
import fs from 'node:fs'
import path from 'node:path'
import { getScenedetectClient } from '../scenedetect/ScenedetectHttpClient.ts'
import type { SceneDetect } from '../../type/index.d.ts'

/**
 * 用 PySceneDetect 做场景切分，返回无缝覆盖整段视频的场景时间段（毫秒）。
 *
 * 调用独立容器；未配置 SCENEDETECT_BASE_URL 或服务不可达时抛错（信息含可操作提示）。
 */
export const detectScenes = async (
    videoAbs: string,
    options: SceneDetect.DetectOptions = {},
): Promise<SceneDetect.Result> => {
    const input = path.resolve(videoAbs)
    // 入参存在性校验放在最前：先给出确定的报错，避免把必然失败的请求发到远端
    if (!fs.existsSync(input)) throw new Error(`场景检测输入视频不存在：${input}`)

    return getScenedetectClient().detect(input, options)
}
