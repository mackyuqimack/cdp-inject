/**
 * CDP 版(零依赖版): 把 SCRIPT_DIR 目录下的所有 .js 注入到 Electron 应用
 * 依赖: Node.js >= 22 (原生 WebSocket / fetch), 无需 npm install
 *
 * 特性:
 *  - Target.setAutoAttach + waitForDebuggerOnStart: 新页面暂停后先注册脚本再放行
 *  - 已存在页面: 注册 document-start 脚本，并对当前文档立即补执行
 *  - 热重载: 新增 / 修改 / 删除 scripts 目录下的文件自动同步
 *  - 保存时语法预检: 有语法错误的版本不会生效, 继续沿用上一个可用版本
 *  - 启动时等待脚本文件写入稳定后再放行被暂停的页面
 *
 * 脚本格式: 纯 .js 文件, 文件头部注释块可声明匹配规则(可选):
 *   // @match https://example.com/*
 *
 * 注意: 每个脚本会被包在一个块作用域 { ... } 里执行, 顶层 let/const/class
 *       不会泄漏到全局, 热更新时重复执行也不会报重复声明。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = 9223;

const SCAN_INTERVAL = 1000;           // 已连接后的热更新扫描间隔
const CONNECT_RETRY_INTERVAL = 100;   // 未连接时每 100ms 检查一次 CDP
const SETTLE_MS = 300;                // 文件最后修改后需静置这么久才读取
const INITIAL_WAIT_MAX = 5000;        // 最多等待脚本文件稳定 5 秒
const CDP_TIMEOUT = 3000;

const SCRIPT_DIR = process.argv[2] || path.join(__dirname, 'scripts');

// 对热更新时是否使用 Page.addScriptToEvaluateOnNewDocument 的 runImmediately 参数。
// 默认 false: 通过 Runtime.evaluate 补执行当前文档, 兼容性更好。
const USE_RUN_IMMEDIATELY = false;

const INJECT_TYPES = new Set(['page', 'webview']);
const SKIP_URL = /^(devtools:|chrome-extension:|chrome:)/;


// ---------- 脚本加载与匹配 ----------

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

        if (t.startsWith('//')) {
            collect(t);
            continue;
        }

        if (t.startsWith('/*')) {
            collect(t);
            if (!t.includes('*/')) inBlock = true;
            continue;
        }

        break;
    }

    return out;
}


function toRegExpSource(p) {
    return p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
}


function buildSource(name, code, matches) {
    const tail = `\n//# sourceURL=cdp-inject/${name}`;

    if (!matches.length) {
        return `{\n${code}\n}${tail}`;
    }

    const tests = matches
        .map(p => `new RegExp(${JSON.stringify('^' + toRegExpSource(p) + '$')}).test(location.href)`)
        .join(' || ');

    return `if (${tests}) {\n${code}\n}${tail}`;
}


const fileCache = new Map();


function getScriptNames() {
    try {
        return fs.readdirSync(SCRIPT_DIR)
            .filter(f => f.endsWith('.js'))
            .sort();
    } catch (e) {
        console.error('[!] 读取脚本目录失败:', e.message);
        return null;
    }
}


// 判断当前目录中的 .js 文件是否全部越过静置期。
function scriptsAreSettled() {
    const names = getScriptNames();

    if (names === null) return true;

    const now = Date.now();

    for (const name of names) {
        try {
            const st = fs.statSync(path.join(SCRIPT_DIR, name));

            if (now - st.mtimeMs < SETTLE_MS) {
                return false;
            }
        } catch (_) {
            // 文件可能恰好被编辑器替换/删除, 下一轮再检查
            return false;
        }
    }

    return true;
}


