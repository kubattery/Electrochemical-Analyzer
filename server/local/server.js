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
import os from 'node:os';
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

/* ---------------- 다른 출처에서 부를 수 있게 ----------------
 * GitHub Pages 에 올라간 분석기에서 이 서버를 부르려면 CORS 가 열려 있어야 한다.
 * http://localhost 는 브라우저가 믿을 수 있는 출처로 보기 때문에, https 페이지에서
 * 불러도 혼합 콘텐츠로 막히지 않는다. 남는 것은 CORS 뿐이다.
 *
 * 다만 * 로 열지 않는다. 서버가 떠 있는 동안 아무 웹사이트나 이 중계를 통해
 * 구독을 쓸 수 있게 되기 때문이다. 허용할 출처만 적는다. */
const DEFAULT_ORIGINS = [
    'https://kubattery.github.io',
    'http://localhost:' + PORT,
    'http://127.0.0.1:' + PORT
];

function allowedOrigins() {
    const extra = (process.env.ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    // LAN 에 열었다면 이 서버 자신의 주소로 사이트를 여는 경우도 받아 준다
    const lan = bindHost() === '0.0.0.0'
        ? lanAddresses().map(ip => 'http://' + ip + ':' + PORT)
        : [];
    return DEFAULT_ORIGINS.concat(lan).concat(extra);
}

/* ---------------- 바깥에서 들어올 때의 암호 ----------------
 * LAN 에 열면 주소를 아는 누구나 이 중계로 구독을 쓸 수 있다. 특히 이 기기의
 * 주소가 사설 IP 가 아니라 공인 IP 면 교내망을 넘어 닿을 수도 있다. 그래서
 * 이 PC 밖에서 들어오는 요청에는 암호를 요구한다.
 *
 * 127.0.0.1 에서 오는 요청은 그대로 통과시킨다. 본인 기기에서 쓰는 길을
 * 번거롭게 만들 이유가 없고, 거기까지 왔다면 이미 이 PC 를 쓰고 있는 것이다. */
let aiToken = (process.env.AI_TOKEN || '').trim();

/* 만든 암호는 파일에 남겨 다음 실행에도 같은 것을 쓴다. 실행할 때마다 바뀌면
   다른 PC 에서 매번 주소를 다시 적어야 한다. 한 번 적으면 끝나게 한다. */
const TOKEN_FILE = path.join(HERE, '.ai-token');

function ensureToken() {
    if (bindHost() !== '0.0.0.0') return '';
    if (aiToken) return aiToken;                 // AI_TOKEN 으로 직접 준 경우
    try {
        const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (saved) { aiToken = saved; return aiToken; }
    } catch (e) { /* 아직 없다 */ }
    aiToken = Array.from({ length: 24 },
        () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');
    try { fs.writeFileSync(TOKEN_FILE, aiToken, 'utf8'); }
    catch (e) { console.log('  (암호를 파일에 남기지 못했습니다. 이번 실행에만 유효합니다)'); }
    return aiToken;
}

function isLoopback(req) {
    const a = (req.socket && req.socket.remoteAddress) || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** 통과시켜도 되는 요청인지. 통과면 null, 아니면 막을 사유. */
function tokenProblem(req) {
    if (!aiToken) return null;            // 암호를 안 쓰는 모드
    if (isLoopback(req)) return null;     // 이 PC 안에서 온 요청
    const q = (req.url || '').split('?')[1] || '';
    const given = new URLSearchParams(q).get('t')
        || req.headers['x-ai-token'] || '';
    if (given === aiToken) return null;
    return '이 서버는 바깥에서 들어올 때 암호를 요구합니다. 서버 창에 적힌 주소를 '
        + '(끝의 ?t=... 까지) 그대로 [서버 설정] 에 넣어 주세요.';
}

/** 사설 대역인지. 아니면 인터넷에 그대로 드러날 수 있는 주소다. */
function isPrivateIp(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4) return false;
    if (p[0] === 10) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    return false;
}

/* 같은 네트워크에서 쓸 때 안내할 주소. 다른 PC 에서는 서버의 IP 로 들어와야 하는데
   그 값을 사람이 ipconfig 로 찾게 두면 번거롭다. */
function lanAddresses() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const ni of ifaces[name] || []) {
            if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
        }
    }
    return out;
}

