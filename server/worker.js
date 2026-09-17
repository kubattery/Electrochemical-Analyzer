/* ============================================================================
 * ESMPL Analyzer · Claude 중계 서버 (Cloudflare Worker)
 *
 * 왜 중계가 필요한가
 *  · 브라우저에서 Anthropic API 를 직접 부르려면 키가 브라우저에 들어가야 한다.
 *    정적 사이트에서는 그 키를 숨길 방법이 없다. 누구든 개발자 도구로 꺼내 쓴다.
 *  · 그래서 키는 이 서버의 환경변수에만 두고, 브라우저는 이 서버만 부른다.
 *    연구실 구성원은 키 없이 쓰고, 비용은 이 키 하나로 모인다.
 *
 * 배포: server/README.md 참고
 * ========================================================================== */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

/* 요청 본문 상한. 분석 스냅샷 2~3개와 대화 이력을 합쳐도 이보다 훨씬 작다.
   상한을 두지 않으면 누군가 큰 본문을 반복해 보내 비용을 태울 수 있다. */
const MAX_BODY_BYTES = 256 * 1024;

/* 대화가 길어져도 최근 것만 보낸다. 오래된 맥락까지 매번 보내면 비용만 늘어난다. */
const MAX_MESSAGES = 40;

function corsHeaders(origin, allowed) {
    const h = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
    };
    if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
    return h;
}

function json(body, status, headers) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
    });
}

export default {
    async fetch(request, env) {
        // 허용 오리진 목록. 쉼표로 구분해 환경변수에 둔다.
        const allowed = (env.ALLOWED_ORIGINS || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin, allowed);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }
        if (request.method !== 'POST') {
            return json({ error: 'POST 만 허용합니다.' }, 405, cors);
        }
        if (allowed.length && !allowed.includes(origin)) {
            // 오리진을 제한해 두지 않으면 링크를 아는 누구나 이 서버로 비용을 쓸 수 있다.
            return json({ error: '허용되지 않은 오리진입니다: ' + (origin || '(없음)') }, 403, cors);
        }
        if (!env.ANTHROPIC_API_KEY) {
            return json({ error: '서버에 ANTHROPIC_API_KEY 가 설정되어 있지 않습니다.' }, 500, cors);
        }

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
            return json({ error: '요청이 너무 큽니다.' }, 413, cors);
        }

        let body;
        try { body = JSON.parse(raw); }
        catch (e) { return json({ error: '본문이 올바른 JSON 이 아닙니다.' }, 400, cors); }

        const system = typeof body.system === 'string' ? body.system : '';
        const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
        if (messages.length === 0) {
            return json({ error: 'messages 가 비어 있습니다.' }, 400, cors);
        }

        const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

        try {
            const response = await client.messages.create({
                model: env.MODEL || MODEL,
                max_tokens: Math.min(Number(body.max_tokens) || 8000, 16000),
                // 시스템 프롬프트는 대화 내내 그대로이므로 캐시해 비용을 줄인다
                system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
                messages: messages
            });

            if (response.stop_reason === 'refusal') {
                return json({
                    error: '모델이 응답을 거부했습니다.',
                    detail: response.stop_details ? response.stop_details.explanation : null
                }, 200, cors);
            }

            const text = response.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n');

            return json({
                text: text,
                model: response.model,
                stop_reason: response.stop_reason,
                usage: response.usage
            }, 200, cors);

        } catch (error) {
            // 가장 구체적인 것부터 확인한다. 하나로 뭉뚱그리면 재시도 가능 여부를 잃는다.
            if (error instanceof Anthropic.AuthenticationError) {
                return json({ error: 'API 키가 올바르지 않습니다. 서버 설정을 확인해 주세요.' }, 502, cors);
            }
            if (error instanceof Anthropic.RateLimitError) {
                return json({ error: '요청이 몰려 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.' }, 429, cors);
            }
            if (error instanceof Anthropic.BadRequestError) {
                return json({ error: '요청 형식 오류: ' + error.message }, 400, cors);
            }
            if (error instanceof Anthropic.APIError) {
                return json({ error: 'Anthropic API 오류 (' + error.status + '): ' + error.message }, 502, cors);
            }
            return json({ error: '중계 서버 오류: ' + (error && error.message ? error.message : String(error)) }, 500, cors);
        }
    }
};
