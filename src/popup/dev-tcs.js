// --- Dev TCs (secret dev testing section) ---

import { getCor3Tab } from './utils.js';

const devTcsSection = document.getElementById('devTcsSection');
const reachPullBtn = document.getElementById('devTcReachPullBtn');
const reachSelect = document.getElementById('devTcReachSelect');
const reachToggle = document.getElementById('devTcReachToggle');
const reachLog = document.getElementById('devTcReachLog');

export function showDevTcs() {
    if (devTcsSection) devTcsSection.style.display = '';
}

export function isDevTcsVisible() {
    return devTcsSection && devTcsSection.style.display !== 'none';
}

// ---- Reachability TC ----

let _reachMapCache = null;

function reachLogMsg(msg, color) {
    if (!reachLog) return;
    reachLog.style.display = '';
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    if (color) line.style.color = color;
    reachLog.appendChild(line);
    reachLog.scrollTop = reachLog.scrollHeight;
}

function clearReachLog() {
    if (reachLog) { reachLog.innerHTML = ''; reachLog.style.display = 'none'; }
}

if (reachPullBtn) {
    reachPullBtn.addEventListener('click', async () => {
        reachPullBtn.disabled = true;
        reachPullBtn.textContent = '...';
        clearReachLog();
        reachLogMsg('正在发送 get.map...');
        const tab = await getCor3Tab();
        if (!tab) {
            reachLogMsg('未找到 cor3.gg 标签页', 'var(--accent-red)');
            reachPullBtn.disabled = false;
            reachPullBtn.textContent = '\uD83D\uDD04';
            return;
        }
        chrome.tabs.sendMessage(tab.id, { action: 'requestNetworkMap' });
        const waitStart = Date.now();
        const poll = setInterval(async () => {
            const data = await chrome.storage.local.get('serverMaintenanceMap');
            if (data.serverMaintenanceMap && Object.keys(data.serverMaintenanceMap).length > 0) {
                clearInterval(poll);
                _reachMapCache = data.serverMaintenanceMap;
                populateReachSelect(data.serverMaintenanceMap);
                reachLogMsg('地图已加载：' + Object.keys(data.serverMaintenanceMap).length + ' 台服务器', 'var(--accent-green)');
                reachPullBtn.disabled = false;
                reachPullBtn.textContent = '\uD83D\uDD04';
            } else if (Date.now() - waitStart > 10000) {
                clearInterval(poll);
                reachLogMsg('等待地图数据超时', 'var(--accent-red)');
                reachPullBtn.disabled = false;
                reachPullBtn.textContent = '\uD83D\uDD04';
            }
        }, 500);
    });
}

function populateReachSelect(servers) {
    if (!reachSelect) return;
    reachSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '\u2014 选择服务器 \u2014';
    reachSelect.appendChild(defaultOpt);
    const sorted = Object.entries(servers).sort((a, b) => (a[1].serverName || '').localeCompare(b[1].serverName || ''));
    for (const [id, info] of sorted) {
        const opt = document.createElement('option');
        opt.value = id;
        let label = info.serverName || id.substring(0, 8);
        if (info.isInMaintenance) label += ' \u26D4';
        opt.textContent = label;
        reachSelect.appendChild(opt);
    }
}

if (reachToggle) {
    reachToggle.addEventListener('change', async () => {
        if (!reachToggle.checked) return;
        reachToggle.disabled = true;
        const serverId = reachSelect ? reachSelect.value : '';
        if (!serverId) {
            reachLogMsg('未选择服务器', 'var(--accent-red)');
            reachToggle.checked = false;
            reachToggle.disabled = false;
            return;
        }
        const serverName = (_reachMapCache && _reachMapCache[serverId]) ? _reachMapCache[serverId].serverName : serverId.substring(0, 8);
        clearReachLog();
        reachLogMsg('正在测试可达性：' + serverName + '...');

        const tab = await getCor3Tab();
        if (!tab) {
            reachLogMsg('未找到 cor3.gg 标签页', 'var(--accent-red)');
            reachToggle.checked = false;
            reachToggle.disabled = false;
            return;
        }

        reachLogMsg('正在连接到 ' + serverName + '...');
        chrome.tabs.sendMessage(tab.id, { action: 'devTcTestReachability', serverId: serverId });

        const resultKey = '_devTcReachResult';
        const progressKey = '_devTcReachProgress';
        await chrome.storage.local.remove([resultKey, progressKey]);
        let lastLogCount = 0;

        const waitStart = Date.now();
        const poll = setInterval(async () => {
            // Check for incremental progress logs
            const progressData = await chrome.storage.local.get(progressKey);
            if (progressData[progressKey] && progressData[progressKey].log) {
                const lines = progressData[progressKey].log;
                for (let i = lastLogCount; i < lines.length; i++) {
                    reachLogMsg(lines[i].msg, lines[i].color || null);
                }
                lastLogCount = lines.length;
            }

            const data = await chrome.storage.local.get(resultKey);
            if (data[resultKey]) {
                clearInterval(poll);
                const result = data[resultKey];
                // Show any remaining log lines not yet shown via progress
                for (let i = lastLogCount; i < (result.log || []).length; i++) {
                    reachLogMsg(result.log[i].msg, result.log[i].color || null);
                }
                if (result.reachable) {
                    reachLogMsg('可达：是', 'var(--accent-green)');
                } else {
                    reachLogMsg('可达：否 \u2014 ' + (result.reason || 'unknown'), 'var(--accent-red)');
                }
                chrome.storage.local.remove([resultKey, progressKey]);
                reachToggle.checked = false;
                reachToggle.disabled = false;
            } else if (Date.now() - waitStart > 300000) {
                clearInterval(poll);
                reachLogMsg('等待可达性结果超时（5 分钟）', 'var(--accent-red)');
                chrome.storage.local.remove([resultKey, progressKey]);
                reachToggle.checked = false;
                reachToggle.disabled = false;
            }
        }, 500);
    });
}
