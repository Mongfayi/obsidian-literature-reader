import { requestUrl, RequestUrlParam } from 'obsidian';

/**
 * OCR 服务（LM Studio OpenAI 兼容接口）
 *  - 通过 Obsidian requestUrl 发起请求（主进程请求，无 CORS 限制）
 *  - 模型列表：GET {serverUrl}/v1/models
 *  - 截图识别：POST {serverUrl}/v1/chat/completions（image_url base64 + 提示词），
 *    返回纯文本（PaddleOCR-VL 等视觉模型识别截图内文字）
 */

export class OcrService {
    private baseUrl: string;
    private apiKey: string;

    constructor(baseUrl: string, apiKey?: string) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiKey = apiKey ?? '';
    }

    setBaseUrl(url: string): void {
        this.baseUrl = url.replace(/\/+$/, '');
    }

    setApiKey(key: string): void {
        this.apiKey = key;
    }

    /** 拉取服务器可用模型列表 */
    async listModels(): Promise<string[]> {
        const res = await this.request({
            url: `${this.baseUrl}/v1/models`,
            method: 'GET',
        }, 10000);
        const data = res.json;
        const models = data?.data ?? [];
        return models.map((m: any) => typeof m === 'string' ? m : (m?.id ?? '')).filter(Boolean);
    }

    /** 自动选择模型：设置指定 → 视觉模型按优先级（paddleocr-vl-1.6 首选） */
    async resolveModel(configured: string): Promise<string> {
        if (configured.trim()) return configured.trim();
        const models = await this.listModels();
        if (models.length === 0) throw new Error('服务器未返回任何模型');
        const priority = ['paddleocr-vl-1.6', 'qwen3-vl', 'paddleocr-vl-1.5'];
        for (const key of priority) {
            const hit = models.find((id) => id.includes(key));
            if (hit) return hit;
        }
        const preferred = models.find((m) => /ocr|vision|vl|qwen|llava|gemini/i.test(m));
        return preferred ?? models[0];
    }

    /**
     * 识别截图图像中的文字（纯文本输出）
     * @param imageDataUrl data:image/jpeg;base64,...
     * @returns 识别文本（可能为空字符串）与停止原因
     */
    async ocrText(
        imageDataUrl: string,
        model: string,
        prompt: string,
        timeoutSec: number,
        maxTokens: number
    ): Promise<{ text: string; finishReason: string | null }> {
        const isPaddleOcr = /paddleocr-vl/i.test(model);
        try {
            return await this.requestChatWithImageUrl(
                prompt, imageDataUrl, model, timeoutSec, maxTokens, isPaddleOcr
            );
        } catch (e) {
            // 仅对 4xx 客户端错误重试一次（多为模型对内容顺序/格式的拒绝，交换
            // image/text 顺序通常可解决）；超时/5xx/网络错误不重试，避免双倍等待
            if (!isRetryableHttpError(e)) throw e;
            try {
                return await this.requestChatWithImageUrl(
                    prompt, imageDataUrl, model, timeoutSec, maxTokens, !isPaddleOcr
                );
            } catch (e2) {
                throw new Error(`${(e as Error).message}（重试仍失败: ${(e2 as Error).message}）`);
            }
        }
    }

    private async requestChatWithImageUrl(
        prompt: string,
        imageDataUrl: string,
        model: string,
        timeoutSec: number,
        maxTokens: number,
        imageFirst: boolean
    ): Promise<{ text: string; finishReason: string | null }> {
        const imgPart = { type: 'image_url', image_url: { url: imageDataUrl } };
        const textPart = { type: 'text', text: prompt };
        const body = {
            model,
            messages: [
                {
                    role: 'user',
                    content: imageFirst ? [imgPart, textPart] : [textPart, imgPart],
                },
            ],
            temperature: 0,
            max_tokens: maxTokens,
        };
        const res = await this.request({
            url: `${this.baseUrl}/v1/chat/completions`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, timeoutSec * 1000);
        const choice = res.json?.choices?.[0];
        const raw = choice?.message?.content ?? '';
        return {
            text: sanitizeOcrText(raw),
            finishReason: choice?.finish_reason ?? null,
        };
    }

    /** 超时后仍在运行的底层请求（requestUrl 不支持中止，仅跟踪以防 unhandled rejection） */
    private zombieRequest: Promise<unknown> | null = null;

    /** 基于 requestUrl 的请求；超过 timeoutMs 抛超时错误 */
    private async request(params: RequestUrlParam, timeoutMs: number) {
        let timer: number | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => {
                reject(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`));
            }, timeoutMs);
        });

        // 如果配了 API Key，自动注入 Authorization 头（LM Studio 开启 Require Authentication 时必需）
        const headers: Record<string, string> = { ...(params.headers as Record<string, string> ?? {}) };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const requestPromise = (async () => {
            const res = await requestUrl({
                throw: false,
                ...params,
                headers,
            });
            if (res.status < 200 || res.status >= 300) {
                const errText = typeof res.text === 'string' ? res.text.slice(0, 300) : '';
                throw new Error(`HTTP ${res.status} ${errText}`);
            }
            return res;
        })();

        try {
            return await Promise.race([requestPromise, timeoutPromise]);
        } catch (e) {
            // 超时后底层 requestUrl 仍在运行（requestUrl 不支持 AbortController）。
            // 跟踪该僵尸请求并附加 no-op catch，防止 settle 时产生 unhandled rejection；
            // 用户重试时若僵尸仍在进行，记录警告以便排查
            if (e instanceof Error && e.message.startsWith('请求超时')) {
                this.trackZombie(requestPromise);
            }
            throw e;
        } finally {
            // 请求已结束（无论成败），清理超时定时器，避免句柄与闭包滞留到超时时刻
            if (timer !== null) window.clearTimeout(timer);
        }
    }

    /** 跟踪超时后仍在进行的底层请求，附加 catch 防止 unhandled rejection */
    private trackZombie(promise: Promise<unknown>): void {
        if (this.zombieRequest && this.zombieRequest !== promise) {
            console.warn('[OcrService] 检测到累积的僵尸请求（前一次超时请求仍在进行）');
            // 旧僵尸附加 no-op catch，确保不会 unhandled
            this.zombieRequest.catch(() => {});
        }
        this.zombieRequest = promise;
        promise.finally(() => {
            if (this.zombieRequest === promise) {
                this.zombieRequest = null;
            }
        });
        promise.catch(() => {});
    }
}

/** 是否属于可重试的 HTTP 4xx 客户端错误（模板/内容顺序类问题，换顺序后重试可能成功） */
function isRetryableHttpError(err: unknown): boolean {
    const msg = (err as Error).message ?? '';
    return msg.startsWith('HTTP 4');
}

/** 清洗 OCR 文本：去掉 HTML 标签、markdown 装饰、幻觉噪音，保留真实文字内容 */
export function sanitizeOcrText(text: string): string {
    return text
        // 统一换行：CRLF / CR → LF；部分 OCR 模型会输出 Unicode 回车/换行符号
        .replace(/\r\n?/g, '\n')
        .replace(/[\u21B5\u23CE\u240D\u2424\u2937\u2028\u2029]/g, '\n')
        // HTML 标签（保留标签内文字）
        .replace(/<[^>]*>/g, ' ')
        // 位置令牌 / det 标记
        .replace(/<\|[^|]*\|>/g, ' ')
        // LaTeX 括号包装 \( \) \[ \]（保留内部文字）
        .replace(/\\[()[\]]/g, ' ')
        // LaTeX 文本命令包装（\text{Pi1} \mathrm{...} 等，保留花括号内文字）
        .replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1')
        // LaTeX 常用符号 → 可读字符
        .replace(/\\times/g, '×')
        .replace(/\\pm/g, '±')
        .replace(/\\leq/g, '≤')
        .replace(/\\geq/g, '≥')
        .replace(/\\neq/g, '≠')
        .replace(/\\approx/g, '≈')
        .replace(/\\rightarrow|\\to/g, '→')
        .replace(/\\cdot/g, '·')
        // 纯数字序列循环行（[650] [651] [652] ...）
        .replace(/^\s*(?:\[\d+\]\s*)+$/gm, ' ')
        // 代码块
        .replace(/```[\s\S]*?```/g, ' ')
        // markdown 标题
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        // markdown 分隔线（---、***、___）
        .replace(/^\s{0,3}(?:[-*_]){3,}\s*$/gm, '')
        // markdown 粗体/斜体标记
        .replace(/\*\*|__/g, '')
        .replace(/(^|[^\w])\*([^\s*][^*]*)\*([^\w]|$)/g, '$1$2$3')
        // 引用/列表符号
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        // 表格分隔符 | → 空格
        .replace(/\|/g, ' ')
        // HTML 实体
        .replace(/&(?:lt|gt|amp|quot|apos|nbsp);/g, (m) => {
            switch (m) {
                case '&lt;': return '<';
                case '&gt;': return '>';
                case '&amp;': return '&';
                case '&quot;': return '"';
                case '&apos;': return "'";
                case '&nbsp;': return ' ';
                default: return ' ';
            }
        })
        // 多余空白
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