function loadScripts() {
    const names = getScriptNames();

    if (names === null) {
        return [...fileCache.values()]
            .map(c => c.script)
            .filter(Boolean);
    }

    const alive = new Set(names);

    for (const name of [...fileCache.keys()]) {
        if (!alive.has(name)) fileCache.delete(name);
    }

    const result = [];

    for (const name of names) {
        const file = path.join(SCRIPT_DIR, name);
        const cached = fileCache.get(name);

        let st;

        try {
            st = fs.statSync(file);
        } catch (_) {
            continue;
        }

        const sig = `${st.mtimeMs}:${st.size}`;

        if (cached && cached.sig === sig) {
            if (cached.script) result.push(cached.script);
            continue;
        }

        // 刚被修改, 先继续使用旧版本; 新文件则暂不加载。
        if (Date.now() - st.mtimeMs < SETTLE_MS) {
            if (cached && cached.script) result.push(cached.script);
            continue;
        }

        let script = cached ? cached.script : null;

        try {
            const code = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

            // 语法预检, 不执行
            new vm.Script(code, {filename: name});

            const matches = parseMatches(code);
            const source = buildSource(name, code, matches);

            const hash = crypto.createHash('sha1')
                .update(source)
                .digest('hex')
                .slice(0, 12);

            script = {
                name,
                code,
                matches,
                source,
                key: `${name}#${hash}`
            };

        } catch (e) {
            console.error(
                `[!] ${name} 无法加载${script ? ', 继续使用上一个可用版本' : ', 已跳过'}:`,
                e.message
            );
        }

        fileCache.set(name, {sig, script});

        if (script) result.push(script);
    }

    return result;
}


function logChanges(prev, next) {
    const p = new Map(prev.map(s => [s.name, s.key]));
    const n = new Map(next.map(s => [s.name, s.key]));

    for (const [name, key] of n) {
        if (!p.has(name)) {
            console.log(`[i] 已加载脚本: ${name}`);
        } else if (p.get(name) !== key) {
            console.log(`[*] 脚本已更新: ${name}`);
        }
    }

    for (const name of p.keys()) {
        if (!n.has(name)) {
            console.log(`[-] 脚本已移除: ${name}`);
        }
    }
}


// 页面处于 waitForDebugger 状态时, 等待磁盘上的脚本文件稳定后再放行。
async function refreshScriptsWhenStable() {
    const deadline = Date.now() + INITIAL_WAIT_MAX;
    const prev = scriptList;

    while (Date.now() < deadline) {

        if (scriptsAreSettled()) {

            // 读取后再检查一次, 防止文件恰好在检查和读取之间被编辑。
            const next = loadScripts();

            if (scriptsAreSettled()) {
                scriptList = next;
                logChanges(prev, scriptList);
                return;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 25));
    }

    console.warn(
        '[!] 脚本文件持续变化, 等待超时; 将使用当前可用版本继续启动页面'
    );

    scriptList = loadScripts();
    logChanges(prev, scriptList);
}


// ---------- 基础通信 ----------

async function httpGetJson(url) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(1000)
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    return res.json();
}


