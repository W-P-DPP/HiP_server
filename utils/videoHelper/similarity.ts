// similarity.ts — 素材库 keyword 匹配与文件名清洗（纯函数，无外部依赖）

import * as crypto from 'node:crypto';

/**
 * keyword 归一化：trim + lowercase + 去除空白（含全角空格）与 Unicode 标点/符号，
 * 保留字母、数字、CJK。用于素材库匹配时消除大小写/标点/空白差异。
 */
export function normalizeKeyword(kw: string): string {
    return String(kw ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s　\p{P}\p{S}]+/gu, '');
}

/**
 * keyword → 素材文件名安全片段：去标点符号 → 空白合并为 `_` → 去控制字符 →
 * 去首尾 `_` → 截 60 字符；结果为空时回退 md5(keyword)（保证非空、不冲突）。
 */
export function sanitizeKeyword(keyword: string): string {
    const raw = String(keyword ?? '');
    let s = raw
        .trim()
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, '')
        .replace(/[\s　]+/gu, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
    if (!s) {
        s = crypto.createHash('md5').update(raw).digest('hex');
    }
    return s;
}

/** 字符 bigram 集合（len<2 时返回 { 自身 }，避免空集导致相似度失真） */
const bigrams = (s: string): Set<string> => {
    const out = new Set<string>();
    if (s.length < 2) {
        if (s) out.add(s);
        return out;
    }
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
};

/**
 * 相似度得分（0~1）：
 * 1. 任一归一化后为空 → 0
 * 2. 完全相等 → 1（cat vs Cat vs cat!）
 * 3. 包含关系且较长侧长度 ≥4 → 0.9（cat↔cats、city morning↔city）
 * 4. 否则字符 bigram Jaccard：|∩| / |∪|（abc vs abd ≈ 1/3）
 */
export function similarityScore(a: string, b: string): number {
    const na = normalizeKeyword(a);
    const nb = normalizeKeyword(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const longer = na.length >= nb.length ? na : nb;
    const shorter = na.length >= nb.length ? nb : na;
    if (longer.length >= 4 && longer.includes(shorter)) return 0.9;
    const A = bigrams(na);
    const B = bigrams(nb);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter += 1;
    const union = A.size + B.size - inter;
    return union > 0 ? inter / union : 0;
}
