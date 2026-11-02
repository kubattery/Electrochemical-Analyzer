/* ============================================================================
 * 구독 CLI 중계 — 웹 채팅의 질문을 로컬에 로그인된 CLI 로 넘기고 답을 돌려준다.
 *
 *   웹 채팅 → /api/ai → (이 파일) → claude -p / codex exec → 답변 → 웹 채팅
 *
 * 쓸 수 있는 경우와 아닌 경우를 분명히 해 둔다.
 *  · 본인이 혼자, 본인 기기에서, 본인 구독으로 본인 질문을 넘기는 것은
 *    두 CLI 가 공식으로 제공하는 비대화형 실행을 쓰는 것이다.
 *  · 좌석 하나를 여러 사람의 요청을 받는 공용 중계로 돌리는 것은 다른 얘기다.
 *    그래서 CLI 모드에서는 서버가 127.0.0.1 에만 붙는다. ALLOW_LAN=1 로 풀 수
 *    있게 두었지만 그때는 본인 판단이다. 정책을 글로만 적지 않고 동작으로 묶는다.
 *
 * [주의] 이 파일에는 역슬래시를 한 글자도 쓰지 않는다.
 *  이 작업 환경은 파일을 쓸 때 역슬래시 두 개를 하나로 줄인다. 그 탓에 정규식과
 *  Windows 경로가 조용히 깨진 적이 여러 번 있었다. 경로 조립은 path 모듈에
 *  맡기고, 역슬래시가 필요한 자리는 BS 상수로 만들어 쓴다. 검사로 강제한다.
 * ========================================================================== */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BS = String.fromCharCode(92);     // 역슬래시
const NL = String.fromCharCode(10);
const DQ = String.fromCharCode(34);

export const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS) || 180000;

/* ---------------- CLI 별 실행 방법 ----------------
 * 프롬프트는 어느 쪽이든 stdin 으로 넘긴다. 명령줄에 싣지 않는 이유는 두 가지다.
 * 길이 제한에 걸리지 않고, 사용자가 쓴 글이 명령줄에 닿지 않는다.
 * 플래그가 바뀌면 AI_CLI_ARGS 로 덮어쓸 수 있어 코드를 고칠 필요가 없다. */
export const CLI_SPECS = {
    claude: {
        label: 'Claude Code',
        bin: 'claude',
        install: 'npm i -g @anthropic-ai/claude-code',
        login: 'claude  (처음 한 번 실행해 구독 계정으로 로그인)',
        buildArgs(model) {
            const a = ['-p', '--output-format', 'json'];
            if (model) a.push('--model', model);
            return a;
        }
    },
    codex: {
        label: 'Codex CLI',
        bin: 'codex',
        install: 'npm i -g @openai/codex',
        login: 'codex login',
        buildArgs(model) {
            const a = ['exec', '--json'];
            if (model) a.push('--model', model);
            a.push('-');                 // 프롬프트를 stdin 에서 읽는다
            return a;
        }
    }
};

/* ---------------- 인수 검사 ----------------
 * 명령줄에 실리는 값은 설정에서 온 것뿐이지만, 모델 이름은 요청 본문으로도
 * 들어올 수 있다. 통과 글자를 좁게 묶어 둔다. */
const ALLOWED_ARG = (() => {
    let s = '';
    for (let c = 48; c <= 57; c++) s += String.fromCharCode(c);    // 0-9
    for (let c = 65; c <= 90; c++) s += String.fromCharCode(c);    // A-Z
    for (let c = 97; c <= 122; c++) s += String.fromCharCode(c);   // a-z
    return s + '_-.@:/+=,';
})();

export function isSafeArg(v) {
    if (typeof v !== 'string' || !v.length) return false;
    for (const ch of v) if (ALLOWED_ARG.indexOf(ch) < 0) return false;
    return true;
}

