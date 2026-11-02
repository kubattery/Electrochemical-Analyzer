/* ============================================================================
 * Codex App Server 중계 — 프로세스를 띄워 두고 JSON-RPC 로 주고받는다.
 *
 *   웹 채팅 → /api/ai → (이 파일) → codex app-server → 답변 → 웹 채팅
 *
 * cli-bridge.js 의 exec 방식과 무엇이 다른가
 *  · exec 은 질문마다 프로세스를 새로 띄우고 인증을 다시 확인한다. 그래서 느리다.
 *    이쪽은 한 번 띄워 두고 계속 쓴다.
 *  · 대화가 스레드로 남아 있어, 이어지는 질문은 새로 한 말만 보내면 된다.
 *
 * 쓸 수 있는 경우는 exec 방식과 같다. 혼자, 본인 기기에서, 본인 구독으로 쓰는
 * 것이다. 그래서 이 모드에서도 서버는 127.0.0.1 에만 붙는다.
 *
 * 와이어 형식은 줄 단위 JSON 이다. jsonrpc 멤버는 생략해 보내고, 들어오는 쪽에
 * 있으면 그냥 무시한다.
 * ========================================================================== */

import { spawnCli, whichCli } from './cli-bridge.js';

const NL = String.fromCharCode(10);

export const APP_BIN = process.env.AI_CLI_PATH || 'codex';
export const APP_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS) || 180000;
export const APP_SANDBOX = process.env.CODEX_SANDBOX || 'read-only';

/* 승인 요청은 거절한다. 여기서 하는 일은 글 해석이라 파일을 고치거나 명령을 돌릴
   이유가 없다. 무엇보다 응답하지 않으면 턴이 영원히 멈춘다. */
function isApprovalMethod(m) {
    return typeof m === 'string' && m.toLowerCase().indexOf('approval') >= 0;
}

export function appStatus() {
    const resolved = whichCli(APP_BIN);
    if (!resolved) {
        return {
            ok: false, label: 'Codex App Server', bin: APP_BIN,
            error: 'Codex CLI 실행파일을 찾지 못했습니다. 설치: npm i -g @openai/codex'
                + ' / 로그인: codex login'
                + ' / 경로를 직접 지정하려면 AI_CLI_PATH 환경변수를 쓰세요.'
        };
    }
    return { ok: true, label: 'Codex App Server', bin: resolved };
}

/* ---------------- 연결 하나 ---------------- */
class AppServer {
    constructor(bin) {
        this.bin = bin;
        this.child = null;
        this.buf = '';
        this.nextId = 1;
        this.waiting = new Map();      // id -> {resolve, reject}
        this.ready = null;             // 핸드셰이크 Promise
        this.dead = false;
        this.deadReason = '';
        this.stderr = '';
        this.turn = null;              // 지금 진행 중인 턴의 수집 상태
    }

    start() {
        if (this.ready) return this.ready;
        const args = process.env.AI_CLI_ARGS
            ? process.env.AI_CLI_ARGS.split(' ').filter(Boolean)
            : ['app-server'];
        try {
            this.child = spawnCli(this.bin, args);
        } catch (e) {
            this.dead = true;
            this.deadReason = 'Codex 실행에 실패했습니다: ' + e.message;
            return Promise.reject(new Error(this.deadReason));
        }

        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stdout.on('data', d => this.onData(d));
        this.child.stderr.on('data', d => {
            this.stderr += d;
            if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
        });
        this.child.on('error', e => this.die('Codex 실행에 실패했습니다: ' + e.message));
        this.child.on('close', code => this.die('Codex app-server 가 종료되었습니다 (코드 '
            + code + ')' + (this.stderr.trim() ? ': ' + this.stderr.trim().slice(0, 400) : '')));

        this.ready = this.handshake();
        return this.ready;
    }

    async handshake() {
        await this.request('initialize', {
            clientInfo: { name: 'esmpl-analyzer', title: 'ESMPL Analyzer', version: '1.0.0' },
            capabilities: {
                experimentalApi: false,
                // 추론 중계는 받지 않는다. 답변 본문만 쓰면 된다.
                optOutNotificationMethods: [
                    'item/reasoning/summaryTextDelta',
                    'item/reasoning/summaryPartAdded',
                    'item/reasoning/textDelta'
                ]
            }
        });
        this.notify('initialized', {});
    }

    die(reason) {
        if (this.dead) return;
        this.dead = true;
        this.deadReason = reason;
        for (const [, w] of this.waiting) w.reject(new Error(reason));
        this.waiting.clear();
        if (this.turn) { this.turn.fail(new Error(reason)); this.turn = null; }
    }