// 极简 CDP 客户端
function connectCdp(wsUrl) {
    return new Promise((resolve, reject) => {

        const ws = new WebSocket(wsUrl);

        let nextId = 1;
        let opened = false;

        const pending = new Map();

        const timer = setTimeout(() => {
            if (!opened) {
                try {
                    ws.close();
                } catch (_) {
                }

                reject(new Error('WebSocket 连接超时'));
            }
        }, 3000);


        const client = {

            send(method, params = {}, sessionId) {

                return new Promise((res, rej) => {

                    const id = nextId++;

                    pending.set(id, {res, rej});

                    const msg = {
                        id,
                        method,
                        params
                    };

                    if (sessionId) {
                        msg.sessionId = sessionId;
                    }

                    try {
                        ws.send(JSON.stringify(msg));
                    } catch (e) {
                        pending.delete(id);
                        rej(e);
                    }
                });
            },

            close() {
                try {
                    ws.close();
                } catch (_) {
                }
            },

            onEvent: null,
            onclose: null
        };


        ws.onopen = () => {
            opened = true;
            clearTimeout(timer);
            resolve(client);
        };


        ws.onerror = () => {
            if (!opened) {
                clearTimeout(timer);
                reject(new Error('WebSocket 连接失败'));
            }
        };


        ws.onmessage = ev => {

            let msg;

            try {
                msg = JSON.parse(ev.data);
            } catch (_) {
                return;
            }

            if (msg.id && pending.has(msg.id)) {

                const p = pending.get(msg.id);

                pending.delete(msg.id);

                msg.error
                    ? p.rej(new Error(msg.error.message))
                    : p.res(msg.result);

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

            for (const p of pending.values()) {
                p.rej(new Error('连接已关闭'));
            }

            pending.clear();

            if (client.onclose) {
                client.onclose();
            }
        };
    });
}


// ---------- 注入状态 ----------

let bc = null;
let scriptList = [];

// sessionId -> { ready, identifiers }
const sessions = new Map();


// ---------- 核心逻辑 ----------

// 带超时的发送
function sendT(method, params, sessionId, ms = CDP_TIMEOUT) {

    if (!bc) {
        return Promise.reject(new Error('连接已断开'));
    }

    let timer;

    const timeout = new Promise((_, rej) => {
        timer = setTimeout(
            () => rej(new Error(`CDP 响应超时: ${method}`)),
            ms
        );
    });

    return Promise.race([
        bc.send(method, params, sessionId),
        timeout
    ]).finally(() => clearTimeout(timer));
}


// 立即执行脚本
async function evalNow(sid, s) {

    const r = await sendT(
        'Runtime.evaluate',
        {expression: s.source},
        sid,
        5000
    );

    if (r && r.exceptionDetails) {

        const d = r.exceptionDetails;

        console.error(
            `[!] ${s.name} 执行异常:`,
            (d.exception && d.exception.description) || d.text
        );
    }
}


// 注册一个脚本
async function registerScript(sid, sess, s, runImmediately = false) {

    const params = {
        source: s.source
    };

    if (runImmediately && USE_RUN_IMMEDIATELY) {
        params.runImmediately = true;
    }

    const result = await sendT(
        'Page.addScriptToEvaluateOnNewDocument',
        params,
        sid
    );

    if (!result || !result.identifier) {
        throw new Error('CDP 未返回脚本 identifier');
    }

    sess.identifiers.set(s.key, {
        id: result.identifier,
        name: s.name
    });
}


// 补执行当前文档
async function evalCurrentDocument(sid, s) {

    if (USE_RUN_IMMEDIATELY) return;

    await evalNow(sid, s).catch(e => {
        console.error(`[!] ${s.name} 立即执行失败:`, e.message);
    });
}


// ---------- 页面附加与注入 ----------

async function attachToTarget({
                                  sessionId,
                                  targetInfo,
                                  waitingForDebugger
                              }) {

    if (!bc) return;

    const url = (targetInfo && targetInfo.url) || '';
    const type = targetInfo && targetInfo.type;

    // 直接根据 CDP 返回的状态判断页面是否暂停
    const paused = waitingForDebugger === true;

    const injectable =
        INJECT_TYPES.has(type) &&
        !SKIP_URL.test(url);


    if (!injectable) {

        // 非注入目标也必须释放, 防止 DevTools / worker 一直停住
        if (paused) {
            await sendT(
                'Runtime.runIfWaitingForDebugger',
                {},
                sessionId
            ).catch(() => {
            });
        }

        return;
    }


    // 确保读取到稳定的脚本版本
    // 避免因文件处于 300ms 静置期导致空注入
    await refreshScriptsWhenStable();


    const sess = {
        ready: false,
        identifiers: new Map()
    };

    sessions.set(sessionId, sess);

    // 固定当前脚本列表快照
    const list = scriptList;

    let ok = true;


    try {

        await sendT('Page.enable', {}, sessionId);


        // 按文件名顺序依次注册
        // 先全部注册, 再补执行当前文档
        for (const s of list) {

            try {
                await registerScript(
                    sessionId,
                    sess,
                    s,
                    !paused
                );

            } catch (e) {

                ok = false;

                console.error(
                    `[!] 注册脚本 ${s.name} 失败:`,
                    e.message
                );
            }
        }


        // 已经运行的页面不能回到 document-start
        // 所以注册完成后, 对当前文档进行补执行
        if (!paused) {

            for (const s of list) {
                await evalCurrentDocument(sessionId, s);
            }
        }

    } catch (e) {

        ok = false;

        console.error('[!] 注册脚本失败:', e.message);

    } finally {

        sess.ready = true;

        // 只有真正处于等待状态的页面才需要释放
        if (paused) {
            await sendT(
                'Runtime.runIfWaitingForDebugger',
                {},
                sessionId
            ).catch(() => {
            });
        }
    }


    if (ok) {

        console.log(
            paused
                ? `[+] 新页面已注入(document-start): ${url}`
                : `[+] 已接管运行中的页面(当前文档补执行): ${url}`
        );
    }
}


// ---------- 热更新 ----------

async function syncSession(sid, sess, list) {

    const wanted = new Set(list.map(s => s.key));


    // 先注册新增或修改的脚本
    for (const s of list) {

        if (sess.identifiers.has(s.key)) {
            continue;
        }

        try {

            await registerScript(sid, sess, s, true);

            await evalCurrentDocument(sid, s);

        } catch (e) {

            console.error(
                `[!] 同步脚本 ${s.name} 失败:`,
                e.message
            );
        }
    }


    // 再移除已经删除或修改过的旧版本
    for (const [key, {id}] of [...sess.identifiers]) {

        if (wanted.has(key)) {
            continue;
        }

        await sendT(
            'Page.removeScriptToEvaluateOnNewDocument',
            {identifier: id},
            sid
        ).catch(() => {
        });

        sess.identifiers.delete(key);
    }
}


async function syncScriptsToSessions() {

    const list = scriptList;
    const jobs = [];

    for (const [sid, sess] of sessions) {

        if (!sess.ready) {
            continue;
        }

        jobs.push(
            syncSession(sid, sess, list)
                .catch(e => console.error('[!] 同步失败:', e.message))
        );
    }

    await Promise.all(jobs);
}


// ---------- CDP 连接 ----------

async function connect() {

    let info;

    try {

        info = await httpGetJson(
            `http://${HOST}:${PORT}/json/version`
        );

    } catch (_) {

        return false;
    }


    let client;

    try {

        client = await connectCdp(info.webSocketDebuggerUrl);

    } catch (_) {

        return false;
    }


    bc = client;


    // 初始化期间先缓存 attach 事件
    // 避免初始化阶段事件与连接状态发生竞态
    let initializing = true;

    const pendingAttaches = [];


    client.onEvent = (method, params) => {

        if (method === 'Target.attachedToTarget') {

            if (initializing) {

                pendingAttaches.push(params);

            } else {

                attachToTarget(params).catch(e => {
                    console.error('[!] attach 异常:', e.message);
                });
            }

        } else if (method === 'Target.detachedFromTarget') {

            sessions.delete(params.sessionId);
        }
    };


    client.onclose = () => {

        if (bc !== client) return;

        console.log('[i] 连接已断开, 等待目标应用...');

        bc = null;

        sessions.clear();
    };


    try {

        // 先启用自动附加
        // 新页面创建时暂停, 等注入脚本完成后再放行
        await client.send('Target.setAutoAttach', {

            autoAttach: true,

            waitForDebuggerOnStart: true,

            flatten: true

        });


        // 不再使用 getTargets + targetId 集合推断页面状态
        // 由 attachedToTarget.waitingForDebugger 直接判断


        initializing = false;


        // 处理初始化期间收到的附加事件
        for (const params of pendingAttaches.splice(0)) {

            attachToTarget(params).catch(e => {
                console.error('[!] attach 异常:', e.message);
            });
        }

    } catch (e) {

        initializing = false;

        console.error('[!] 初始化失败:', e.message);

        client.close();

        if (bc === client) {

            bc = null;

            sessions.clear();
        }

        return false;
    }


    console.log('[i] 已连接目标应用, 自动附加已启用, 等待页面...');

    return true;
}


// ---------- 定时任务 ----------

let ticking = false;


async function tick() {

    if (ticking) return;

    ticking = true;

    try {

        const prev = scriptList;

        scriptList = loadScripts();

        logChanges(prev, scriptList);


        // 尚未连接时尝试连接
        if (!bc && !(await connect())) {
            return;
        }


        // 同步脚本到所有已连接页面
        await syncScriptsToSessions();

    } catch (e) {

        console.error(
            '[!] 周期任务异常:',
            e && e.message
        );

    } finally {

        ticking = false;

        // 未连接时 100ms 重试
        // 已连接时每 1000ms 检查热更新
        setTimeout(
            tick,
            bc ? SCAN_INTERVAL : CONNECT_RETRY_INTERVAL
        );
    }
}


// ---------- 启动 ----------

function main() {

    fs.mkdirSync(SCRIPT_DIR, {
        recursive: true
    });

    console.log(`脚本目录: ${SCRIPT_DIR}`);

    console.log(
        `监听 CDP: http://${HOST}:${PORT} (Ctrl+C 退出)\n`
    );

    tick();
}


// 防止意外异常导致进程退出
process.on('uncaughtException', e => {
    console.error('[!] 未捕获异常:', e && e.message);
});

process.on('unhandledRejection', e => {
    console.error(
        '[!] 未处理的Promise异常:',
        e && (e.message || e)
    );
});


process.on('SIGINT', () => {

    if (bc) {
        bc.close();
    }

    process.exit(0);
});


main();