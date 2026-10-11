/**
 * CDP 版(零依赖版): 把 ./scripts 目录下的所有 .js 注入到 Electron 应用(127.0.0.1:9222)的每个页面
 * 依赖: 仅需 Node.js >= 22 (使用原生 WebSocket / fetch), 无需 npm install
 *
 * 特性:
 *  - Target.setAutoAttach + waitForDebuggerOnStart: 新页面创建时先暂停, 注入完成后再放行,
 *    保证脚本先于页面所有业务代码/请求执行 (等价于油猴 document-start)
 *  - 启动前已打开的页面: 注册脚本后立即补执行一次, 无需手动刷新
 *  - 热重载: 新增 / 修改 / 删除 scripts 目录下的文件自动同步
 *  - 保存时语法预检: 有语法错误的版本不会生效, 继续沿用上一个可用版本
 *
 * 脚本格式: 纯 .js 文件, 文件头部的注释块里可声明匹配规则(可选, 不写则对所有页面生效):
 *   // @match https://example.com/*
 *
 * 注意: 每个脚本会被包在一个块作用域 { ... } 里执行, 因此顶层的 let/const/class
 *       不会泄漏到全局, 热更新时重复执行也不会报"重复声明"。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = 9222;
const SCAN_INTERVAL = 1000;
const SETTLE_MS = 300;          // 文件最后修改后需静置这么久才读取, 避免读到编辑器写了一半的内容
const CDP_TIMEOUT = 3000;
const SCRIPT_DIR = process.argv[2] || path.join(__dirname, 'scripts');

// 对已打开页面/热更新时是否使用 Page.addScriptToEvaluateOnNewDocument 的 runImmediately 参数
// (实验性, 会进入所有已存在的 frame)。默认 false: 退回到仅在主 frame 上 Runtime.evaluate。
// 确认你的 Electron 对应 Chromium 版本支持后再改为 true。
const USE_RUN_IMMEDIATELY = false;

// 需要注入的 target 类型; Electron 的 <webview> 类型为 'webview'
const INJECT_TYPES = new Set(['page', 'webview']);
const SKIP_URL = /^(devtools:|chrome-extension:|chrome:)/;

// ---------- 脚本加载与匹配 ----------

// 只解析文件头部连续的注释块里的 @match, 正文里出现的不算
function parseMatches(code) {
    const out = [];
    const collect = t => {
        const m = t.match(/^(?:\/\/|\/?\*+)?\s*@match\s+(\S+)/);
        if (m) out.push(m[1]);
    };
    let inBlock = false;
    for (const line of code.split(/\r?\n/)) {
        const t = line.trim();
        if (inBlock) {
            collect(t);
            if (t.includes('*/')) inBlock = false;
            continue;
        }
        if (t === '') continue;
        if (t.startsWith('//')) { collect(t); continue; }
        if (t.startsWith('/*')) {
            collect(t);
            if (!t.includes('*/')) inBlock = true;
            continue;
        }
        break; // 遇到第一行代码, 头部结束
    }
    return out;
}

function toRegExpSource(p) {
    return p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
}

// 把 @match 规则编译进脚本源码, 在页面运行时判断, 避免注册时 url 还是 about:blank 导致漏判。
// 用 JSON.stringify 生成字符串字面量, 保证转义正确; sourceURL 让 DevTools 里能看到脚本名。
function buildSource(name, code, matches) {
    const tail = `\n//# sourceURL=cdp-inject/${name}`;
    if (!matches.length) return `{\n${code}\n}${tail}`;
    const tests = matches
        .map(p => `new RegExp(${JSON.stringify('^' + toRegExpSource(p) + '$')}).test(location.href)`)
        .join(' || ');
    return `if (${tests}) {\n${code}\n}${tail}`;
}

const fileCache = new Map(); // name -> { sig, script }  (script 为最近一次通过语法检查的版本)

function loadScripts() {
    let names;
    try {
        names = fs.readdirSync(SCRIPT_DIR).filter(f => f.endsWith('.js')).sort();
    } catch (e) {
        console.error('[!] 读取脚本目录失败:', e.message);
        return [...fileCache.values()].map(c => c.script).filter(Boolean);
    }
    const alive = new Set(names);
    for (const name of [...fileCache.keys()]) if (!alive.has(name)) fileCache.delete(name);

    const result = [];
    for (const name of names) {
        const file = path.join(SCRIPT_DIR, name);
        const cached = fileCache.get(name);
        let st;
        try { st = fs.statSync(file); } catch (e) { continue; }
        const sig = `${st.mtimeMs}:${st.size}`;

        if (cached && cached.sig === sig) {
            if (cached.script) result.push(cached.script);
            continue;
        }
        // 刚被修改, 先等一等, 期间继续使用旧版本
        if (Date.now() - st.mtimeMs < SETTLE_MS) {
            if (cached && cached.script) result.push(cached.script);
            continue;
        }

        let script = cached ? cached.script : null;
        try {
            const code = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
            new vm.Script(code, { filename: name }); // 仅做语法预检, 不执行
            const matches = parseMatches(code);
            const source = buildSource(name, code, matches);
            const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
            script = { name, code, matches, source, key: `${name}#${hash}` };
        } catch (e) {
            console.error(`[!] ${name} 无法加载${script ? ', 继续使用上一个可用版本' : ', 已跳过'}: ${e.message}`);
        }
        fileCache.set(name, { sig, script });
        if (script) result.push(script);
    }
    return result;
}

