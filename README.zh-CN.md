# cdp-inject

[English](README.md) | **简体中文**

一个基于 **Chrome DevTools Protocol (CDP)** 的 Electron 应用脚本注入器，零依赖。它会监视本地 `scripts/` 目录，把其中所有 `.js` 文件注入到目标 Electron 应用（包括 `<webview>`）的**每个页面**中，效果类似油猴（Tampermonkey），但无需安装任何浏览器扩展。

## 特性

- **零依赖** — 只需 Node.js >= 22（使用原生 `WebSocket` / `fetch`），无需 `npm install`。
- **document-start 注入** — 通过 `Target.setAutoAttach` + `waitForDebuggerOnStart` 在新页面创建时先暂停，等所有脚本注册完成后再放行，保证脚本**先于**页面所有业务代码/请求执行（等价于油猴的 `document-start`）。
- **无需手动刷新** — 注入器启动时已打开的页面，会在注册完脚本后立即补执行一次。
- **热重载** — `scripts/` 目录下新增 / 修改 / 删除文件自动同步（每秒轮询一次）到所有存活页面。
- **保存时语法预检** — 有语法错误的版本不会生效，继续沿用上一个可用版本，直到文件修复。
- **支持 `@match`** — 可在脚本头部注释块中声明匹配规则，限制脚本只在匹配的页面运行。
- **隔离作用域** — 每个脚本会被包在块作用域 `{ ... }` 里执行，顶层 `let/const/class` 不会泄漏到全局，热更新重复执行也不会报"重复声明"。

## 环境要求

- Node.js **>= 22**
- 目标 Electron 应用需在 **`127.0.0.1:9222`** 开启远程调试端口

启动目标应用时开启调试端口的示例：

```powershell
your-app.exe --remote-debugging-port=9222
```

或在启动前设置环境变量（对多数 Electron 应用有效）：

```powershell
$env:ELECTRON_ARGS = "--remote-debugging-port=9222"
```

## 使用方法

1. 把你的脚本放进 `scripts/` 目录（已附带一个 `example.js` 示例）。
2. 以远程调试端口 9222 启动目标 Electron 应用。
3. 运行注入器 — 双击 `start.bat`，或执行：

```powershell
node inject.js
# 自定义脚本目录:
node inject.js D:\path\to\my-scripts
```

4. 保持窗口开启即可持续注入。关闭窗口（或按 `Ctrl+C`）停止注入。

启动顺序无所谓：注入器可以**先于**目标应用启动，它会自动等待并连接。连接时已打开的页面会被立即接管并注入。

## 编写脚本

脚本就是普通的 `.js` 文件。可以在**文件头部的注释块**里声明匹配规则（只解析第一行代码之前的注释；不写则对所有页面生效）：

```js
// @match https://example.com/*
// @match http://localhost:*/admin/*

// 只在匹配的页面执行
console.log('hello from', location.href);
```

匹配语法：类 glob 模式，`*` 匹配任意字符（如 `https://*/*`）。规则会被编译成正则表达式，在页面运行时与 `location.href` 匹配。

注意事项：

- 脚本在页面的主世界（main world）执行，与页面代码同一上下文。
- 脚本主体会被包裹在 `{ ... }` 中，顶层 `let/const/class` 是局部作用域，热重载安全。
- 文件有语法错误时，上一个可用版本继续生效，同时注入器控制台会打印错误。
- 在 DevTools 中，注入的脚本会以 `cdp-inject/<文件名>` 显示（通过 `//# sourceURL`）。

## 工作原理

1. 每秒轮询 `http://127.0.0.1:9222/json/version`，目标应用启动后连接其浏览器级 WebSocket 端点。
2. 调用 `Target.setAutoAttach`（`waitForDebuggerOnStart: true`），使每个新页面 target（类型为 `page` 或 `webview`）创建时处于**暂停**状态。
3. attach 后通过 `Page.addScriptToEvaluateOnNewDocument` 注册全部当前脚本，然后调用 `Runtime.runIfWaitingForDebugger` 放行页面 — 保证 document-start 时机。
4. 每秒重扫脚本目录：新增/修改的脚本注册到所有存活会话，删除的脚本被注销；注册顺序经过精心设计，避免出现"旧版本已删、新版本未注册"的空窗。
5. 不可注入的 target（DevTools 窗口、worker 等）立即放行，避免卡住。

同时处理断线重连：应用关闭再启动后注入器会自动重新接管；并捕获未处理异常，防止进程在页面处于"暂停等待注入"状态时意外退出导致页面永久卡死。

## 目录结构

```
cdp-inject/
├── inject.js        # 注入器本体（单文件，零依赖）
├── start.bat        # Windows 启动器
└── scripts/         # 用户脚本目录
    └── example.js   # 示例脚本
```

## 控制台消息

| 前缀  | 含义                                  |
|-------|---------------------------------------|
| `[i]` | 信息（已连接、脚本加载/移除）          |
| `[+]` | 某页面已注入                           |
| `[*]` | 某脚本已更新                           |
| `[-]` | 某脚本已移除                           |
| `[!]` | 错误 / 警告                            |

## 免责声明

本工具仅用于**调试和自动化你自己有权限的应用程序**。向未授权修改的应用注入脚本可能违反其服务条款或相关法律法规，请合理使用。