/* ---------------- 실행파일 찾기 ---------------- */
export function whichCli(bin) {
    if (!bin) return null;
    const hasSep = bin.indexOf('/') >= 0 || bin.indexOf(BS) >= 0;
    if (path.isAbsolute(bin) || hasSep) {
        try { return fs.statSync(bin).isFile() ? bin : null; } catch (e) { return null; }
    }
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    for (const d of dirs) {
        const cands = process.platform === 'win32'
            ? exts.flatMap(e => [bin + e.toLowerCase(), bin + e.toUpperCase(), bin + e])
            : [bin];
        for (const c of cands) {
            const p = path.join(d, c);
            try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* 다음 후보 */ }
        }
    }
    return null;
}

/* ---------------- 프롬프트 조립 ----------------
 * CLI 한 번 실행은 한 번의 질문이라서 대화가 이어지지 않는다. 그래서 지금까지의
 * 대화를 글로 풀어 매번 함께 넘긴다. CLI 쪽 세션 기능에 기대지 않는 편이
 * 끊길 거리가 적다. */
export function buildPrompt(system, messages) {
    const out = [];
    if (system && system.trim()) {
        out.push('[역할과 지침]', system.trim(), '');
    }
    if (messages.length > 1) out.push('[지금까지의 대화]');
    const last = messages[messages.length - 1];
    for (const m of messages.slice(0, -1)) {
        const who = m.role === 'assistant' ? '어시스턴트' : '사용자';
        out.push(who + ': ' + String(m.content == null ? '' : m.content).trim(), '');
    }
    out.push('[사용자의 질문]', String(last && last.content != null ? last.content : '').trim(), '');
    out.push('위 질문에 어시스턴트로서 답하십시오. 답변 본문만 출력하고, 머리말이나 해설은 붙이지 마십시오.');
    return out.join(NL);
}

/* ---------------- 출력에서 답변 끌어내기 ----------------
 * CLI 가 어떤 모양으로 내보내든 글을 건져낸다. 단일 JSON, 이벤트 JSONL, 그냥 글
 * 세 가지를 모두 받는다. 출력 형식이 바뀌어도 조용히 빈 답이 되지 않게 함이다. */
function pickText(o, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 6) return '';
    for (const k of ['result', 'text', 'content', 'message', 'msg', 'delta', 'item', 'response']) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) return v;
        if (Array.isArray(v)) {
            const parts = v
                .map(e => (typeof e === 'string' ? e : pickText(e, (depth || 0) + 1)))
                .filter(s => s && s.trim());
            if (parts.length) return parts.join('');
        }
        if (v && typeof v === 'object') {
            const t = pickText(v, (depth || 0) + 1);
            if (t) return t;
        }
    }
    return '';
}

const CLI_ERR_PREFIX = 'CLI 가 오류를 보고했습니다: ';

export function extractAnswer(stdout) {
    const raw = String(stdout == null ? '' : stdout).trim();
    if (!raw) return '';
    try {
        const o = JSON.parse(raw);
        if (o && o.is_error === true) {
            throw new Error(CLI_ERR_PREFIX + (pickText(o) || '내용 없음'));
        }
        const t = pickText(o);
        if (t) return t.trim();
    } catch (e) {
        if (e instanceof Error && e.message.indexOf(CLI_ERR_PREFIX) === 0) throw e;
    }
    // 이벤트 스트림 — 마지막으로 나온 글을 답으로 본다
    let last = '';
    for (const ln of raw.split(NL)) {
        const s = ln.trim();
        if (!s || s[0] !== '{') continue;
        try {
            const t = pickText(JSON.parse(s));
            if (t && t.trim()) last = t;
        } catch (e) { /* JSON 아닌 줄은 넘긴다 */ }
    }
    if (last) return last.trim();
    return raw;
}