function logChanges(prev, next) {
    const p = new Map(prev.map(s => [s.name, s.key]));
    const n = new Map(next.map(s => [s.name, s.key]));
    for (const [name, key] of n) {
        if (!p.has(name)) console.log(`[i] 已加载脚本: ${name}`);
        else if (p.get(name) !== key) console.log(`[*] 脚本已更新: ${name}`);
    }
    for (const name of p.keys()) if (!n.has(name)) console.log(`[-] 脚本已移除: ${name}`);
}

// ---------- 基础通信 ----------

async function httpGetJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// 极简 CDP 客户端: send(method, params, sessionId) => Promise; 事件经 client.onEvent 分发
function connectCdp(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let nextId = 1;
        let opened = false;
        const pending = new Map();
        const timer = setTimeout(() => {
            if (!opened) { try { ws.close(); } catch (e) { /* noop */ } reject(new Error('WebSocket 连接超时')); }
        }, 3000);
        const client = {
            send(method, params = {}, sessionId) {
                return new Promise((res, rej) => {
                    const id = nextId++;
                    pending.set(id, { res, rej });
                    const msg = { id, method, params };
                    if (sessionId) msg.sessionId = sessionId;
                    try { ws.send(JSON.stringify(msg)); } catch (e) { pending.delete(id); rej(e); }
                });
            },
            close() { try { ws.close(); } catch (e) { /* noop */ } },
            onEvent: null,
            onclose: null,
        };
        ws.onopen = () => { opened = true; clearTimeout(timer); resolve(client); };
        ws.onerror = () => { if (!opened) { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); } };
        ws.onmessage = ev => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (msg.id && pending.has(msg.id)) {
                const p = pending.get(msg.id);
                pending.delete(msg.id);
                msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
            } else if (msg.method && client.onEvent) {
                try {
                    client.onEvent(msg.method, msg.params);
                } catch (e) {
                    console.error('[!] 事件处理异常:', e.message);
                }
            }
        };
        ws.onclose = () => {
            clearTimeout(timer);
            for (const p of pending.values()) p.rej(new Error('连接已关闭'));
            pending.clear();
            if (client.onclose) client.onclose();
        };
    });
}

// ---------- 注入状态 ----------

let bc = null;                 // 浏览器级连接
let scriptList = [];           // 当前脚本列表
// sessionId -> { ready, identifiers: Map(key -> { id, name }) }
const sessions = new Map();
const preExisting = new Set(); // 连接时已存在、尚未首次 attach 的页面 targetId

// ---------- 核心逻辑 ----------

// 带超时的发送: 连接异常时避免页面被无限期暂停
function sendT(method, params, sessionId, ms = CDP_TIMEOUT) {
    if (!bc) return Promise.reject(new Error('连接已断开'));
    let timer;
    const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`CDP 响应超时: ${method}`)), ms);
    });
    return Promise.race([bc.send(method, params, sessionId), timeout]).finally(() => clearTimeout(timer));
}

async function evalNow(sid, s) {
    const r = await sendT('Runtime.evaluate', { expression: s.source }, sid, 5000);
    if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        console.error(`[!] ${s.name} 执行异常:`, (d.exception && d.exception.description) || d.text);
    }
}

// 为 session 注册一个脚本; immediate=true 时同时让当前文档立即生效
async function registerScript(sid, sess, s, immediate) {
    const params = { source: s.source };
    if (immediate && USE_RUN_IMMEDIATELY) params.runImmediately = true;
    const { identifier } = await sendT('Page.addScriptToEvaluateOnNewDocument', params, sid);
    sess.identifiers.set(s.key, { id: identifier, name: s.name });
    if (immediate && !USE_RUN_IMMEDIATELY) {
        await evalNow(sid, s).catch(e => console.error(`[!] ${s.name} 立即执行失败:`, e.message));
    }
}

