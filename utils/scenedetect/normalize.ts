// utils/scenedetect/normalize.ts
/**
 * 场景检测结果的纯归一化逻辑（无 IO、无环境依赖）。
 *
 * local（脚本 stdout）与 remote（HTTP 响应体）两条路径共用同一套收敛规则，
 * 从而保证对上层（aiDetectDispatcher）暴露的 `SceneDetect.Result` 契约完全一致：
 *   - sceneCount 恒等于 scenes.length（不透传上报值）
 *   - 每个 scene 的 durationMs 恒由区间推导（startMs 夹到 >=0，endMs 夹到 >= startMs）
 *   - detector 一律经归一化（未知值回退 content）
 *   - ok !== true 时抛出 `场景检测失败：<error>`
 */
import type { SceneDetect } from '../../type/index.d.ts';

/** 支持的检测算法；必须与 services/scenedetect/detect_scenes.py 的 DETECTORS 一致 */
export const DETECTORS: readonly string[] = ['content', 'adaptive', 'threshold'];

/** 数字 → 有限数，否则回退；用于把脚本/服务返回的松散 JSON 收敛成确定的数值 */
export const toNumber = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
};

/** 检测算法：非法值静默回退 content（拼错不该让整个检测失败） */
export const resolveDetector = (override?: string): SceneDetect.Detector => {
    const raw = (override ?? '').trim().toLowerCase();
    return DETECTORS.includes(raw) ? (raw as SceneDetect.Detector) : 'content';
};

/**
 * 单个场景：夹紧时间区间，保证 start <= end 且非负。
 * durationMs 不从上报值透传，而是由区间推导 —— 它与 startMs/endMs 冗余，
 * 一旦上报（或人为改动）给出三者不自洽的值，推导能始终维持 durationMs = endMs - startMs。
 */
export const normalizeScene = (raw: unknown, position: number): SceneDetect.Scene => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const startMs = Math.max(0, Math.round(toNumber(item.startMs, 0)));
    const endMs = Math.max(startMs, Math.round(toNumber(item.endMs, startMs)));
    return {
        index: Math.max(1, Math.round(toNumber(item.index, position + 1))),
        startMs,
        endMs,
        durationMs: endMs - startMs,
    };
};

/**
 * 把一次检测的 payload（脚本 stdout 或 HTTP 响应体解析后的对象）收敛成 `SceneDetect.Result`。
 * ok !== true 时抛出脚本/服务给出的 error 文案。
 */
export const normalizeDetectPayload = (parsed: unknown): SceneDetect.Result => {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('场景检测未返回可解析的 JSON：(空输出)');
    }

    const payload = parsed as Record<string, unknown>;
    if (payload.ok !== true) {
        const detail = typeof payload.error === 'string' && payload.error ? payload.error : '未知错误';
        throw new Error(`场景检测失败：${detail}`);
    }

    const scenes = Array.isArray(payload.scenes) ? payload.scenes.map(normalizeScene) : [];
    return {
        version: typeof payload.version === 'string' ? payload.version : 'unknown',
        detector: resolveDetector(typeof payload.detector === 'string' ? payload.detector : undefined),
        threshold: toNumber(payload.threshold, 0),
        minSceneLenSec: toNumber(payload.minSceneLenSec, 0),
        frameRate: toNumber(payload.frameRate, 0),
        durationMs: Math.max(0, Math.round(toNumber(payload.durationMs, 0))),
        sceneCount: scenes.length,
        scenes,
    };
};
