/* ============================================================================
 * ESMPL Analyzer · 연구실 내부 서버
 *
 * 웹사이트와 AI 중계를 한 프로세스에서 돌린다.
 *   http://<서버주소>:8080/          → 분석기 웹사이트
 *   http://<서버주소>:8080/api/ai    → AI 중계 (해석 창이 부르는 곳)
 *
 * 왜 이 구성이 유리한가
 *  · 같은 출처에서 서비스되므로 오리진 설정이나 CORS 로 씨름할 일이 없다.
 *  · 실행 지역이 연구실 네트워크다. Cloudflare 가 홍콩에서 실행해 Gemini 가
 *    지역 제한으로 거부하던 문제가 사라진다.
 *  · 키는 서버 환경변수에만 둔다. 연구실 구성원은 주소만 알면 된다.
 *
 * AI 는 두 방식 중 하나로 쓴다.
 *
 *  (1) 구독 CLI 중계 — 추가 비용이 없다. 혼자 쓰는 경우를 위한 것이며,
 *      그 전제를 동작으로 묶어 두었다. 이 모드에서는 서버가 127.0.0.1 에만 붙어
 *      다른 PC 에서 닿지 않는다. 좌석 하나를 여러 사람이 쓰는 공용 중계로 돌리는
 *      것은 구독의 용도가 아니다. ALLOW_LAN=1 로 풀 수는 있게 두었지만 그때는
 *      본인 판단이다.
 *
 *        AI_CLI=codex-app   Codex App Server. 프로세스를 띄워 두고 JSON-RPC 로
 *                           주고받는다. 질문마다 새로 띄우지 않아 빠르고, 대화가
 *                           스레드로 남아 이어지는 질문은 새로 한 말만 보낸다.
 *                           Codex 를 쓸 수 있으면 이쪽을 권한다.
 *        AI_CLI=codex       codex exec. 질문마다 프로세스를 새로 띄운다.
 *        AI_CLI=claude      claude -p. 질문마다 프로세스를 새로 띄운다.
 *
 *  (2) API 키 — GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
 *      여러 사람이 쓰거나 서버를 상시 열어 둘 때는 이쪽이다.
 *      Gemini 는 무료 등급이 있다.
 *
 * 실행:
 *   set AI_CLI=codex-app && node server/local/server.js          (Windows CMD)
 *   $env:AI_CLI="codex-app"; node server/local/server.js          (PowerShell)
 *   AI_CLI=codex-app node server/local/server.js                  (Linux/Mac)
 *   $env:GEMINI_API_KEY="..."; node server/local/server.js        (키를 쓸 때)
 *
 * AI_DEBUG=1 을 주면 스레드를 새로 여는 사유를 찍는다.
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callCli, cliStatus, CLI_SPECS } from './cli-bridge.js';
import { askApp, appStatus, stopApp } from './codex-app.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');      // 저장소 루트 = 웹사이트 파일 위치
const PORT = Number(process.env.PORT) || 8080;

const DEFAULT_MODEL = {
    gemini: 'gemini-flash-latest',
    openai: 'gpt-4o',
    anthropic: 'claude-opus-5'
};

const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 40;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

/* 어떤 방식으로 AI 를 부를지 정한다. CLI 를 지정했으면 그쪽이 먼저다.
   codex-app 은 프로세스를 띄워 두고 JSON-RPC 로 주고받는 방식이라 따로 다룬다. */
function pickCli() {
    const v = (process.env.AI_CLI || '').trim().toLowerCase();
    if (v === 'codex-app') return 'codex-app';
    return CLI_SPECS[v] ? v : null;
}

function isAppMode() { return pickCli() === 'codex-app'; }

function cliInfo(name) {
    return name === 'codex-app' ? appStatus() : cliStatus(name);
}

function pickProvider() {
    if (pickCli()) return 'cli';
    if (process.env.PROVIDER) return process.env.PROVIDER.trim().toLowerCase();
    if (process.env.GEMINI_API_KEY) return 'gemini';
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
    return null;
}