async function attachToTarget({ sessionId, targetInfo }) {
    if (!bc) return;
    const url = targetInfo.url || '';
    const injectable = INJECT_TYPES.has(targetInfo.type) && !SKIP_URL.test(url);
    if (!injectable) {
        // DevTools 窗口/worker 等不注入, 但必须立即放行, 否则控制台会卡住打不开
        await sendT('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        return;
    }

    // delete 的返回值即"是否为首次 attach 的已存在页面", 之后同 targetId 再 attach 不会重复补执行
    const pre = preExisting.delete(targetInfo.targetId);
    const sess = { ready: false, identifiers: new Map() };
    sessions.set(sessionId, sess);
    const list = scriptList; // 固定快照; 期间若脚本有变化, 就绪后由 sync 补齐差异

    let ok = true;
    try {
        await sendT('Page.enable', {}, sessionId);
        // 并行发出, CDP 按发送顺序处理, 所以注册顺序仍与 list 一致
        await Promise.all(list.map(s => registerScript(sessionId, sess, s, pre)));
    } catch (e) {
        ok = false;
        console.error('[!] 注册脚本失败:', e.message);
    } finally {
        sess.ready = true;
        await sendT('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
    if (ok) {
        console.log(pre
            ? `[+] 已接管已打开页面: ${url}`
            : `[+] 新页面已注入(document-start): ${url}`);
    }
}

async function syncSession(sid, sess, list) {
    const wanted = new Set(list.map(s => s.key));

    // 先注册新增/修改的脚本(避免出现"旧的已删、新的未加"的空窗)
    for (const s of list) {
        if (sess.identifiers.has(s.key)) continue;
        try {
            await registerScript(sid, sess, s, true);
        } catch (e) {
            console.error(`[!] 同步脚本 ${s.name} 失败:`, e.message);
        }
    }
    // 再移除已删除脚本 / 被编辑后的旧版本
    for (const [key, { id }] of [...sess.identifiers]) {
        if (wanted.has(key)) continue;
        await sendT('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, sid).catch(() => {});
        sess.identifiers.delete(key);
    }
}

async function syncScriptsToSessions() {
    const list = scriptList;
    const jobs = [];
    for (const [sid, sess] of sessions) {
        if (!sess.ready) continue; // 正在 attach 的 session 由 attachToTarget 负责
        jobs.push(syncSession(sid, sess, list).catch(e => console.error('[!] 同步失败:', e.message)));
    }
    await Promise.all(jobs);
}

async function connect() {
    let info;
    try {
        info = await httpGetJson(`http://${HOST}:${PORT}/json/version`);
    } catch (e) {
        return false; // 应用还没启动
    }
    let client;
    try {
        client = await connectCdp(info.webSocketDebuggerUrl);
    } catch (e) {
        return false;
    }
    bc = client;
    client.onEvent = (method, params) => {
        if (method === 'Target.attachedToTarget') {
            attachToTarget(params).catch(e => console.error('[!] attach 异常:', e.message));
        } else if (method === 'Target.detachedFromTarget') {
            sessions.delete(params.sessionId);
        } else if (method === 'Target.targetDestroyed') {
            preExisting.delete(params.targetId);
        }
    };
    client.onclose = () => {
        if (bc !== client) return; // 旧连接的迟到回调, 不要影响新连接
        console.log('[i] 连接已断开, 等待目标应用...');
        bc = null;
        sessions.clear();
        preExisting.clear();
    };
    try {
        const targets = await client.send('Target.getTargets');
        for (const t of targets.targetInfos) {
            if (INJECT_TYPES.has(t.type)) preExisting.add(t.targetId);
        }
        // 新页面创建时暂停, 等注入完成后再放行
        await client.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
        });
    } catch (e) {
        // 初始化失败就整体放弃, 下个周期重连; 不要留下一个半初始化的连接
        console.error('[!] 初始化失败:', e.message);
        client.close();
        if (bc === client) { bc = null; sessions.clear(); preExisting.clear(); }
        return false;
    }
    console.log('[i] 已连接目标应用, 等待页面...');
    return true;
}

let ticking = false;
async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const prev = scriptList;
        scriptList = loadScripts();
        logChanges(prev, scriptList);
        if (!bc && !(await connect())) return;
        await syncScriptsToSessions();
    } catch (e) {
        console.error('[!] 周期任务异常:', e && e.message);
    } finally {
        ticking = false;
        setTimeout(tick, SCAN_INTERVAL);
    }
}

function main() {
    fs.mkdirSync(SCRIPT_DIR, { recursive: true });
    console.log(`脚本目录: ${SCRIPT_DIR}`);
    console.log(`监听 CDP: http://${HOST}:${PORT} (Ctrl+C 退出)\n`);
    tick();
}

// 防止意外异常导致进程退出: 进程一旦退出, 处于"暂停等待注入"状态的页面会被永久卡死
process.on('uncaughtException', e => console.error('[!] 未捕获异常:', e && e.message));
process.on('unhandledRejection', e => console.error('[!] 未处理的Promise异常:', e && (e.message || e)));
process.on('SIGINT', () => { if (bc) bc.close(); process.exit(0); });

main();
