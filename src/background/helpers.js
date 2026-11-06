export async function getCor3Tab() {
    try {
        const [tab] = await chrome.tabs.query({ url: "*://*.cor3.gg/*" });
        return tab || null;
    } catch (e) { return null; }
}

const BG_AUTO_JOBS_MAX_LOGS = 200;
export async function bgAutoJobLog(msg, level) {
    const entry = { timestamp: new Date().toISOString(), msg, level: level || 'info' };
    try {
        const data = await chrome.storage.local.get('autoJobsDebugLogs');
        const logs = Array.isArray(data.autoJobsDebugLogs) ? data.autoJobsDebugLogs : [];
        logs.push(entry);
        if (logs.length > BG_AUTO_JOBS_MAX_LOGS) logs.splice(0, logs.length - BG_AUTO_JOBS_MAX_LOGS);
        await chrome.storage.local.set({ autoJobsDebugLogs: logs });
    } catch (e) { /* storage error — ignore */ }
}

export const BG_ERROR_MAP = {
    'sai-hack-impossible': '破解算力不足',
    'sai-no-hack-software': '无破解软件',
    'no-path-to-server': '无通往服务器的路径(不可达)',
    'server-in-maintenance': '服务器维护中',
    'invalid-access-token': '访问令牌已过期或无效',
    'token-expired': '会话令牌已过期'
};

export function bgFriendlyError(msg) { return (msg && BG_ERROR_MAP[msg]) || msg || '未知错误'; }