    stop() {
        if (!this.child) return;
        try { this.child.stdin.end(); } catch (e) { /* 이미 닫힘 */ }
        try { this.child.kill(); } catch (e) { /* 이미 죽음 */ }
    }

    send(obj) {
        if (this.dead) throw new Error(this.deadReason || 'Codex 연결이 끊어졌습니다.');
        this.child.stdin.write(JSON.stringify(obj) + NL, 'utf8');
    }

    notify(method, params) {
        this.send({ method, params: params || {} });
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.waiting.set(id, { resolve, reject });
            try { this.send({ id, method, params: params || {} }); }
            catch (e) { this.waiting.delete(id); reject(e); }
        });
    }

    /* 줄 단위로 끊어 읽는다. stdout 조각은 줄 경계에 맞춰 오지 않는다. */
    onData(chunk) {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf(NL)) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); }
            catch (e) { continue; }      // 로그 줄 등은 넘긴다
            this.onMessage(msg);
        }
    }

    onMessage(msg) {
        // 우리가 보낸 요청의 응답
        if (msg.id !== undefined && msg.method === undefined) {
            const w = this.waiting.get(msg.id);
            if (!w) return;
            this.waiting.delete(msg.id);
            if (msg.error) {
                const e = msg.error;
                w.reject(new Error('Codex 오류 ' + (e.code != null ? e.code : '') + ': '
                    + (e.message || JSON.stringify(e))));
            } else {
                w.resolve(msg.result);
            }
            return;
        }
        // 서버가 우리에게 보내는 요청 — 반드시 답해야 멈추지 않는다
        if (msg.id !== undefined && msg.method !== undefined) {
            if (isApprovalMethod(msg.method)) {
                this.send({ id: msg.id, result: { decision: 'denied' } });
            } else {
                this.send({ id: msg.id, error: { code: -32601, message: 'not supported' } });
            }
            return;
        }
        // 알림
        if (msg.method !== undefined) this.onNotify(msg.method, msg.params || {});
    }

    onNotify(method, p) {
        const t = this.turn;
        if (!t) return;
        if (p.turnId && t.turnId && p.turnId !== t.turnId) return;

        if (method === 'item/agentMessage/delta') {
            if (typeof p.text === 'string') t.deltas += p.text;
            return;
        }
        if (method === 'item/completed') {
            const txt = itemText(p.item);
            if (txt) t.items.push(txt);
            return;
        }
        if (method === 'turn/completed') { t.done(); return; }
        if (method === 'turn/failed' || method === 'turn/aborted') {
            const why = (p.error && p.error.message) || method;
            t.fail(new Error('Codex 턴이 끝나지 못했습니다: ' + why));
        }
    }
}

/* 완료된 항목에서 글을 꺼낸다. 어시스턴트 발언만 쓴다.
   표기가 agentMessage 인지 agent_message 인지 가리지 않도록 글자만 남겨 견준다. */
function normType(v) {
    let s = '';
    for (const ch of String(v == null ? '' : v).toLowerCase()) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) s += ch;
    }
    return s;
}

export function itemText(item) {
    if (!item || typeof item !== 'object') return '';
    const type = normType(item.type || item.itemType || '');
    if (type && type.indexOf('agentmessage') < 0) return '';
    if (typeof item.text === 'string' && item.text.trim()) return item.text;
    if (Array.isArray(item.content)) {
        const parts = item.content
            .filter(c => c && (c.type === 'text' || c.type === 'output_text') && typeof c.text === 'string')
            .map(c => c.text);
        if (parts.length) return parts.join('');
    }
    return '';
}

/* ---------------- 하나만 띄워 두고 다시 쓴다 ---------------- */
let conn = null;
let thread = null;      // { id, system, messages } — 어디까지 보냈는지 기억한다
let chain = Promise.resolve();

function serialize(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
}

async function getConn() {
    if (conn && conn.dead) { conn = null; thread = null; }
    if (!conn) {
        const st = appStatus();
        if (!st.ok) throw new Error(st.error);
        conn = new AppServer(st.bin);
    }
    await conn.start();
    return conn;
}

/* 이번 요청이 지난번 대화를 그대로 이어받은 것인지 본다. 그렇다면 스레드를 다시
   쓰고 새로 한 말만 보낸다. 조금이라도 다르면 스레드를 새로 연다. 틀리게 이어서
   앞 대화를 중복으로 보내는 것보다, 새로 여는 쪽이 안전하다. */
