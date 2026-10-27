import crypto from 'node:crypto';

const CRLF = '\r\n';

/**
 * 构建 multipart/form-data 请求体（Node 原生 Buffer 手工拼装，固定 boundary）。
 * 构建出的 body、Content-Type 头、X-Sign 签名三处共用同一个 boundary，
 * 以便对"整个 multipart body"计算签名（对齐讯飞官方 Python demo 对 formData 签名的方式）。
 *
 * @param params.file  文件字段（name 为字段名，fileName 为上传文件名，mimeType 为音频 MIME）
 * @param params.fields 普通文本字段，value 为空字符串的字段会被跳过
 * @returns { body: Buffer; boundary: string }
 */
export function buildMultipartBody(params: {
    file: { name: string; fileName: string; mimeType: string; buffer: Buffer };
    fields: { name: string; value: string }[];
}): { body: Buffer; boundary: string } {
    const boundary = `----XunfeiBoundary${crypto.randomBytes(16).toString('hex')}`;
    const chunks: Buffer[] = [];

    // 文件部分
    chunks.push(Buffer.from(`--${boundary}${CRLF}`));
    chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${params.file.name}"; filename="${params.file.fileName}"${CRLF}`
    ));
    chunks.push(Buffer.from(`Content-Type: ${params.file.mimeType}${CRLF}${CRLF}`));
    chunks.push(params.file.buffer);
    chunks.push(Buffer.from(CRLF));

    // 文本字段部分（空值跳过）
    for (const f of params.fields) {
        if (f.value === '') continue;
        chunks.push(Buffer.from(`--${boundary}${CRLF}`));
        chunks.push(Buffer.from(`Content-Disposition: form-data; name="${f.name}"${CRLF}${CRLF}`));
        chunks.push(Buffer.from(String(f.value)));
        chunks.push(Buffer.from(CRLF));
    }

    // 结束标识
    chunks.push(Buffer.from(`--${boundary}--${CRLF}`));

    return { body: Buffer.concat(chunks), boundary };
}
