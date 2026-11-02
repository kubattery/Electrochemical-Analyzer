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
    // 한국어 서술과 도메인 지시 수행이 가장 나았다. Llama 3.3 은 한국어를 중국어로
    // 오인하고 반복 붕괴를 일으켰고, Llama 4 Scout 는 동작하지만 서술이 일반적이다.
    cloudflare: '@cf/openai/gpt-oss-120b',
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
    // 키가 하나도 없어도 Workers AI 바인딩만 있으면 동작한다
    if (env.AI) return 'cloudflare';
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

/**
 * 응답 본문을 글자로 먼저 읽고 JSON 으로 해석한다.
 * 곧바로 res.json() 을 부르면 빈 응답이나 HTML 오류 페이지일 때
 * Unexpected end of JSON input 만 남고 진짜 사유가 사라진다.
 */
async function readJson(res, who) {
    const raw = await res.text();
    if (!raw || !raw.trim()) {
        // 본문이 비면 헤더가 유일한 단서다. 어디서 막혔는지 알려면 함께 남겨야 한다.
        const hints = [];
        ['content-type', 'content-length', 'x-request-id', 'www-authenticate',
         'cf-ray', 'server'].forEach(k => {
            const v = res.headers.get(k);
            if (v) hints.push(k + '=' + v);
        });
        throw new Error(who + ' 가 빈 응답을 돌려주었습니다 (HTTP ' + res.status + ' ' +
            (res.statusText || '') + '). ' + (hints.length ? '[' + hints.join(', ') + '] ' : '') +
            '키가 올바른지, 크레딧 잔액이 있는지 확인해 주세요.');
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(who + ' 응답을 해석하지 못했습니다 (HTTP ' + res.status + '): ' +
            raw.slice(0, 300));
    }
}

/**
 * Cloudflare Workers AI — API 키가 필요 없는 경로.
 *
 * 왜 이것이 유일하게 키 없이 되는가
 *  · 다른 제공자는 모두 계정 인증이 필요하고, 그 인증 수단이 곧 API 키다.
 *  · Workers AI 는 이 Worker 가 이미 Cloudflare 계정 안에서 돌고 있으므로
 *    계정 자체가 인증이다. env.AI 바인딩으로 바로 부른다.
 *  · Cloudflare 네트워크에서 추론하므로 Gemini 를 막았던 지역 제한도 없다.
 *  · 무료 플랜에 하루 10,000 뉴런이 매일 주어진다. 카드 등록도 필요 없다.
 *
 * 한계: 돌릴 수 있는 것은 공개 가중치 모델이다. 같은 프롬프트라도
 *       GPT-4o 나 Claude 만큼의 서술은 기대하기 어렵다.
 */
async function callWorkersAI(env, model, system, messages, maxTokens) {
    if (!env.AI) {
        throw new Error('Workers AI 바인딩이 없습니다. wrangler.toml 에 [ai] binding = "AI" 를 넣고 다시 배포해 주세요.');
    }
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    messages.forEach(m => msgs.push({ role: m.role, content: String(m.content) }));

    const res = await env.AI.run(model, { messages: msgs, max_tokens: maxTokens });

    // 텍스트 생성 모델은 response 에 답을 담아 준다. 모델에 따라 모양이 조금씩 다르므로 넓게 받는다.
    const text = (typeof res === 'string') ? res
        : (res && (res.response || res.result || (res.choices && res.choices[0] &&
           res.choices[0].message && res.choices[0].message.content))) || '';
    if (!text) {
        throw new Error('Workers AI 가 빈 응답을 돌려주었습니다. 모델 이름이 맞는지 확인해 주세요: ' + model);
    }
    const u = (res && res.usage) || {};
    return {
        text: text,
        model: model,
        usage: {
            input_tokens: u.prompt_tokens || 0,
            output_tokens: u.completion_tokens || 0,
            cache_read_input_tokens: 0
        }
    };
}

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
    const data = await readJson(res, 'Gemini');
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
        return { res: r, data: await readJson(r, 'OpenAI') };
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
            return json({ error: '사용할 수 있는 제공자가 없습니다. wrangler.toml 에 [ai] binding = "AI" 를 넣어 Workers AI 를 쓰거나, ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY 중 하나를 넣어 주세요.' }, 500, cors);
        }
        const keyFor = {
            anthropic: env.ANTHROPIC_API_KEY,
            gemini: env.GEMINI_API_KEY,
            openai: env.OPENAI_API_KEY
        };
        // Workers AI 는 계정 자체가 인증이므로 키를 확인하지 않는다
        if (provider !== 'cloudflare' && !keyFor[provider]) {
            return json({ error: 'PROVIDER 가 ' + provider + ' 인데 해당 키가 설정되어 있지 않습니다.' }, 500, cors);
        }

        // [임시 진단] 키 값 자체는 절대 내보내지 않고 모양만 알려 준다.
        // 원인을 잡은 뒤 이 블록은 제거한다.
        const url = new URL(request.url);
        if (url.searchParams.get('diag') === '1') {
            const k = keyFor[provider] || '';
            return json({
                provider: provider,
                keyLength: k.length,
                keyPrefix: k.slice(0, 7),
                keySuffix: k.slice(-4),
                hasWhitespace: k !== k.trim() || k.indexOf(String.fromCharCode(32)) >= 0,
                hasNewline: k.indexOf(String.fromCharCode(10)) >= 0 || k.indexOf(String.fromCharCode(13)) >= 0,
                trimmedLength: k.trim().length,
                model: env.MODEL || DEFAULT_MODEL[provider]
            }, 200, cors);
        }

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) return json({ error: '요청이 너무 큽니다.' }, 413, cors);

        let body;
        try { body = JSON.parse(raw); }
        catch (e) { return json({ error: '본문이 올바른 JSON 이 아닙니다.' }, 400, cors); }

        const system = typeof body.system === 'string' ? body.system : '';
        const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
        if (messages.length === 0) return json({ error: 'messages 가 비어 있습니다.' }, 400, cors);

        // 요청에서 모델을 지정할 수 있게 한다. 오리진이 제한돼 있어 외부에서 쓸 수 없고,
        // 모델을 바꿔 비교해 보려면 이 통로가 필요하다.
        const model = (typeof body.model === 'string' && body.model.trim())
            || env.MODEL || DEFAULT_MODEL[provider];
        const maxTokens = Math.min(Number(body.max_tokens) || 8000, 16000);

        try {
            let out;
            if (provider === 'cloudflare')  out = await callWorkersAI(env, model, system, messages, maxTokens);
            else if (provider === 'anthropic') out = await callAnthropic(env, model, system, messages, maxTokens);
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