/* CLI 모드는 혼자 쓰는 전제다. 그 전제를 글로만 두지 않고 바인딩으로 묶는다. */
function bindHost() {
    if (process.env.ALLOW_LAN === '1') return '0.0.0.0';
    return pickCli() ? '127.0.0.1' : '0.0.0.0';
}

/** 응답 본문을 글자로 먼저 읽고 JSON 으로 해석한다. 빈 응답이나 HTML 오류 페이지에서
    사유를 잃지 않기 위해서다. */
async function readJson(res, who) {
    const raw = await res.text();
    if (!raw || !raw.trim()) {
        throw new Error(who + ' 가 빈 응답을 돌려주었습니다 (HTTP ' + res.status + '). 키와 잔액을 확인해 주세요.');
    }
    try { return JSON.parse(raw); }
    catch (e) { throw new Error(who + ' 응답을 해석하지 못했습니다 (HTTP ' + res.status + '): ' + raw.slice(0, 300)); }
}

async function callGemini(model, system, messages, maxTokens) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                encodeURIComponent(model) + ':generateContent?key=' +
                encodeURIComponent(process.env.GEMINI_API_KEY);
    const body = {
        contents: messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',   // Gemini 는 assistant 를 model 이라 부른다
            parts: [{ text: String(m.content) }]
        })),
        generationConfig: { maxOutputTokens: maxTokens }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await readJson(res, 'Gemini');
    if (!res.ok) throw new Error('Gemini 오류: ' + ((data.error && data.error.message) || res.status));

    const cand = (data.candidates || [])[0];
    if (!cand) throw new Error('Gemini 가 응답을 돌려주지 않았습니다.');
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

async function callOpenAI(model, system, messages, maxTokens) {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    messages.forEach(m => msgs.push({ role: m.role, content: String(m.content) }));

    // 최근 모델은 max_completion_tokens 를, 예전 모델은 max_tokens 를 받는다.
    async function send(capField) {
        const body = { model, messages: msgs };
        body[capField] = maxTokens;
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
            },
            body: JSON.stringify(body)
        });
        return { res: r, data: await readJson(r, 'OpenAI') };
    }
    let out = await send('max_completion_tokens');
    if (!out.res.ok && out.data.error && /max_completion_tokens|Unsupported parameter|Unrecognized/i.test(out.data.error.message || '')) {
        out = await send('max_tokens');
    }
    if (!out.res.ok) throw new Error('OpenAI 오류: ' + ((out.data.error && out.data.error.message) || out.res.status));

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

async function callAnthropic(model, system, messages, maxTokens) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model, max_tokens: maxTokens,
            // 시스템 프롬프트는 대화 내내 그대로이므로 캐시해 반복 호출 비용을 줄인다
            system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
            messages
        })
    });
    const data = await readJson(res, 'Anthropic');
    if (!res.ok) throw new Error('Anthropic 오류: ' + ((data.error && data.error.message) || res.status));
    if (data.stop_reason === 'refusal') throw new Error('모델이 응답을 거부했습니다.');

    const u = data.usage || {};
    return {
        text: (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
        model: data.model || model,
        usage: {
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_read_input_tokens: u.cache_read_input_tokens || 0
        }
    };
}

/* ---------------- 정적 파일 제공 ---------------- */
function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';

    // 경로 탈출 방지: 저장소 루트 밖으로 나가는 요청은 거부한다
    const full = path.resolve(ROOT, '.' + rel);
    if (!full.startsWith(ROOT)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('허용되지 않은 경로입니다.');
        return;
    }
    fs.readFile(full, (err, buf) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('없는 파일입니다: ' + rel);
            return;
        }
        const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
        // 진입점과 팝업은 캐시하지 않는다. 캐시되면 안에 적힌 ?v= 버전이 옛 것으로 고정된다.
        const noCache = /\.(html)$/i.test(full);
        res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=300'
        });
        res.end(buf);
    });
}