function continueReason(system, messages) {
    if (!thread) return '이전 스레드 없음';
    if (thread.system !== system) return '지침이 바뀜';
    const prev = thread.messages;
    if (messages.length <= prev.length) {
        return '대화가 늘지 않음 (이전 ' + prev.length + ', 지금 ' + messages.length + ')';
    }
    for (let i = 0; i < prev.length; i++) {
        if (prev[i].role !== messages[i].role) return i + '번째 역할이 다름';
        if (String(prev[i].content) !== String(messages[i].content)) {
            return i + '번째 내용이 다름'
                + ' | 보낸 것: ' + JSON.stringify(String(prev[i].content).slice(0, 60))
                + ' | 받은 것: ' + JSON.stringify(String(messages[i].content).slice(0, 60));
        }
    }
    return null;      // 이어받을 수 있다
}

function continues(system, messages) {
    const why = continueReason(system, messages);
    if (why && process.env.AI_DEBUG === '1') {
        console.log('  [codex-app] 스레드를 새로 엶 — ' + why);
    }
    return !why;
}

function transcript(msgs) {
    const out = [];
    for (const m of msgs) {
        const who = m.role === 'assistant' ? '어시스턴트' : '사용자';
        out.push(who + ': ' + String(m.content == null ? '' : m.content).trim(), '');
    }
    return out.join(NL).trim();
}

export function resetThread() { thread = null; }

export function stopApp() {
    if (conn) { conn.stop(); conn = null; }
    thread = null;
}

export function askApp(model, system, messages) {
    return serialize(async () => {
        const c = await getConn();

        const resume = continues(system, messages);
        let input;
        if (resume) {
            // 이어지는 대화 — 새로 한 말만 보낸다
            input = transcript(messages.slice(thread.messages.length));
        } else {
            const parts = [];
            if (system && system.trim()) parts.push('[역할과 지침]', system.trim(), '');
            if (messages.length > 1) parts.push('[지금까지의 대화]', transcript(messages.slice(0, -1)), '');
            const last = messages[messages.length - 1];
            parts.push('[사용자의 질문]',
                String(last && last.content != null ? last.content : '').trim(), '');
            parts.push('위 질문에 어시스턴트로서 답하십시오. 답변 본문만 출력하고, 머리말이나 해설은 붙이지 마십시오.');
            input = parts.join(NL);

            const started = await c.request('thread/start', {
                cwd: '.',
                sandbox: APP_SANDBOX,
                ...(model ? { model } : {})
            });
            const id = started && (started.threadId || started.thread_id
                || (started.thread && started.thread.id));
            if (!id) throw new Error('Codex 가 스레드를 열지 못했습니다.');
            thread = { id, system, messages: [] };
        }

        const text = await runTurn(c, thread.id, input, model);
        thread.messages = messages.concat([{ role: 'assistant', content: text }]);
        return {
            text,
            model: model || '(Codex 기본값)',
            cli: 'codex-app',
            label: 'Codex App Server' + (resume ? ' · 대화 이어받음' : ''),
            threadId: thread.id
        };
    });
}

function runTurn(c, threadId, input, model) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const state = {
            turnId: null, deltas: '', items: [],
            done: () => {
                if (settled) return;
                settled = true; clearTimeout(timer); c.turn = null;
                const text = (state.items.join(NL).trim() || state.deltas.trim());
                if (!text) reject(new Error('Codex 가 빈 답을 돌려주었습니다.'));
                else resolve(text);
            },
            fail: (e) => {
                if (settled) return;
                settled = true; clearTimeout(timer); c.turn = null;
                reject(e);
            }
        };

        const timer = setTimeout(() => {
            state.fail(new Error('Codex 응답이 ' + Math.round(APP_TIMEOUT_MS / 1000)
                + '초 안에 오지 않아 중단했습니다. 로그인이 만료되었을 수 있습니다. '
                + '터미널에서 codex login 을 확인해 주세요.'));
            // 다음 요청은 새 연결로 시작한다. 멈춘 프로세스를 계속 쓰지 않는다.
            stopApp();
        }, APP_TIMEOUT_MS);

        c.turn = state;
        const params = {
            threadId,
            input: [{ type: 'text', text: input }],
            sandbox: APP_SANDBOX,
            ...(model ? { model } : {}),
            ...(process.env.CODEX_EFFORT ? { effort: process.env.CODEX_EFFORT } : {})
        };
        c.request('turn/start', params).then(r => {
            if (r && (r.turnId || r.turn_id)) state.turnId = r.turnId || r.turn_id;
        }, e => state.fail(e));
    });
}
