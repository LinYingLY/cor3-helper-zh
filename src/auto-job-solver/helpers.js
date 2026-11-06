// Auto Job Solver — helper functions: tracker, map fetch, loadout orchestration, priority.

import { MARKET_DISPLAY_NAMES, JOB_TYPE_PRIORITY, LOG_JOB_TYPES, getMarketNameById } from '../shared/server-constants.js';
import { humanDelay, safeTimeout, safeClearTimeout } from '../shared/ws-utils.js';
import { formatMinigameLockError, ensureDecryptSolverEnabled, ensureIceWallSolverEnabled, ensureSimpleDecryptSolverEnabled } from '../shared/hack-utils.js';
import { friendlyError } from '../shared/error-map.js';
import { calculateAnalysis, findHackSoftwareForServerType, findDecryptSoftwareForFileType, findBestHardware, findRemovableSoftware, getServerTypeName } from '../shared/loadout-resolver.js';
import { state, serverMap, sendCmd, delay, waitForEvent, log, SERVER_PRIORITY, SERVER_PATH_MAP } from './state.js';

// ---- Priority helpers ----

export function isJobBugged(job) {
    return job.serverName === 'D4RK RM7CE' && LOG_JOB_TYPES.indexOf(job.type || job.name) >= 0;
}

export function getServerPriority(serverName) {
    if (!serverName || serverName === 'None') return -1;
    if (serverMap.isReady()) {
        return serverMap.getServerPriorityIndex(serverName);
    }
    var idx = SERVER_PRIORITY.indexOf(serverName);
    return idx >= 0 ? idx : SERVER_PRIORITY.length;
}

export function getJobTypePriority(typeName) {
    var idx = JOB_TYPE_PRIORITY.indexOf(typeName);
    return idx >= 0 ? idx : JOB_TYPE_PRIORITY.length;
}

// ---- Tracker / persistence ----

export function updateTracker() {
    window.postMessage({ type: 'COR3_AUTOJOB_TRACKER_UPDATE', tracker: state.jobQueue }, '*');
}

export function saveCompletedResultsIncremental() {
    var results = state.jobQueue.filter(function (j) { return j.status === 'done' || j.status === 'failed' || j.status === 'skipped' || j.status === 'bugged'; }).map(function (j) {
        return {
            jobId: j.jobId, name: j.name, type: j.type, serverName: j.serverName,
            marketKey: j.marketKey, status: j.status, reward: j.reward || null,
            error: j.error || null, completedAt: Date.now(),
            maintenanceEndsAt: j.maintenanceEndsAt || null,
            lockExpiresAt: j.lockExpiresAt || null
        };
    });
    window.postMessage({ type: 'COR3_AUTOJOB_SAVE_COMPLETED', jobs: results }, '*');
}

export function signalDone() {
    state.running = false;
    state._currentJobRef = null;
    window.postMessage({ type: 'COR3_AUTOJOB_DONE', tokenExpired: state.tokenExpired }, '*');
}

// ---- Network map fetch ----

export async function fetchMapData(forceRefresh) {
    if (!forceRefresh && state._cachedMapData) return state._cachedMapData;
    var oldFingerprint = serverMap.isReady() ? serverMap.getMaintenanceFingerprint() : null;
    var fullDataPromise = new Promise(function (resolve) {
        var t;
        function onFullMap(evt) {
            if (evt.data && evt.data.type === 'COR3_WS_MAP_DATA' && evt.data.servers) {
                window.removeEventListener('message', onFullMap);
                clearTimeout(t);
                resolve({ servers: evt.data.servers, connections: evt.data.connections || [] });
            }
        }
        window.addEventListener('message', onFullMap);
        t = setTimeout(function () { window.removeEventListener('message', onFullMap); resolve(null); }, 12000);
    });
    sendCmd('get.map', {});
    var mapData = await waitForEvent('COR3_WS_NETWORK_MAP', 10000);
    if (mapData && mapData.servers) {
        state._cachedMapData = mapData;
        var fullData = await fullDataPromise;
        if (fullData) {
            serverMap.update(fullData);
            var newFingerprint = serverMap.getMaintenanceFingerprint();
            if (oldFingerprint !== null && oldFingerprint !== newFingerprint) {
                log('服务器状态已变更 — 路径缓存已刷新');
            }
        }
    }
    return mapData;
}