/* ---------------- AI 중계 ---------------- */
async function handleAi(req, res) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '요청이 너무 큽니다.' }));
            return;
        }
        chunks.push(c);
    }

    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '본문이 올바른 JSON 이 아닙니다.' }));
        return;
    }

    const provider = pickProvider();
    const keyFor = {
        gemini: process.env.GEMINI_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY
    };
    const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
    };

    if (provider === 'cli') {
        const st = cliInfo(pickCli());
        if (!st.ok) { send(500, { error: st.error }); return; }
    } else if (!provider || !keyFor[provider]) {
        send(500, { error: '서버에 AI 설정이 없습니다. 구독 CLI 를 쓰려면 AI_CLI 에 codex-app / codex / claude 중 하나를, 키를 쓰려면 GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY 중 하나를 환경변수로 넣고 다시 실행해 주세요.' });
        return;
    }

    const system = typeof body.system === 'string' ? body.system : '';
    const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
    if (messages.length === 0) { send(400, { error: 'messages 가 비어 있습니다.' }); return; }

    const model = (typeof body.model === 'string' && body.model.trim()) || process.env.MODEL || DEFAULT_MODEL[provider];
    const maxTokens = Math.min(Number(body.max_tokens) || 8000, 16000);

    try {
        let out;
        if (provider === 'cli') {
            out = isAppMode()
                ? await askApp(process.env.MODEL || '', system, messages)
                : await callCli(pickCli(), process.env.MODEL || '', system, messages);
        }
        else if (provider === 'gemini') out = await callGemini(model, system, messages, maxTokens);
        else if (provider === 'openai') out = await callOpenAI(model, system, messages, maxTokens);
        else if (provider === 'anthropic') out = await callAnthropic(model, system, messages, maxTokens);
        else { send(500, { error: '알 수 없는 PROVIDER: ' + provider }); return; }

        out.provider = provider;
        send(200, out);
    } catch (err) {
        send(502, { error: (err && err.message) ? err.message : String(err) });
    }
}

/* ---------------- 서버 ---------------- */
http.createServer((req, res) => {
    const url = req.url || '/';

    if (url.startsWith('/api/ai')) {
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'POST 만 허용합니다.' }));
            return;
        }
        handleAi(req, res).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '서버 오류: ' + e.message }));
        });
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405); res.end(); return;
    }
    serveStatic(req, res, url);
}).listen(PORT, bindHost(), () => {
    const provider = pickProvider();
    const cli = pickCli();
    const host = bindHost();
    let how = '(설정 없음 — AI 대화 불가)';
    if (cli) {
        const st = cliInfo(cli);
        how = st.ok ? (st.label + ' 구독 중계  [' + st.bin + ']')
                    : (st.label + ' — 준비 안 됨: ' + st.error);
    } else if (provider) {
        how = provider + ' API 키';
    }
    console.log('');
    console.log('  ESMPL Analyzer 내부 서버');
    console.log('  ────────────────────────────────');
    console.log('  웹사이트   : http://localhost:' + PORT + '/');
    console.log('  AI 중계    : http://localhost:' + PORT + '/api/ai');
    console.log('  AI 방식    : ' + how);
    console.log('  파일 위치  : ' + ROOT);
    console.log('');
    console.log('  해석 창의 [서버 설정] 에 넣을 값:  /api/ai');
    console.log('  (이 서버에서 웹사이트를 함께 열면 주소를 길게 적을 필요가 없습니다)');
    console.log('');
    if (host === '127.0.0.1') {
        console.log('  이 PC 에서만 접속됩니다. 구독 CLI 중계는 혼자 쓰는 용도이므로');
        console.log('  다른 PC 에 열지 않습니다. 여러 사람이 쓰려면 API 키 방식을 쓰세요.');
    } else {
        console.log('  같은 네트워크의 다른 PC 에서도 접속됩니다. 외부 인터넷에는 노출하지 마세요.');
        console.log('  (이 서버에는 인증이 없어 주소를 아는 누구나 쓸 수 있습니다)');
    }
    console.log('');
});
