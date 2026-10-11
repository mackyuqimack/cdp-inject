// @match http://*/*
// @match https://*/*
// 这是示例脚本: 在每个页面顶部打印一条日志, 可自行修改或删除
console.log('[cdp-inject] hello from injected script, page =', location.href);
