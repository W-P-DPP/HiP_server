import crypto from 'node:crypto';

/** 大模型版 Ifasr_llm getResult 的 resultType 参数（默认 transfer,predict） */
export const RAASR_RESULT_TYPE = 'transfer'; // predict

/** 生成随机串（大模型版鉴权参数 signatureRandom，上传时生成、getResult 原样复用）——与 raast.ts 私有实现一致 */
export const signatureRandomString = (length = 16): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) result += chars[bytes[i]! % chars.length];
    return result;
};

/** 毫秒 → SRT 时间戳 HH:MM:SS,mmm */
const formatSrtTime = (ms: number): string => {
    const totalMs = Math.max(0, Math.round(ms));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
};

/** 解析 orderResult（JSON 字符串）→ 转写文本：lattice[].json_1best → st.rt[].ws[].cw[0].w 逐词拼接；lattice 缺失/空时回退 lattice2 */
export const parseRaasrText = (orderResult: string): string => {
    const data = JSON.parse(orderResult);
    const lattice = Array.isArray(data?.lattice) && data.lattice.length ? data.lattice : data?.lattice2;
    if (!Array.isArray(lattice)) return '';
    const words: string[] = [];
    for (const item of lattice) {
        if (!item?.json_1best) continue;
        const best = JSON.parse(item.json_1best);
        for (const rt of best?.st?.rt ?? []) {
            for (const ws of rt?.ws ?? []) {
                const cw = ws?.cw?.[0];
                if (cw?.w) words.push(cw.w);
            }
        }
    }
    return words.join('');
};

/** 解析 orderResult（JSON 字符串）→ SRT 字幕：扁平化所有词（跨 lattice 保持顺序），以 cw[0].wp='p' 标点词为分段依据，词级绝对时间 st.bg+wb/we 定时间段；lattice 缺失/空时回退 lattice2 */
export const parseRaasrSrt = (orderResult: string): string => {
    let data: any;
    try {
        data = JSON.parse(orderResult);
    } catch {
        return '';
    }
    const lattice = Array.isArray(data?.lattice) && data.lattice.length ? data.lattice : data?.lattice2;
    if (!Array.isArray(lattice)) return '';

    // 扁平化词级条目（保持原始顺序）。时间戳 = st.bg + ws.wb/we × 10：
    // lattice 级 bg/ed 是毫秒，但词级 wb/we 是厘秒（1/100s），必须 ×10 才是毫秒，
    // 否则 19s 的 lattice 会被压缩到前 1.9s，字幕与音频不同步。
    const words: { w: string; wp: string; start: number; end: number }[] = [];
    for (const item of lattice) {
        if (!item?.json_1best) continue;
        let best: any;
        try {
            best = JSON.parse(item.json_1best);
        } catch {
            continue; // 单句解析失败跳过，不拖垮整条字幕
        }
        const st = best?.st;
        if (!st) continue;
        const bg = Number(st.bg) || 0;
        for (const rt of st?.rt ?? []) {
            for (const ws of rt?.ws ?? []) {
                const cw = ws?.cw?.[0];
                const w = cw?.w;
                if (!w) continue;
                const start = bg + (Number(ws.wb) || 0) * 10;
                const end = bg + (Number(ws.we) || Number(ws.wb) || 0) * 10;
                words.push({ w, wp: cw.wp ?? '', start, end });
            }
        }
    }

    const blocks: string[] = [];
    let seg: { w: string[]; start: number; end: number } | null = null;
    const flush = (): void => {
        if (!seg) return;
        const text = seg.w.join('').trim();
        if (text) {
            blocks.push(`${blocks.length + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${text}`);
        }
        seg = null;
    };

    for (const word of words) {
        if (word.wp === 'p') {
            // 标点词结束当前句并纳入句末；无前置内容（连续标点）时忽略
            if (seg) {
                seg.w.push(word.w);
                seg.end = word.end;
                flush();
            }
            continue;
        }
        if (!seg) seg = { w: [], start: word.start, end: word.end };
        seg.w.push(word.w);
        seg.end = word.end;
    }
    flush();

    return blocks.join('\n\n') + (blocks.length ? '\n' : '');
};