export async function checkPathMaintenance(serverName) {
    if (serverMap.isReady()) {
        return serverMap.checkPathMaintenance(serverName);
    }
    var path = SERVER_PATH_MAP[serverName];
    if (!path) return { blocked: false };
    var mapData = await fetchMapData();
    if (!mapData || !mapData.servers) return { blocked: false };
    for (var i = 0; i < path.length; i++) {
        var srv = path[i];
        var srvInfo = mapData.servers[srv.id];
        if (srvInfo && srvInfo.isInMaintenance) {
            var remaining = srvInfo.maintenanceEndsAt ? new Date(srvInfo.maintenanceEndsAt).getTime() - Date.now() : 0;
            if (remaining > 0) {
                return { blocked: true, blockerName: srv.name, endsAt: srvInfo.maintenanceEndsAt, remainingMs: remaining };
            }
        }
    }
    return { blocked: false };
}

// ---- Server name/path lookups ----

export function getServerNameById(serverId) {
    if (serverMap.isReady()) {
        var s = serverMap.getServer(serverId);
        if (s) return s.name;
    }
    for (var name in SERVER_PATH_MAP) {
        var path = SERVER_PATH_MAP[name];
        for (var i = 0; i < path.length; i++) {
            if (path[i].id === serverId) return path[i].name;
        }
    }
    return null;
}

export function getPathForServerId(serverId) {
    if (serverMap.isReady()) {
        var path = serverMap.getShortestPath(serverId);
        if (path) return path;
    }
    for (var name in SERVER_PATH_MAP) {
        var path = SERVER_PATH_MAP[name];
        if (path.length > 0 && path[path.length - 1].id === serverId) {
            return path;
        }
    }
    return null;
}

// ---- Loadout orchestration ----

export function invalidateLoadoutCache() {
    state._cachedLoadout = null;
    state._cachedLoadoutAt = 0;
}

export async function getLoadoutData(forceRefresh) {
    if (!forceRefresh && state._cachedLoadout && (Date.now() - state._cachedLoadoutAt < 60000)) {
        log('装备栏：使用缓存数据（已存 ' + Math.round((Date.now() - state._cachedLoadoutAt) / 1000) + 's)');
        return state._cachedLoadout;
    }
    var now = Date.now();
    if (now - state._lastLoadoutFetchAt < state.LOADOUT_COOLDOWN_MS) {
        log('装备栏：获取冷却中（' + Math.round(state.LOADOUT_COOLDOWN_MS - (now - state._lastLoadoutFetchAt)) + '毫秒剩余）— 使用缓存', 'warn');
        return state._cachedLoadout;
    }
    state._lastLoadoutFetchAt = now;
    log('装备栏：获取最新数据...');
    sendCmd('loadout.get', {});
    try {
        var data = await waitForEvent('COR3_AUTOJOB_LOADOUT', 10000);
        if (data && data.data) {
            state._cachedLoadout = data.data;
            state._cachedLoadoutAt = Date.now();
            var eqSw = state._cachedLoadout.equippedSoftware || [];
            log('装备栏：获得：' + ((state._cachedLoadout.ownedSoftware || []).length) + ' 已拥有， ' + eqSw.length + ' 已装备软件');
            return state._cachedLoadout;
        }
    } catch (e) {
        log('装备栏：获取超时 —' + e.message, 'warn');
    }
    log('装备栏：没有可用数据', 'warn');
    return null;
}

export async function applyLoadoutChange(loadout, targetHw, targetSwIds) {
    var currentHw = loadout.equippedHardware || {};
    var currentSw = (loadout.equippedSoftware || []).map(function (s) { return s.id; });

    var hwCategories = ['cpu', 'gpu', 'ram', 'psu'];
    for (var ci = 0; ci < hwCategories.length; ci++) {
        var cat = hwCategories[ci];
        var tgt = targetHw[cat];
        var cur = currentHw[cat];
        if (tgt && (!cur || cur.id !== tgt.id)) {
            log('装备栏：正在装备 ' + cat.toUpperCase() + ': ' + tgt.name);
            sendCmd('loadout.equip.hardware', { moduleConfigId: tgt.id });
            try { await waitForEvent('COR3_AUTOJOB_LOADOUT', 8000); } catch (e) { /* continue */ }
            await delay(humanDelay());
        }
    }

    for (var ui = 0; ui < currentSw.length; ui++) {
        if (targetSwIds.indexOf(currentSw[ui]) < 0) {
            log('装备栏：卸下软件：' + currentSw[ui]);
            sendCmd('loadout.unequip.software', { moduleConfigId: currentSw[ui] });
            try { await waitForEvent('COR3_AUTOJOB_LOADOUT', 5000); } catch (e) { /* continue */ }
            await delay(500);
        }
    }

    for (var ei = 0; ei < targetSwIds.length; ei++) {
        if (currentSw.indexOf(targetSwIds[ei]) < 0) {
            log('装备栏：装备软件：' + targetSwIds[ei]);
            sendCmd('loadout.equip.software', { moduleConfigId: targetSwIds[ei] });
            try { await waitForEvent('COR3_AUTOJOB_LOADOUT', 5000); } catch (e) { /* continue */ }
            await delay(500);
        }
    }

    invalidateLoadoutCache();
    await delay(humanDelay());
}

