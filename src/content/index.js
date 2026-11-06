// content.js — modular entry point

// Import all modules (side-effects: intervals, storage listeners, auto-start solvers, DOM tweaks)
import './helpers.js';
import './auto-update-markets.js';
import './auto-choose.js';
import './auto-send.js';
import './alarms.js';
import './auto-refresh.js';
import './solvers.js';
import './dom-tweaks.js';
import './log-writers.js';

// Setup functions (register listeners)
import { setupWsRelay } from './ws-relay.js';
import { setupMessageListener } from './message-listener.js';
import { setupEngineRelay } from './engine-relay.js';
import { checkAutoSendOnExpeditionData } from './auto-send.js';

setupWsRelay();
setupMessageListener();
setupEngineRelay();

// On page load: check cached expedition data for auto-send trigger
setTimeout(() => {
    chrome.storage.local.get('expeditionsData', (result) => {
        if (result.expeditionsData) {
            console.log('[COR3 Helper] 页面加载：正在检查缓存的远征数据用于自动派遣');
            checkAutoSendOnExpeditionData(result.expeditionsData);
        }
    });
}, 5000);

// Listen for autoSendMerc toggle changes to trigger auto-send check
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.autoSendMerc) return;
    const newVal = changes.autoSendMerc.newValue;
    if (newVal && newVal.enabled) {
        console.log('[COR3 Helper] 自动派遣佣兵已启用 — 正在检查远征数据');
        chrome.storage.local.get('expeditionsData', (result) => {
            if (result.expeditionsData) {
                checkAutoSendOnExpeditionData(result.expeditionsData);
            }
        });
    }
});

// Capture extension errors to IndexedDB for DevTools panel
window.addEventListener('error', (e) => {
    if (typeof cor3LogEntry === 'function') {
        cor3LogEntry('error-logs', (e.filename || '') + ':' + (e.lineno || 0) + ' ' + (e.message || ''), 'error');
    }
});
window.addEventListener('unhandledrejection', (e) => {
    if (typeof cor3LogEntry === 'function') {
        var msg = e.reason ? (e.reason.stack || e.reason.message || String(e.reason)) : '未处理的 Promise 拒绝';
        cor3LogEntry('error-logs', msg, 'error');
    }
});

// Clean up auto-jobs state on page reload — always start fresh
// (autoJobsLockedJobs is preserved — the solver reads and clears it on next start)
chrome.storage.local.remove('initialFetchDoneAt');
chrome.storage.local.get('autoJobsRunning', (data) => {
    if (data.autoJobsRunning) {
        console.log('[COR3 Helper] 页面已重新加载 — 清除过期的自动任务状态');
        chrome.storage.local.set({ autoJobsRunning: false, autoJobsQueue: [] });
    }
});
