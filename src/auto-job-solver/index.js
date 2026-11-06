// Auto Job Solver — thin entry point.
// Imports all submodules so esbuild bundles them into a single IIFE.

import { state, sendCmd, log } from './state.js';
import { processQueue } from './main-loop.js';

(function () {
    // ---- Listen for start/stop commands ----
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;

        if (event.data && event.data.type === 'COR3_AUTOJOB_START') {
            state.jobQueue = event.data.jobs || [];
            state.solverSettings = event.data.settings || {};
            processQueue();
        }

        if (event.data && event.data.type === 'COR3_AUTOJOB_STOP') {
            state.abortFlag = true;
            log('收到停止信号 — 当前步骤结束后中止', 'warn');
        }
    });

    console.log('[COR3 助手] 自动任务求解器引擎已加载');
})();