export async function ensureLoadoutForJob(job) {
    var serverId = job.serverId;
    if (!serverId) {
        log('装备栏：任务没有目标服务器 — 跳过装备栏检查');
        return true;
    }

    var serverTypeName = getServerTypeName(serverId);
    state._lastLoadoutServerType = serverTypeName || state._lastLoadoutServerType;
    log('装备栏：任务预检：“' + (job.type || job.name || '?') + '"，服务器 ' + (serverTypeName || serverId));

    var serverDefenceRate = 0;
    var needsHack = true;
    try {
        sendCmd('get.login.status', { serverId: serverId });
        var preLoginData = await waitForEvent('COR3_AUTOJOB_SAI_LOGIN_STATUS', 5000);
        if (preLoginData && preLoginData.data) {
            if (preLoginData.data.serverDefenceRate) {
                serverDefenceRate = preLoginData.data.serverDefenceRate;
            }
            if (preLoginData.data.activeAccesses && preLoginData.data.activeAccesses.length > 0) {
                var existingAccess = preLoginData.data.activeAccesses[0];
                var existingType = existingAccess.accessType || existingAccess.type || 'unknown';
                log('装备栏：已拥有：' + existingType + ' 目标服务器已有访问 — 跳过破解配装');
                needsHack = false;
            }
        }
    } catch (e) {
        log('装备栏：检查登录状态失败 — 默认需要破解', 'warn');
    }

    if (!needsHack) {
        log('装备栏：预检完成 — 无需破解“' + (job.type || job.name || '?') + '"');
        return true;
    }

    if (!serverTypeName) {
        log('装备栏：判断不出服务器类型 — 跳过破解装备栏');
        return true;
    }

    invalidateLoadoutCache();
    var loadout = await getLoadoutData(true);
    if (!loadout) {
        log('装备栏：获取装备栏数据失败 — 跳过装备栏检查继续', 'warn');
        return true;
    }

    var allSw = loadout.ownedSoftware || [];
    var equippedSwIds = (loadout.equippedSoftware || []).map(function (s) { return s.id; });
    var hackCandidates = findHackSoftwareForServerType(allSw, serverTypeName);
    log('装备栏：找到 ' + hackCandidates.length + ' 个破解候选: ' + serverTypeName + (hackCandidates.length > 0 ? ' — 最佳: ' + hackCandidates[0].sw.name + ' (算力 ' + (hackCandidates[0].spec.power || []).join('-') + ')' : ''));

    if (hackCandidates.length === 0) {
        log('装备栏: 没有可用的破解软件: ' + serverTypeName + ' — 继续(可能使用已有访问)', 'warn');
        return true;
    }

    var bestHack = hackCandidates[0];
    var targetSwIds = [bestHack.sw.id];
    var currentHw = loadout.equippedHardware || {};
    var analysis = calculateAnalysis(loadout, targetSwIds);
    var targetHw = currentHw;

    var alreadyBest = equippedSwIds.length === 1 && equippedSwIds[0] === bestHack.sw.id;
    if (alreadyBest) {
        log('装备栏：最佳 HACK 软件"' + bestHack.sw.name + '" 已单独装备');
    }

    if (!analysis.canBoot) {
        log('装备栏：当前硬件启动不了破解软件 — 查找兼容硬件');
        var betterHw = findBestHardware(loadout, targetSwIds);
        if (betterHw) {
            targetHw = betterHw;
        } else {
            log('装备栏：破解软件启动失败 — 跳过装备栏变更', 'warn');
            return true;
        }
    }

    var checkLoadout = JSON.parse(JSON.stringify(loadout));
    checkLoadout.equippedHardware = targetHw;
    var checkAnalysis = calculateAnalysis(checkLoadout, targetSwIds);
    var computedHackPower = 0;
    var hackSa = checkAnalysis.swAnalysis[bestHack.sw.id];
    if (hackSa) {
        for (var ai = 0; ai < hackSa.abilities.length; ai++) {
            if (hackSa.abilities[ai].type === 'HACK') {
                computedHackPower = hackSa.abilities[ai].computedPower;
                break;
            }
        }
    }
    if (serverDefenceRate > 0) {
        log('装备栏：破解算力比较 — hackPower：' + computedHackPower + ' vs serverDefenceRate: ' + serverDefenceRate + (computedHackPower >= serverDefenceRate ? ' ✓' : ' ✗ 不足'));
    } else {
        log('装备栏：计算破解算力：' + computedHackPower + ' (serverDefenceRate 未知)');
    }

    if (serverDefenceRate > 0 && computedHackPower < serverDefenceRate) {
        log('装备栏：破解算力不足 — 尝试升级硬件提升算力');
        var hwUpgrade = findBestHardware(loadout, targetSwIds);
        if (hwUpgrade) {
            var upgradeLoadout = JSON.parse(JSON.stringify(loadout));
            upgradeLoadout.equippedHardware = hwUpgrade;
            var upgradeAnalysis = calculateAnalysis(upgradeLoadout, targetSwIds);
            var upgradedPower = 0;
            var upgradeSa = upgradeAnalysis.swAnalysis[bestHack.sw.id];
            if (upgradeSa) {
                for (var uai = 0; uai < upgradeSa.abilities.length; uai++) {
                    if (upgradeSa.abilities[uai].type === 'HACK') {
                        upgradedPower = upgradeSa.abilities[uai].computedPower;
                        break;
                    }
                }
            }
            if (upgradedPower > computedHackPower) {
                targetHw = hwUpgrade;
                computedHackPower = upgradedPower;
                log('装备栏：找到硬件升级 — 破解算力：' + upgradedPower + ' vs serverDefenceRate: ' + serverDefenceRate + (upgradedPower >= serverDefenceRate ? ' ✓' : ' ✗ 仍然不足'));
                if (upgradedPower < serverDefenceRate) {
                    log('装备栏：达不到所需破解算力(' + serverDefenceRate + ') — 可达最佳: ' + upgradedPower, 'error');
                }
            } else {
                log('装备栏：没有更好硬件 — 最佳破解算力：' + computedHackPower, 'warn');
            }
        } else {
            log('装备栏：无可用硬件升级', 'warn');
        }
    }

    if (!alreadyBest || targetHw !== currentHw) {
        log('装备栏：装备纯破解软件“' + bestHack.sw.name + '" (算力 ' + (bestHack.spec.power || []).join('-') + ') 用于 ' + serverTypeName);
        await applyLoadoutChange(loadout, targetHw, targetSwIds);
    }
    log('装备栏：预检完成：“' + (job.type || job.name || '?') + '"');
    return true;
}

