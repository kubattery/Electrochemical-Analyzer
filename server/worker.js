/* ============================================================================
 * ESMPL Analyzer · AI 중계 서버 (Cloudflare Worker)
 *
 * 왜 중계가 필요한가
 *  · 브라우저에서 AI API 를 직접 부르려면 키가 브라우저에 들어간다. 정적 사이트에서는
 *    그 키를 숨길 방법이 없고, 개발자 도구로 누구나 꺼내 쓸 수 있다.
 *  · 그래서 키는 이 서버의 환경변수에만 두고, 브라우저는 이 서버만 부른다.
 *    연구실 구성원은 키 없이 쓰고, 비용은 이 키 하나로 모인다.
 *
 * [중요] 구독과 API 는 별개 상품이다
 *  Claude Pro 나 ChatGPT Plus 를 결제해도 프로그램이 호출할 수 있는 창구는 없다.
 *  아래 세 제공자 중 하나의 API 키가 필요하며, Gemini 는 무료 등급이 있다.
 *
 * 어떤 키를 넣느냐로 제공자가 정해진다. 설정된 키를 순서대로 찾는다.
 *   ANTHROPIC_API_KEY  ->  Claude   (유료. 신규 계정 무료 크레딧이 있을 수 있음)
 *   GEMINI_API_KEY     ->  Gemini   (무료 등급 있음. 카드 등록 없이 발급)
 *   OPENAI_API_KEY     ->  GPT      (유료. ChatGPT 구독과 별개)
 * env.PROVIDER 를 직접 지정하면 그것을 우선한다.
 *
 * 배포: server/README.md
 * ========================================================================== */

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = {
    anthropic: 'claude-opus-5',
    gemini: 'gemini-flash-latest',
    openai: 'gpt-4o'
};

/* 요청 본문 상한. 분석 스냅샷과 대화 이력을 합쳐도 이보다 훨씬 작다.
   상한이 없으면 누군가 큰 본문을 반복해 보내 비용을 태울 수 있다. */
const MAX_BODY_BYTES = 256 * 1024;

/* 대화가 길어져도 최근 것만 보낸다. 오래된 맥락까지 매번 보내면 비용만 늘어난다. */
const MAX_MESSAGES = 40;

function pickProvider(env) {
    if (env.PROVIDER) return env.PROVIDER.trim().toLowerCase();
    if (env.ANTHROPIC_API_KEY) return 'anthropic';
    if (env.GEMINI_API_KEY) return 'gemini';
    if (env.OPENAI_API_KEY) return 'openai';
    return null;
}

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

/* ---------------- 제공자별 호출 ----------------
 * 반환 형태를 하나로 맞춘다.
 *   { text, model, usage: { input_tokens, output_tokens, cache_read_input_tokens } }
 * 창 쪽은 이 형태만 알면 되므로 제공자를 바꿔도 창을 고칠 일이 없다.
 * ---------------------------------------------- */

async function callAnthropic(env, model, system, messages, maxTokens) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
        model: model,
        max_tokens: maxTokens,
        // 시스템 프롬프트는 대화 내내 그대로이므로 캐시해 반복 호출 비용을 줄인다
        system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
        messages: messages
    });
    if (res.stop_reason === 'refusal') {
        const why = res.stop_details ? res.stop_details.explanation : '';
        throw new Error('모델이 응답을 거부했습니다. ' + (why || ''));
    }
    return {
        text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
        model: res.model,
        usage: {
            input_tokens: res.usage.input_tokens,
            output_tokens: res.usage.output_tokens,
            cache_read_input_tokens: res.usage.cache_read_input_tokens || 0
        }
    };
}

async function callGemini(env, model, system, messages, maxTokens) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                encodeURIComponent(model) + ':generateContent?key=' +
                encodeURIComponent(env.GEMINI_API_KEY);

    const body = {
        contents: messages.map(m => ({
            // Gemini 는 assistant 를 model 이라고 부른다
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(m.content) }]
        })),
        generationConfig: { maxOutputTokens: maxTokens }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
        const msg = (data && data.error) ? data.error.message : ('HTTP ' + res.status);
        throw new Error('Gemini 오류: ' + msg);
    }
    const cand = (data.candidates || [])[0];
    if (!cand) throw new Error('Gemini 가 응답을 돌려주지 않았습니다.');
    if (cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') {
        throw new Error('Gemini 가 응답을 중단했습니다 (' + cand.finishReason + ').');
    }
    const u = data.usageMetadata || {};
    return {
        text: ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('\n'),
        model: data.modelVersion || model,
        usage: {
            input_tokens: u.promptTokenCount || 0,
            output_tokens: u.candidatesTokenCount || 0,
            cache_read_input_tokens: u.cachedContentTokenCount || 0
        }
    };
}