/* ---------------- 프로세스 띄우기 ---------------- */
export function spawnCli(binPath, args) {
    const low = binPath.toLowerCase();
    const isBatch = low.endsWith('.cmd') || low.endsWith('.bat');
    if (process.platform === 'win32' && isBatch) {
        // Node 는 보안 수정 이후 .cmd 를 직접 실행하지 못한다. cmd.exe 로 감싼다.
        // 프롬프트는 stdin 으로만 가고 인수는 검사를 통과한 설정값뿐이므로
        // 명령줄에 사용자 입력이 섞일 자리가 없다.
        const inner = DQ + binPath + DQ + (args.length ? ' ' + args.join(' ') : '');
        return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', DQ + inner + DQ], {
            windowsVerbatimArguments: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
    }
    return spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function hardKill(child) {
    if (process.platform === 'win32' && child.pid) {
        // cmd.exe 를 죽여도 그 밑의 CLI 가 남을 수 있어 트리째 정리한다.
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
        catch (e) { try { child.kill(); } catch (e2) { /* 이미 죽음 */ } }
        return;
    }
    try { child.kill('SIGKILL'); } catch (e) { /* 이미 죽음 */ }
}

/* 한 사람이 쓰는 전제이고 CLI 한 번 실행이 무겁다. 동시에 띄우지 않고 줄을 세운다. */
let chain = Promise.resolve();
function serialize(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
}

export function cliStatus(cliName) {
    const spec = CLI_SPECS[cliName];
    if (!spec) return { ok: false, error: '알 수 없는 CLI: ' + cliName };
    const bin = process.env.AI_CLI_PATH || spec.bin;
    const resolved = whichCli(bin);
    if (!resolved) {
        return {
            ok: false, label: spec.label, bin,
            error: spec.label + ' 실행파일을 찾지 못했습니다. 설치: ' + spec.install
                + ' / 로그인: ' + spec.login
                + ' / 경로를 직접 지정하려면 AI_CLI_PATH 환경변수를 쓰세요.'
        };
    }
    return { ok: true, label: spec.label, bin: resolved };
}

export function callCli(cliName, model, system, messages) {
    return serialize(() => new Promise((resolve, reject) => {
        const spec = CLI_SPECS[cliName];
        if (!spec) return reject(new Error('알 수 없는 CLI: ' + cliName));

        const st = cliStatus(cliName);
        if (!st.ok) return reject(new Error(st.error));

        let args;
        if (process.env.AI_CLI_ARGS) {
            args = process.env.AI_CLI_ARGS.split(' ').filter(Boolean);
        } else {
            if (model && !isSafeArg(model)) {
                return reject(new Error('모델 이름에 허용되지 않는 글자가 있습니다.'));
            }
            args = spec.buildArgs(model);
        }
        const bad = args.filter(a => !isSafeArg(a));
        if (bad.length) {
            return reject(new Error('CLI 인수에 허용되지 않는 글자가 있습니다: ' + bad.join(', ')));
        }

        const prompt = buildPrompt(system, messages);
        let child;
        try { child = spawnCli(st.bin, args); }
        catch (e) { return reject(new Error(st.label + ' 실행에 실패했습니다: ' + e.message)); }

        let out = '', err = '', done = false;
        const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };

        const timer = setTimeout(() => {
            hardKill(child);
            finish(reject, new Error(st.label + ' 응답이 '
                + Math.round(CLI_TIMEOUT_MS / 1000) + '초 안에 오지 않아 중단했습니다. '
                + '로그인이 만료되어 입력을 기다리는 중일 수 있습니다. 터미널에서 '
                + spec.bin + ' 을 한 번 실행해 확인해 주세요.'));
        }, CLI_TIMEOUT_MS);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });

        child.on('error', e => {
            hardKill(child);
            finish(reject, new Error(st.label + ' 실행에 실패했습니다: ' + e.message));
        });

        child.on('close', code => {
            if (code !== 0 && !out.trim()) {
                const why = err.trim() || ('종료 코드 ' + code);
                return finish(reject, new Error(st.label + ' 가 실패했습니다: ' + why.slice(0, 500)));
            }
            let text;
            try { text = extractAnswer(out); }
            catch (e) { return finish(reject, e); }
            if (!text) {
                return finish(reject, new Error(st.label + ' 가 빈 답을 돌려주었습니다.'
                    + (err.trim() ? ' stderr: ' + err.trim().slice(0, 300) : '')));
            }
            finish(resolve, { text, model: model || '(CLI 기본값)', cli: cliName, label: st.label });
        });

        // 프롬프트는 여기서만 넘어간다. 명령줄에는 닿지 않는다.
        child.stdin.on('error', () => { /* 이미 닫힌 경우 무시 */ });
        child.stdin.end(prompt, 'utf8');
    }));
}