export async function ensureDecryptOnlyLoadout(job) {
    var fileType = null;
    if (job.conditions && job.conditions.items) {
        for (var ci = 0; ci < job.conditions.items.length; ci++) {
            var cond = job.conditions.items[ci];
            if (cond.details && cond.details.fileExtension) {
                fileType = cond.details.fileExtension;
                if (fileType && fileType[0] !== '.') fileType = '.' + fileType;
                break;
            }
        }
    }
    if (!fileType && job.fileType) {
        fileType = job.fileType;
    }
    if (!fileType) {
        log('装备栏：解密任务但文件类型未知 — 依赖报错重试', 'warn');
        return;
    }

    invalidateLoadoutCache();
    var loadout = await getLoadoutData(true);
    if (!loadout) {
        log('装备栏：获取装备栏数据失败 — 不带解密装备继续', 'warn');
        return;
    }

    var allSw = loadout.ownedSoftware || [];
    var decryptCandidates = findDecryptSoftwareForFileType(allSw, fileType);
    if (decryptCandidates.length === 0) {
        log('装备栏：无可用解密软件：' + fileType, 'warn');
        return;
    }

    var bestDecrypt = decryptCandidates[0];
    var equippedSwIds = (loadout.equippedSoftware || []).map(function (s) { return s.id; });
    if (equippedSwIds.length === 1 && equippedSwIds[0] === bestDecrypt.sw.id) {
        log('装备栏：最佳解密软件“' + bestDecrypt.sw.name + '" 已单独装备');
        return;
    }

    var targetSwIds = [bestDecrypt.sw.id];
    var currentHw = loadout.equippedHardware || {};
    var analysis = calculateAnalysis(loadout, targetSwIds);
    var targetHw = currentHw;
    if (!analysis.canBoot) {
        log('装备栏：当前硬件启动不了解密软件 — 查找兼容硬件');
        var betterHw = findBestHardware(loadout, targetSwIds);
        if (betterHw) {
            targetHw = betterHw;
        } else {
            log('装备栏：解密软件启动失败：' + fileType + ' — 资源不足', 'warn');
            return;
        }
    }

    log('装备栏：装备纯解密软件“' + bestDecrypt.sw.name + '" (算力 ' + (bestDecrypt.spec.power || []).join('-') + ') 用于 ' + fileType);
    await applyLoadoutChange(loadout, targetHw, targetSwIds);
}

