/**
 * 讯飞音色训练完成回调 → 可落库数据 归一化（纯函数，可单测）。
 *
 * 回调 payload 格式官方未明示，防御性解析，兼容形态：
 *   - 直接对象 { taskId, trainStatus, ... }
 *   - { code, desc, data: { ... } } 包装（与 /result 接口同构）
 *   - { data: { data: { ... } } } 双重包装
 *   - GET 查询参数（query 兜底）
 *   - JSON 字符串 body
 *
 * 约束：
 *   - 输出不含 undefined 键（Mongoose $set: {a: undefined} 会抹除字段）
 *   - 输出不含 userId：归属用户在创建任务时落库，回调不得覆盖
 *   - 空字符串字符串字段保留（用于清空旧值），undefined/null 丢弃
 *   - 数值字段接受 number 或数字字符串
 */

export interface TrainCallbackData {
    /** 讯飞训练任务 id（upsert 唯一键） */
    taskId: string;
    taskName?: string;
    resourceName?: string;
    trainVid?: string;
    trainVcn?: string;
    assetId?: string;
    trainId?: string;
    appId?: string;
    failedDesc?: string;
    sex?: number;
    trainStatus?: number;
    ageGroup?: number;
}

/** 字符串字段（映射 XunfeiTrainResultDto + 回调新增 trainVcn） */
const STRING_FIELDS = ['taskName', 'resourceName', 'trainVid', 'trainVcn', 'assetId', 'trainId', 'appId', 'failedDesc'] as const;
/** 数值字段（映射 XunfeiTrainResultDto） */
const NUMBER_FIELDS = ['sex', 'trainStatus', 'ageGroup'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 依次从各来源取第一个非空字符串值（number 转字符串兜底） */
function pickString(sources: Array<Record<string, unknown>>, key: string): string | undefined {
    for (const src of sources) {
        const v = src[key];
        if (v === undefined || v === null) continue;
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
    }
    return undefined;
}

/** 依次从各来源取第一个非空数值（number 或数字字符串） */
function pickNumber(sources: Array<Record<string, unknown>>, key: string): number | undefined {
    for (const src of sources) {
        const v = src[key];
        if (v === undefined || v === null) continue;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
    }
    return undefined;
}

/**
 * 归一化回调 payload → TrainCallbackData。
 * 解析不出 taskId 返回 null（控制器据此忽略推送）；字段按
 * [direct, nested, nested2, query] 顺序取第一个非空值（body 优先于 query）。
 */
export function normalizeTrainCallback(input: { body: unknown; query?: Record<string, unknown> }): TrainCallbackData | null {
    let root: unknown = input.body;
    if (typeof root === 'string') {
        const t = root.trim();
        if (t === '') {
            root = undefined;
        } else {
            try {
                root = JSON.parse(t);
            } catch {
                root = undefined;
            }
        }
    }

    const direct: Record<string, unknown> = isPlainObject(root) ? root : {};
    const nested: Record<string, unknown> = isPlainObject(direct.data) ? direct.data : {};
    const nested2: Record<string, unknown> = isPlainObject(nested.data) ? nested.data : {};
    const query: Record<string, unknown> = isPlainObject(input.query) ? input.query : {};
    const sources = [direct, nested, nested2, query];

    const taskId = pickString(sources, 'taskId');
    if (!taskId || taskId.trim() === '') return null;

    const out: Record<string, unknown> = { taskId: taskId.trim() };
    for (const key of STRING_FIELDS) {
        const v = pickString(sources, key);
        if (v !== undefined) out[key] = v;
    }
    for (const key of NUMBER_FIELDS) {
        const v = pickNumber(sources, key);
        if (v !== undefined) out[key] = v;
    }
    return out as TrainCallbackData;
}
