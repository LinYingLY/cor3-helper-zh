// Auto Job Solver — main loop (processQueue + message listener).

import { MARKET_SERVER_NAMES } from '../shared/server-constants.js';
import { humanDelay } from '../shared/ws-utils.js';
import { friendlyError } from '../shared/error-map.js';
import { getServerTypeName } from '../shared/loadout-resolver.js';
import { state, serverMap, sendCmd, delay, log, DARK_MARKET_SERVER_ID, SOYUZ_MARKET_SERVER_ID, USOL_MARKET_SERVER_ID, SERVER_PATH_MAP } from './state.js';
import { getServerPriority, getJobTypePriority, isJobBugged, updateTracker, saveCompletedResultsIncremental, signalDone, fetchMapData, checkPathMaintenance, invalidateLoadoutCache, ensureLoadoutForJob } from './helpers.js';
import { stepSetEndpoint, stepCompleteJob } from './steps.js';
import { solveJob } from './solvers.js';
import { waitForIceWallStuckClear, waitForMinigameWindow } from '../shared/hack-utils.js';

export async function processQueue() {
    if (state.running) {
        log('自动任务求解器已在运行——忽略重复启动', 'warn');
        return;
    }

    if (state.abortFlag) {
        log('启动前收到停止信号 — 已中止', 'warn');
        signalDone();
        return;
    }
    state.running = true;
    state.abortFlag = false;

    try {

    // Wait if initial page load fetch is still in progress
    var waitAttempts = 0;
    while (window.__cor3InitialFetchInProgress && waitAttempts < 10 && !state.abortFlag) {
        waitAttempts++;
        log('页面首次加载中 — 延迟自动任务启动（尝试 ' + waitAttempts + '/10，等待 10 秒)...', 'warn');
        await new Promise(function (r) { setTimeout(r, 10000); });
    }
    if (state.abortFlag) { signalDone(); return; }
    if (window.__cor3InitialFetchInProgress) {
        log('⚠️ Initial page load still in progress after 100s — proceeding anyway', 'warn');
    }
    state.tokenExpired = false;
    state._lastLoadoutServerType = null;
    state._lastEndpointServerId = null;
    invalidateLoadoutCache();

    // Sort jobs by server priority (furthest first), then by server type (to group
    // servers needing the same hack software together, minimizing loadout swaps),
    // then by job type priority within same server
    state.jobQueue.sort(function (a, b) {
        var pa = getServerPriority(a.serverName || '');
        var pb = getServerPriority(b.serverName || '');
        if (pa !== pb) return pa - pb;
        var sta = (a.serverId ? getServerTypeName(a.serverId) : '') || '';
        var stb = (b.serverId ? getServerTypeName(b.serverId) : '') || '';
        if (sta !== stb) return sta < stb ? -1 : 1;
        var ta = getJobTypePriority(a.type || a.name || '');
        var tb = getJobTypePriority(b.type || b.name || '');
        return ta - tb;
    });

    log('自动任务求解器已启动——正在处理 ' + state.jobQueue.length + ' 个任务');

    // Apply locked-job states from ICE Wall reload (if any)
    var lockedJobs = state.solverSettings && state.solverSettings.lockedJobs;
    if (lockedJobs && lockedJobs.length > 0) {
        var now = Date.now();
        var appliedCount = 0;
        for (var lk = 0; lk < lockedJobs.length; lk++) {
            var locked = lockedJobs[lk];
            var matchingJob = state.jobQueue.find(function (j) { return j.jobId === locked.jobId; });
            if (!matchingJob) {
                log('已锁定任务：' + locked.jobId + ' 已不在队列 — 忽略', 'warn');
                continue;
            }
            if (locked.lockExpiresAt && new Date(locked.lockExpiresAt).getTime() > now) {
                var lockMins = Math.ceil((new Date(locked.lockExpiresAt).getTime() - now) / 60000);
                matchingJob.status = 'skipped';
                matchingJob.error = '小游戏已锁定(约' + lockMins + '分剩余)';
                matchingJob.lockExpiresAt = locked.lockExpiresAt;
                log('⚠️ Marked job as skipped (minigame locked): ' + matchingJob.name + ' — 锁将在约 ' + lockMins + 'm', 'warn');
                appliedCount++;
            } else {
                log('任务锁定已过期：' + (matchingJob.name || locked.jobId) + ' — 保持待处理');
            }
        }
        if (appliedCount > 0) log(appliedCount + ' 个任务已标记跳过（上次冰墙(ICE)锁定所致）');
    }

    updateTracker();

    // Pre-start: check all servers for maintenance and skip unreachable jobs
    log('正在检查服务器维护状态...');
    state._cachedMapData = null;
    try {
        await fetchMapData(true);
        if (serverMap.isReady()) {
            var skippedCount = 0;
            for (var m = 0; m < state.jobQueue.length; m++) {
                var mj = state.jobQueue[m];
                if (mj.status !== 'pending') continue;
                var mCheck = serverMap.checkPathMaintenance(mj.serverName);
                if (mCheck.blocked && mCheck.blockerName !== 'no-path') {
                    var mMins = Math.ceil((mCheck.remainingMs || 0) / 60000);
                    var mMsg = mCheck.blockerName === mj.serverName
                        ? mj.serverName + ' 维护中'
                        : mj.serverName + ' 不可达 (' + mCheck.blockerName + ' 维护中)';
                    mj.status = 'skipped';
                    mj.error = mMsg + ' (~' + mMins + '分剩余)';
                    mj.maintenanceEndsAt = mCheck.endsAt || null;
                    log('\u26a0\ufe0f 跳过任务：' + mj.name + ' \u2014 ' + mMsg + ' (~' + mMins + '分剩余)', 'warn');
                    skippedCount++;
                }
            }
            if (skippedCount > 0) {
                updateTracker();
                saveCompletedResultsIncremental();
                log(skippedCount + ' 个任务因服务器维护跳过');
            } else {
                log('所有服务器均可访问——未检测到维护');
            }
        }
    } catch (e) {
        log('\u26a0\ufe0f 无法获取网络地图，无法进行启动前维护检查：' + e.message + ' \u2014 仍然继续', 'warn');
    }

    // Auto-claim any already-completed jobs first
    var completedJobs = state.jobQueue.filter(function (j) { return j.canComplete; });
    if (completedJobs.length > 0) {
        log('找到 ' + completedJobs.length + ' 个可完成任务 — 先领取奖励');
        for (var c = 0; c < completedJobs.length; c++) {
            if (state.abortFlag) break;
            var cj = completedJobs[c];
            cj.status = 'running';
            updateTracker();
            try {
                if (cj.marketKey === 'dark') {
                    await stepSetEndpoint(DARK_MARKET_SERVER_ID);
                } else if (cj.marketKey === 'soyuz') {
                    await stepSetEndpoint(SOYUZ_MARKET_SERVER_ID);
                } else if (cj.marketKey === 'usol') {
                    await stepSetEndpoint(USOL_MARKET_SERVER_ID);
                }
                var cReward = await stepCompleteJob(cj);
                if (cReward) {
                    cj.status = 'done';
                    cj.reward = cReward;
                    log('✅ Claimed reward for completed job: ' + cj.name + ' — 💰' + cReward.credits, 'success');
                } else {
                    cj.status = 'failed';
                    cj.error = '任务完成未返回奖励';
                    log('任务完成未返回奖励：' + cj.name, 'warn');
                }
            } catch (e) {
                cj.status = 'failed';
                cj.error = e.message;
                log('❌ Failed to claim reward: ' + cj.name + ' — ' + e.message, 'error');
            }
            updateTracker();
            saveCompletedResultsIncremental();
            await delay(humanDelay());
            sendCmd('get.jobs', { marketId: cj.marketId });
            await delay(1000);
        }
    }

    for (var i = 0; i < state.jobQueue.length; i++) {
        if (state.abortFlag) {
            log('自动任务已被用户中止', 'warn');
            break;
        }

        state.currentJobIndex = i;
        var job = state.jobQueue[i];

        if (job.status === 'done' || job.status === 'failed' || job.status === 'skipped' || job.status === 'bugged') {
            continue;
        }

        if (isJobBugged(job)) {
            job.status = 'bugged';
            job.error = '故障: ' + (job.type || job.name) + ' 于 D4RK RM7CE（日志标签页不可用）';
            log('⚠️ Skipping bugged job: ' + job.name + ' 于 D4RK RM7CE — 日志标签页不可用', 'warn');
            updateTracker();
            continue;
        }

        if (job.serverName) {
            var pathCheck = await checkPathMaintenance(job.serverName);
            if (pathCheck.blocked) {
                var mins = Math.ceil(pathCheck.remainingMs / 60000);
                var blockerMsg = pathCheck.blockerName === job.serverName
                    ? job.serverName + ' 维护中'
                    : job.serverName + ' 不可达 (' + pathCheck.blockerName + ' 维护中)';
                job.status = 'skipped';
                job.error = blockerMsg + ' (~' + mins + '分剩余)';
                job.maintenanceEndsAt = pathCheck.endsAt || null;
                log('⚠️ Skipping job: ' + job.name + ' — ' + blockerMsg + ' (~' + mins + '分剩余)', 'warn');
                updateTracker();
                continue;
            }
        }

        job.status = 'running';
        state._currentJobRef = job;
        updateTracker();

        try {
            await ensureLoadoutForJob(job);
        } catch (loadoutErr) {
            log('装备栏预检警告：' + loadoutErr.message + ' — 仍继续执行', 'warn');
        }

        try {
            if (job.marketKey === 'dark') {
                await stepSetEndpoint(DARK_MARKET_SERVER_ID);
            } else if (job.marketKey === 'soyuz') {
                await stepSetEndpoint(SOYUZ_MARKET_SERVER_ID);
            } else if (job.marketKey === 'usol') {
                await stepSetEndpoint(USOL_MARKET_SERVER_ID);
            }
            log('正在处理任务 ' + (i + 1) + '/' + state.jobQueue.length + ': ' + (job.name || job.type));
            var reward = await solveJob(job);
            if (reward) {
                job.status = 'done';
                job.reward = reward;
                log('✅ Job completed: ' + job.name + ' — 💰' + reward.credits + ' ⭐' + reward.reputation + ' 🏅' + reward.renown, 'success');
            } else {
                job.status = 'failed';
                job.error = '任务完成未返回奖励';
                log('任务完成未返回奖励：' + job.name, 'warn');
            }
        } catch (e) {
            var errText = friendlyError(e.message);
            if (e.message && (e.message.includes('job-not-found-refresh') || e.message.includes('job-not-found') || e.message.includes('Job is not available'))) {
                job.status = 'skipped';
                job.error = '任务已不存在（数据过期）';
                log('⚠️ Job skipped (stale): ' + job.name + ' — 正在刷新全部市场数据', 'warn');
                updateTracker();
                saveCompletedResultsIncremental();
                log('检测到任务过期，正在刷新全部市场数据...');
                window.postMessage({ type: 'COR3_REFRESH_ALL_MARKETS_SEQ', skipLots: true }, '*');
                await new Promise(function (resolve) {
                    var refreshTimer = setTimeout(resolve, 30000);
                    function onRefreshDone(evt) {
                        if (evt.data && evt.data.type === 'COR3_ALL_MARKETS_REFRESHED') {
                            window.removeEventListener('message', onRefreshDone);
                            clearTimeout(refreshTimer);
                            resolve();
                        }
                    }
                    window.addEventListener('message', onRefreshDone);
                });
                log('所有市场数据已刷新——继续处理剩余任务');
                state._currentJobRef = null;
                continue;
            }
            if (e.message === 'Aborted' || state.abortFlag) {
                job.status = 'skipped';
                job.error = '已被用户中止';
                log('⚠️ Job aborted: ' + job.name, 'warn');
                state._currentJobRef = null;
                updateTracker();
                break;
            }
            if (e.message && (e.message.includes('token-expired') || e.message.includes('invalid-access-token'))) {
                job.status = 'skipped';
                job.error = errText;
                state.abortFlag = true;
                state.tokenExpired = true;
                log('⚠️ Job skipped (token expired): ' + job.name + ' — ' + errText, 'warn');
            } else if (e.message && e.message.includes('minigame-locked')) {
                job.lockExpiresAt = e.lockExpiresAt || null;
                log('🔒 Minigame locked — waiting up to 5s for minigame window to appear...', 'warn');
                var minigameType = await waitForMinigameWindow(5000);
                if (minigameType === 'icewall') {
                    log('检测到冰墙小游戏 — 正在检查是否卡住...', 'warn');
                    var iceWallResult = await waitForIceWallStuckClear(log, 10000);
                    if (iceWallResult.reloaded) {
                        job.status = 'skipped';
                        job.error = errText;
                        updateTracker();
                        saveCompletedResultsIncremental();
                        state._currentJobRef = null;
                        log('正在请求刷新页面以清除冰墙卡死界面 — 锁定的任务：' + job.name, 'warn');
                        window.postMessage({
                            type: 'COR3_AUTOJOB_ICE_WALL_RELOAD',
                            lockedJob: { jobId: job.jobId, lockExpiresAt: job.lockExpiresAt || null }
                        }, '*');
                        state.running = false;
                        return;
                    }
                    job.status = 'skipped';
                    job.error = errText;
                    log('⚠️ Job skipped (ICE Wall minigame locked, cleared): ' + job.name + ' — ' + errText, 'warn');
                } else {
                    job.status = 'skipped';
                    job.error = errText;
                    if (minigameType) {
                        log('⚠️ Job skipped (minigame locked, type: ' + minigameType + '): ' + job.name + ' — ' + errText, 'warn');
                    } else {
                        log('⚠️ Job skipped (minigame locked, no window detected): ' + job.name + ' — ' + errText, 'warn');
                    }
                }
            } else if (e.message && e.message.includes('Market not reachable')) {
                job.status = 'skipped';
                var marketServerName = MARKET_SERVER_NAMES[job.marketKey] || null;
                if (marketServerName) {
                    var mktCheck = await checkPathMaintenance(marketServerName);
                    if (mktCheck.blocked) {
                        var mktMins = Math.ceil(mktCheck.remainingMs / 60000);
                        job.error = '市场连不上（' + mktCheck.blockerName + ' 维护中, ~' + mktMins + '分剩余)';
                        job.maintenanceEndsAt = mktCheck.endsAt || null;
                        log('⚠️ Job skipped (market unreachable): ' + job.name + ' — ' + mktCheck.blockerName + ' 维护中 (~' + mktMins + '分剩余)', 'warn');
                    } else {
                        job.error = errText;
                        job.maintenanceEndsAt = null;
                        log('⚠️ Job skipped (market unreachable): ' + job.name + ' — ' + errText, 'warn');
                    }
                } else {
                    job.error = errText;
                    job.maintenanceEndsAt = null;
                    log('⚠️ Job skipped (market unreachable): ' + job.name + ' — ' + errText, 'warn');
                }
            } else if (e.message && (e.message.includes('maintenance') || e.message.includes('unreachable'))) {
                job.status = 'skipped';
                job.error = errText;
                job.maintenanceEndsAt = null;
                log('⚠️ Job skipped (unreachable): ' + job.name + ' — ' + errText, 'warn');
            } else if (e.message && (e.message.includes('internal-error') || e.message.includes('Internal server error'))) {
                job.status = 'pending';
                job.error = null;
                log('⚠️ Internal server error on job: ' + job.name + ' — 整个流程延迟 5 分钟后重试...', 'warn');
                updateTracker();
                for (var waitMin = 5; waitMin > 0 && !state.abortFlag; waitMin--) {
                    log('⏳ Waiting ' + waitMin + ' 分钟后继续...', 'info');
                    await delay(60000);
                }
                if (!state.abortFlag) {
                    log('服务器内部错误延迟结束，恢复执行 — 正在重试任务：' + job.name);
                    i--;
                }
                state._currentJobRef = null;
                continue;
            } else if (e.message && (e.message.includes('Timeout') || e.message.includes('timed out') || e.message.includes('timeout'))) {
                job.status = 'skipped';
                job.error = errText + ' (将在下次运行时重试)';
                log('⚠️ Job skipped (timeout): ' + job.name + ' — ' + errText, 'warn');
            } else if (e.message && e.message.includes('rate-limited')) {
                job.status = 'skipped';
                job.error = errText + ' (将在下次运行时重试)';
                log('⚠️ Job skipped (rate limited): ' + job.name + ' — ' + errText, 'warn');
            } else {
                job.status = 'failed';
                job.error = errText;
                log('❌ Job failed: ' + job.name + ' — ' + errText, 'error');
            }
        }

        state._currentJobRef = null;
        updateTracker();
        saveCompletedResultsIncremental();

        if (state.abortFlag) break;
        try {
            await delay(humanDelay());
            sendCmd('get.jobs', { marketId: job.marketId });
            await delay(1000);
            if (i < state.jobQueue.length - 1 && !state.abortFlag) {
                var interJobDelay = 2000 + Math.floor(Math.random() * 1500);
                log('等待 ' + Math.round(interJobDelay / 1000) + ' 秒后开始下一任务...');
                await delay(interJobDelay);
            }
        } catch (delayErr) {
            if (state.abortFlag) break;
        }
    }

    // Summary
    var doneCount = state.jobQueue.filter(function (j) { return j.status === 'done'; }).length;
    var failedCount = state.jobQueue.filter(function (j) { return j.status === 'failed'; }).length;
    var buggedCount = state.jobQueue.filter(function (j) { return j.status === 'bugged'; }).length;
    var skippedCount = state.jobQueue.filter(function (j) { return j.status === 'skipped'; }).length;
    var totalCredits = state.jobQueue.reduce(function (sum, j) { return sum + (j.reward ? j.reward.credits : 0); }, 0);
    var totalDeposit = state.jobQueue.reduce(function (sum, j) { return sum + (j.reward ? (j.reward.deposit || 0) : (j.depositPaid || 0)); }, 0);
    var totalRep = state.jobQueue.reduce(function (sum, j) { return sum + (j.reward ? j.reward.reputation : 0); }, 0);
    var totalRenown = state.jobQueue.reduce(function (sum, j) { return sum + (j.reward ? j.reward.renown : 0); }, 0);

    var depositStr = totalDeposit > 0 ? ' (存入：-' + totalDeposit + ')' : '';
    var buggedStr = buggedCount > 0 ? ', ' + buggedCount + ' bugged' : '';
    var skippedStr = skippedCount > 0 ? ', ' + skippedCount + ' 跳过（维护中）' : '';
    log('=== 自动任务完成：' + doneCount + ' 已完成,' + failedCount + ' 失败' + buggedStr + skippedStr + '. 净收益：💰' + totalCredits + depositStr + ' ⭐' + totalRep + ' 🏅' + totalRenown + ' ===', 'success');

    var completedResults = state.jobQueue.map(function (j) {
        return {
            jobId: j.jobId, name: j.name, type: j.type, serverName: j.serverName,
            marketKey: j.marketKey, status: j.status, reward: j.reward || null,
            error: j.error || null, completedAt: Date.now(),
            maintenanceEndsAt: j.maintenanceEndsAt || null,
            lockExpiresAt: j.lockExpiresAt || null
        };
    });
    window.postMessage({ type: 'COR3_AUTOJOB_SAVE_COMPLETED', jobs: completedResults }, '*');

    if (!state.abortFlag) {
        await new Promise(function (r) { setTimeout(r, 500); });
        log('正在依次刷新所有市场...');
        window.postMessage({ type: 'COR3_REFRESH_ALL_MARKETS_SEQ', skipLots: true }, '*');
        await new Promise(function (resolve) {
            var timer = setTimeout(resolve, 30000);
            function onDone(evt) {
                if (evt.data && evt.data.type === 'COR3_ALL_MARKETS_REFRESHED') {
                    window.removeEventListener('message', onDone);
                    clearTimeout(timer);
                    resolve();
                }
            }
            window.addEventListener('message', onDone);
        });
        log('市场刷新完成。');
    }

    } catch (queueErr) {
        if (queueErr && queueErr.message !== 'Aborted') {
            log('processQueue 中出现意外错误：' + queueErr.message, 'error');
        }
    } finally {
        signalDone();
    }
}