async function callOpenAI(env, model, system, messages, maxTokens) {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    messages.forEach(m => msgs.push({ role: m.role, content: String(m.content) }));

    // 최근 모델은 max_completion_tokens 를, 예전 모델은 max_tokens 를 받는다.
    // 어느 쪽인지 단정하지 말고, 거부당하면 반대쪽으로 한 번 다시 시도한다.
    async function send(capField) {
        const body = { model: model, messages: msgs };
        body[capField] = maxTokens;
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + env.OPENAI_API_KEY
            },
            body: JSON.stringify(body)
        });
        return { res: r, data: await r.json() };
    }

    let out = await send('max_completion_tokens');
    if (!out.res.ok && out.data && out.data.error &&
        /max_completion_tokens|Unsupported parameter|Unrecognized/i.test(out.data.error.message || '')) {
        out = await send('max_tokens');
    }
    if (!out.res.ok) {
        const msg = (out.data && out.data.error) ? out.data.error.message : ('HTTP ' + out.res.status);
        throw new Error('OpenAI 오류: ' + msg);
    }
    const choice = (out.data.choices || [])[0];
    if (!choice) throw new Error('OpenAI 가 응답을 돌려주지 않았습니다.');
    const u = out.data.usage || {};
    return {
        text: (choice.message && choice.message.content) || '',
        model: out.data.model || model,
        usage: {
            input_tokens: u.prompt_tokens || 0,
            output_tokens: u.completion_tokens || 0,
            cache_read_input_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
        }
    };
}

export default {
    async fetch(request, env) {
        const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin, allowed);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method !== 'POST') return json({ error: 'POST 만 허용합니다.' }, 405, cors);

        if (allowed.length && !allowed.includes(origin)) {
            // 오리진을 제한하지 않으면 주소를 아는 누구나 이 키로 비용을 쓸 수 있다.
            return json({ error: '허용되지 않은 오리진입니다: ' + (origin || '(없음)') }, 403, cors);
        }

        const provider = pickProvider(env);
        if (!provider) {
            return json({ error: '서버에 API 키가 설정되어 있지 않습니다. ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY 중 하나를 넣어 주세요.' }, 500, cors);
        }
        const keyFor = {
            anthropic: env.ANTHROPIC_API_KEY,
            gemini: env.GEMINI_API_KEY,
            openai: env.OPENAI_API_KEY
        };
        if (!keyFor[provider]) {
            return json({ error: 'PROVIDER 가 ' + provider + ' 인데 해당 키가 설정되어 있지 않습니다.' }, 500, cors);
        }

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) return json({ error: '요청이 너무 큽니다.' }, 413, cors);

        let body;
        try { body = JSON.parse(raw); }
        catch (e) { return json({ error: '본문이 올바른 JSON 이 아닙니다.' }, 400, cors); }

        const system = typeof body.system === 'string' ? body.system : '';
        const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
        if (messages.length === 0) return json({ error: 'messages 가 비어 있습니다.' }, 400, cors);

        const model = env.MODEL || DEFAULT_MODEL[provider];
        const maxTokens = Math.min(Number(body.max_tokens) || 8000, 16000);

        try {
            let out;
            if (provider === 'anthropic')   out = await callAnthropic(env, model, system, messages, maxTokens);
            else if (provider === 'gemini') out = await callGemini(env, model, system, messages, maxTokens);
            else if (provider === 'openai') out = await callOpenAI(env, model, system, messages, maxTokens);
            else return json({ error: '알 수 없는 PROVIDER: ' + provider }, 500, cors);

            out.provider = provider;
            return json(out, 200, cors);

        } catch (error) {
            // Anthropic SDK 는 구체적인 오류 형을 준다. 가장 구체적인 것부터 본다.
            if (error instanceof Anthropic.AuthenticationError) {
                return json({ error: 'API 키가 올바르지 않습니다. 서버 설정을 확인해 주세요.' }, 502, cors);
            }
            if (error instanceof Anthropic.RateLimitError) {
                return json({ error: '요청이 몰려 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.' }, 429, cors);
            }
            if (error instanceof Anthropic.APIError) {
                return json({ error: 'Anthropic API 오류 (' + error.status + '): ' + error.message }, 502, cors);
            }
            return json({ error: (error && error.message) ? error.message : String(error) }, 502, cors);
        }
    }
};