function corsFor(req) {
    const origin = req.headers.origin;
    if (!origin) return {};                     // 같은 출처이거나 브라우저가 아닌 호출
    if (allowedOrigins().indexOf(origin.replace(/\/+$/, '')) < 0) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
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
async function handleAi(req, res, cors) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
            res.writeHead(413, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '요청이 너무 큽니다.' }));
            return;
        }
        chunks.push(c);
    }

    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
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
        res.writeHead(code, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
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

    /* 해석 창이 '여기 중계가 있나' 를 물어 보는 통로. AI 를 부르지 않으므로
       가볍고, 구독 차례를 쓰지도 않는다. 이게 있어야 창이 주소를 묻지 않고
       알아서 좋은 쪽을 고를 수 있다. 암호를 요구하지 않는 이유는, 여기서
       알 수 있는 것이 '중계가 떠 있다' 와 제공자 이름뿐이기 때문이다.
       실제로 쓰려면 여전히 암호가 필요하다. */
    if (url.startsWith('/api/ai/ping')) {
        const cors = corsFor(req);
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
        const cli = pickCli();
        const st = cli ? cliInfo(cli) : null;
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: true,
            provider: pickProvider(),
            label: st ? (st.ok ? st.label : st.label + ' (준비 안 됨)') : (pickProvider() || null),
            ready: st ? !!st.ok : !!pickProvider(),
            needsToken: !!aiToken && !isLoopback(req)
        }));
        return;
    }

    if (url.startsWith('/api/ai')) {
        const cors = corsFor(req);
        if (req.method === 'OPTIONS') {
            // 허용하지 않는 출처면 헤더가 비어 브라우저가 알아서 막는다
            res.writeHead(204, cors); res.end(); return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'POST 만 허용합니다.' }));
            return;
        }
        const denied = tokenProblem(req);
        if (denied) {
            res.writeHead(401, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: denied }));
            return;
        }
        handleAi(req, res, cors).catch(e => {
            res.writeHead(500, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
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
    ensureToken();      // LAN 에 열었다면 암호를 준비한다
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
    console.log('  해석 창의 [서버 설정] 에 넣을 값');
    console.log('    이 서버에서 웹사이트를 열었다면 :  /api/ai');
    console.log('    GitHub Pages 에서 열었다면       :  http://localhost:' + PORT + '/api/ai');
    console.log('');
    console.log('  이 서버를 부를 수 있는 웹사이트');
    for (const o of allowedOrigins()) console.log('    ' + o);
    console.log('    목록에 없는 사이트가 부르면 브라우저가 막습니다. 서버가 켜져 있는 동안');
    console.log('    아무 사이트나 이 중계로 구독을 쓰지 못하게 하려는 것입니다.');
    console.log('    사이트를 다른 주소에서도 연다면 ALLOWED_ORIGINS 에 쉼표로 적으세요.');
    console.log('');
    if (host === '127.0.0.1') {
        console.log('  이 PC 에서만 접속됩니다. 구독 CLI 중계는 혼자 쓰는 용도이므로');
        console.log('  다른 PC 에 열지 않습니다. 여러 사람이 쓰려면 API 키 방식을 쓰세요.');
        console.log('  내 다른 PC 에서도 쓰려면 ALLOW_LAN=1 을 주고 실행하세요.');
    } else {
        const ips = lanAddresses();
        console.log('  다른 PC 에서 할 일 — 아래 두 줄이면 됩니다');
        if (ips.length) {
            for (const ip of ips) {
                console.log('');
                console.log('    1) 웹사이트를 이 주소로 엽니다');
                console.log('         http://' + ip + ':' + PORT + '/');
                console.log('    2) [서버 설정] 에 이 주소를 통째로 넣습니다');
                console.log('         http://' + ip + ':' + PORT + '/api/ai?t=' + aiToken);
            }
        } else {
            console.log('    (네트워크 주소를 찾지 못했습니다. ipconfig 로 IPv4 주소를 확인하세요)');
        }
        console.log('');
        console.log('  GitHub Pages 에서는 이 주소를 부를 수 없습니다. https 페이지가 http 를');
        console.log('  부르는 것은 localhost 만 예외이고 사설 IP 는 예외가 아니어서, 브라우저가');
        console.log('  막습니다. 그래서 1) 처럼 이 서버에서 웹사이트를 열어야 합니다.');
        console.log('');
        console.log('  끝의 ?t=... 는 바깥에서 들어올 때의 암호입니다. 이게 없으면 주소를 아는');
        console.log('  누구나 이 중계로 구독을 씁니다. 암호를 고정하려면 AI_TOKEN 을 주세요.');

        const open = ips.filter(ip => !isPrivateIp(ip));
        if (open.length) {
            console.log('');
            console.log('  [주의] ' + open.join(', ') + ' 는 사설 IP 가 아닙니다.');
            console.log('  방화벽 설정에 따라 교내망을 넘어 인터넷에서 닿을 수도 있는 주소입니다.');
            console.log('  쓰지 않을 때는 이 창을 닫아 서버를 꺼 두시는 편이 좋습니다.');
        }
    }
    console.log('');
});