export async function checkDecryptPowerViaAnalysis(fileId, job) {
    sendCmd('get.file.analysis', { fileId: fileId });
    try {
        var analysis = await waitForEvent('COR3_AUTOJOB_FILE_ANALYSIS', 8000);
        if (analysis && analysis.data) {
            var canDecrypt = analysis.data.canDecrypt;
            if (canDecrypt === false) {
                log('解密算力检查: 分析超时 — 继续执行' + (analysis.data.decryptPower || '?') + ')', 'warn');
                return false;
            }
            log('解密算力检查: 不足 (需要: ');
            return true;
        }
    } catch (e) {
        log('解密未完成 — 重新打开文件重试解密 (尝试 ', 'warn');
    }
    return true;
}

export async function tryLoadoutSwapForError(errorMsg, job, errorObj) {
    if (!errorMsg) return false;
    log('装备栏：tryLoadoutSwapForError — 错误=“' + errorMsg + '"');
    invalidateLoadoutCache();
    var loadout = await getLoadoutData(true);
    if (!loadout) {
        log('装备栏：重试失败 — 没有装备栏数据', 'warn');
        return false;
    }

    var allSw = loadout.ownedSoftware || [];
    var equippedSwIds = (loadout.equippedSoftware || []).map(function (s) { return s.id; });

    if (errorMsg.indexOf('sai-no-hack-software') >= 0 || errorMsg.indexOf('sai-hack-impossible') >= 0) {
        var serverId = job.serverId;
        var serverTypeName = getServerTypeName(serverId);
        if (!serverTypeName) {
            log('装备栏: 未能判断服务器类型: ' + serverId, 'warn');
            return false;
        }
        log('装备栏：破解失败：' + serverTypeName + ' — 正在装备纯破解软件');
        var hackCandidates = findHackSoftwareForServerType(allSw, serverTypeName);
        if (hackCandidates.length === 0) {
            log('装备栏: 没有可用的破解软件: ' + serverTypeName, 'warn');
            return false;
        }
        var bestHack = hackCandidates[0];
        var targetSwIds = [bestHack.sw.id];

        var serverDefenceRate = 0;
        try {
            sendCmd('get.login.status', { serverId: serverId });
            var loginStatus = await waitForEvent('COR3_AUTOJOB_SAI_LOGIN_STATUS', 5000);
            if (loginStatus && loginStatus.data && loginStatus.data.serverDefenceRate) {
                serverDefenceRate = loginStatus.data.serverDefenceRate;
            }
        } catch (e) { }

        if (equippedSwIds.length === 1 && equippedSwIds[0] === bestHack.sw.id) {
            log('装备栏：最佳破解软件"' + bestHack.sw.name + '" 已单独装备 — 尝试升级硬件');
            var currentAnalysis = calculateAnalysis(loadout, targetSwIds);
            var currentHackPower = 0;
            var curSa = currentAnalysis.swAnalysis[bestHack.sw.id];
            if (curSa) {
                for (var chi = 0; chi < curSa.abilities.length; chi++) {
                    if (curSa.abilities[chi].type === 'HACK') { currentHackPower = curSa.abilities[chi].computedPower; break; }
                }
            }
            if (serverDefenceRate > 0) {
                log('装备栏：当前破解算力：' + currentHackPower + ' vs serverDefenceRate: ' + serverDefenceRate);
            }
            var betterHw = findBestHardware(loadout, targetSwIds);
            if (!betterHw) {
                log('装备栏：没有可用硬件升级 — 破解算力已到上限' + (serverDefenceRate > 0 ? ' (需要 ' + serverDefenceRate + ', 当前 ' + currentHackPower + ')' : ''), 'error');
                return false;
            }
            var testLoadout = JSON.parse(JSON.stringify(loadout));
            testLoadout.equippedHardware = betterHw;
            var hwAnalysis = calculateAnalysis(testLoadout, targetSwIds);
            if (!hwAnalysis.canBoot) {
                log('装备栏：换更好硬件也启动失败 — 放弃', 'error');
                return false;
            }
            var upgradedHackPower = 0;
            var hwSa = hwAnalysis.swAnalysis[bestHack.sw.id];
            if (hwSa) {
                for (var uhi = 0; uhi < hwSa.abilities.length; uhi++) {
                    if (hwSa.abilities[uhi].type === 'HACK') { upgradedHackPower = hwSa.abilities[uhi].computedPower; break; }
                }
            }
            log('装备栏：硬件升级后破解算力：' + upgradedHackPower + (serverDefenceRate > 0 ? ' vs serverDefenceRate: ' + serverDefenceRate : ''));
            if (upgradedHackPower <= currentHackPower) {
                log('装备栏：升级硬件也提升不了破解算力 — 放弃', 'error');
                return false;
            }
            if (serverDefenceRate > 0 && upgradedHackPower < serverDefenceRate) {
                log('装备栏：升级硬件后仍不足 — 需要：' + serverDefenceRate + ', 可达最佳: ' + upgradedHackPower, 'error');
            }
            log('装备栏：更换硬件以提升破解算力：' + serverTypeName);
            await applyLoadoutChange(loadout, betterHw, targetSwIds);
            return true;
        }

        var currentHw = loadout.equippedHardware || {};
        var analysis = calculateAnalysis(loadout, targetSwIds);
        var targetHw = currentHw;
        if (!analysis.canBoot) {
            var betterHw2 = findBestHardware(loadout, targetSwIds);
            if (betterHw2) {
                targetHw = betterHw2;
            } else {
                log('装备栏：纯破解软件启动失败 — 放弃', 'warn');
                return false;
            }
        }

        var preCheckLoadout = JSON.parse(JSON.stringify(loadout));
        preCheckLoadout.equippedHardware = targetHw;
        var preCheck = calculateAnalysis(preCheckLoadout, targetSwIds);
        var projectedPower = 0;
        var preSa = preCheck.swAnalysis[bestHack.sw.id];
        if (preSa) {
            for (var phi = 0; phi < preSa.abilities.length; phi++) {
                if (preSa.abilities[phi].type === 'HACK') { projectedPower = preSa.abilities[phi].computedPower; break; }
            }
        }
        log('装备栏：新配装预计破解算力：' + projectedPower + (serverDefenceRate > 0 ? ' vs serverDefenceRate: ' + serverDefenceRate : ''));
        if (serverDefenceRate > 0 && projectedPower < serverDefenceRate) {
            var hwRetry = findBestHardware(loadout, targetSwIds);
            if (hwRetry) {
                var testLoadout2 = JSON.parse(JSON.stringify(loadout));
                testLoadout2.equippedHardware = hwRetry;
                var hwCheck = calculateAnalysis(testLoadout2, targetSwIds);
                var retryPower = 0;
                var retrySa = hwCheck.swAnalysis[bestHack.sw.id];
                if (retrySa) {
                    for (var rhi = 0; rhi < retrySa.abilities.length; rhi++) {
                        if (retrySa.abilities[rhi].type === 'HACK') { retryPower = retrySa.abilities[rhi].computedPower; break; }
                    }
                }
                if (retryPower >= serverDefenceRate) {
                    targetHw = hwRetry;
                    log('装备栏：找到更好硬件 — 破解算力：' + retryPower);
                } else {
                    log('装备栏：可达到的最高破解算力：' + retryPower + ' — 仍低于 serverDefenceRate(' + serverDefenceRate + ')', 'error');
                }
            }
        }

        log('装备栏：装备纯 HACK 软件"' + bestHack.sw.name + '" 用于重试');
        await applyLoadoutChange(loadout, targetHw, targetSwIds);
        return true;
    }

    // Decrypt errors: missing-software, File is encrypted, insufficient_power
    if (errorMsg.indexOf('missing-software') >= 0 || errorMsg.indexOf('File is encrypted') >= 0 ||
        errorMsg.indexOf('insufficient_power') >= 0 || errorMsg.indexOf('insufficient-power') >= 0) {
        var fileType = null;
        if (job.conditions && job.conditions.items) {
            for (var ci = 0; ci < job.conditions.items.length; ci++) {
                var cond = job.conditions.items[ci];
                if (cond.details && cond.details.fileExtension) {
                    fileType = cond.details.fileExtension;
                    if (fileType && fileType[0] !== '.') fileType = '.' + fileType;
                    break;
                }
            }
        }
        if (!fileType && job.fileType) fileType = job.fileType;
        if (!fileType) {
            var extMatch = errorMsg.match(/decrypt\s+(\.\w+)\s+extension/i);
            if (extMatch) fileType = extMatch[1];
        }
        if (!fileType) {
            log('装备栏：解密失败但文件类型未知 — 跳过软件更换', 'warn');
            return false;
        }

        var requiredPower = (errorObj && errorObj.required) || 0;
        var availablePower = (errorObj && errorObj.available) || 0;
        var isInsufficientPower = errorMsg.indexOf('insufficient_power') >= 0 || errorMsg.indexOf('insufficient-power') >= 0;
        if (isInsufficientPower && requiredPower > 0) {
            log('装备栏：解密算力不足 — 需要：' + requiredPower + '，可用： ' + availablePower);
        }

        var candidates = findDecryptSoftwareForFileType(allSw, fileType);
        if (candidates.length === 0) {
            log('装备栏：无可用解密软件：' + fileType, 'warn');
            return false;
        }

        var best = candidates[0];
        var targetSwIds = [best.sw.id];

        if (equippedSwIds.length === 1 && equippedSwIds[0] === best.sw.id && isInsufficientPower) {
            log('装备栏：最佳解密软件“' + best.sw.name + '" 已单独装备 — 尝试升级硬件提升算力');
            var betterHw = findBestHardware(loadout, targetSwIds);
            if (!betterHw) {
                log('装备栏: 未能将破解算力提升到所需等级 (' + requiredPower + '）— 没有更好的硬件可用', 'error');
                return false;
            }
            var testLoadout = JSON.parse(JSON.stringify(loadout));
            testLoadout.equippedHardware = betterHw;
            var hwAnalysis = calculateAnalysis(testLoadout, targetSwIds);
            if (!hwAnalysis.canBoot) {
                log('装备栏: 未能将破解算力提升到所需等级 (' + requiredPower + '）— 换更好的硬件也启动不了', 'error');
                return false;
            }
            var sa = hwAnalysis.swAnalysis[best.sw.id];
            if (sa) {
                var decryptPower = 0;
                for (var ai = 0; ai < sa.abilities.length; ai++) {
                    if (sa.abilities[ai].type === 'DECRYPT') {
                        decryptPower = sa.abilities[ai].computedPower;
                        break;
                    }
                }
                log('装备栏：换更好硬件后解密算力可达 ' + decryptPower + ' (需要: ' + requiredPower + ')');
                if (decryptPower < requiredPower) {
                    log('装备栏: 未能将破解算力提升到所需等级 (' + requiredPower + ') — 可达最佳: ' + decryptPower, 'error');
                    return false;
                }
            }
            log('装备栏：更换硬件以提升解密算力：' + fileType);
            await applyLoadoutChange(loadout, betterHw, targetSwIds);
            return true;
        }

        if (equippedSwIds.length === 1 && equippedSwIds[0] === best.sw.id) {
            log('装备栏：最佳解密软件已单独装备 — 没有提升空间', 'warn');
            return false;
        }

        var currentHw = loadout.equippedHardware || {};
        var analysis = calculateAnalysis(loadout, targetSwIds);
        var targetHw = currentHw;
        if (!analysis.canBoot) {
            var betterHw2 = findBestHardware(loadout, targetSwIds);
            if (betterHw2) {
                targetHw = betterHw2;
            } else {
                log('装备栏：纯解密软件启动失败：' + fileType + ' — 资源不足', 'warn');
                return false;
            }
        }

        if (isInsufficientPower && requiredPower > 0) {
            var testLoadout2 = JSON.parse(JSON.stringify(loadout));
            testLoadout2.equippedHardware = targetHw;
            var preCheck = calculateAnalysis(testLoadout2, targetSwIds);
            var sa2 = preCheck.swAnalysis[best.sw.id];
            if (sa2) {
                var dp2 = 0;
                for (var ai2 = 0; ai2 < sa2.abilities.length; ai2++) {
                    if (sa2.abilities[ai2].type === 'DECRYPT') { dp2 = sa2.abilities[ai2].computedPower; break; }
                }
                log('装备栏：新装备栏预计解密算力：' + dp2 + ' (需要: ' + requiredPower + ')');
                if (dp2 < requiredPower) {
                    var hwRetry = findBestHardware(loadout, targetSwIds);
                    if (hwRetry) {
                        var testLoadout3 = JSON.parse(JSON.stringify(loadout));
                        testLoadout3.equippedHardware = hwRetry;
                        var hwCheck = calculateAnalysis(testLoadout3, targetSwIds);
                        var sa3 = hwCheck.swAnalysis[best.sw.id];
                        if (sa3) {
                            var dp3 = 0;
                            for (var ai3 = 0; ai3 < sa3.abilities.length; ai3++) {
                                if (sa3.abilities[ai3].type === 'DECRYPT') { dp3 = sa3.abilities[ai3].computedPower; break; }
                            }
                            if (dp3 >= requiredPower) {
                                targetHw = hwRetry;
                                log('装备栏：找到更好硬件 — 解密算力：' + dp3);
                            } else {
                                log('装备栏: 未能将破解算力提升到所需等级 (' + requiredPower + ') — 可达最佳: ' + dp3, 'error');
                                return false;
                            }
                        }
                    } else {
                        log('装备栏: 未能将破解算力提升到所需等级 (' + requiredPower + ') — 可达最佳: ' + dp2, 'error');
                        return false;
                    }
                }
            }
        }

        log('装备栏：装备纯解密软件“' + best.sw.name + '"，将在此重试： ' + fileType);
        await applyLoadoutChange(loadout, targetHw, targetSwIds);
        return true;
    }

    return false;
}

// ---- Job label formatting ----

export function jobLabel(job) {
    var parts = [job.name || job.type];
    if (job.serverName && job.serverName !== 'None') parts.push('开 ' + job.serverName);
    var mkt = MARKET_DISPLAY_NAMES[job.marketKey] || '';
    if (mkt) parts.push('[' + mkt + ']');
    return parts.join(' ');
}

export function jobConditionsRequireDecrypt(job) {
    if (!job.conditions) return false;
    for (var i = 0; i < job.conditions.length; i++) {
        var cond = job.conditions[i];
        if (cond.type === 'DecryptFile' || cond.type === 'DecryptDownloadedFile') return true;
    }
    return false;
}

export function extractFileInfoFromConditions(job) {
    if (!job.conditions) return null;
    for (var i = 0; i < job.conditions.length; i++) {
        var cond = job.conditions[i];
        if ((cond.type === 'DecryptFile' || cond.type === 'DecryptDownloadedFile') && cond.details && cond.details.files && cond.details.files.length > 0) {
            return cond.details.files[0];
        }
    }
    return null;
}

// ---- Shared minigame helpers (used by multiple solvers) ----

export function waitForMinigameOrError(timeoutMs) {
    return new Promise(function (resolve) {
        var done = false;
        var timer = safeTimeout(function () { if (!done) { done = true; cleanup(); resolve({ timeout: true }); } }, timeoutMs);
        function onDesktopFile(evt) {
            if (!evt.data || done) return;
            if (evt.data.type === 'COR3_AUTOJOB_DESKTOP_FILE' && evt.data.error) {
                done = true; cleanup(); resolve({ error: evt.data.error });
            }
        }
        function onMinigame(evt) {
            if (!evt.data || done) return;
            if (evt.data.type === 'COR3_AUTOJOB_MINIGAME_LOCKED') {
                done = true; cleanup(); resolve({ locked: evt.data.data });
            } else if (evt.data.type === 'COR3_AUTOJOB_MINIGAME_START') {
                done = true; cleanup(); resolve({ minigame: evt.data });
            }
        }
        function cleanup() { safeClearTimeout(timer); window.removeEventListener('message', onDesktopFile); window.removeEventListener('message', onMinigame); }
        window.addEventListener('message', onDesktopFile);
        window.addEventListener('message', onMinigame);
    });
}

export function throwMinigameLockError(lockData) {
    var lockInfo = formatMinigameLockError(lockData);
    if (lockInfo) {
        log('🔒 Minigame locked — ' + lockInfo.message, 'warn');
        var lockErr = new Error('minigame-locked: ' + lockInfo.message);
        lockErr.lockExpiresAt = lockInfo.lockExpiresAt;
        lockErr.remainingMs = lockInfo.remainingMs;
        throw lockErr;
    }
}
