// Server access helpers for auto-valuable-seller.
// Handles endpoint setting, login/hack flow, path-through hacking,
// and maintenance checks.

import {
    sendCmd, delay, waitForEvent, log, humanDelay,
    running,
    _cachedMapData, setCachedMapData,
    _loginStatusCache, LOGIN_STATUS_CACHE_TTL,
    SERVER_PATH_MAP,
    getServerName, ensureSolversEnabled,
    waitForHackToBeDone
} from './state.js';

import { ensureHackOnlyLoadout, tryHackLoadoutSwap } from './loadout.js';
import { isHackMinigameOpen } from '../shared/hack-utils.js';

// ---- Maintenance check ----

export async function checkPathMaintenance(serverName) {
    var path = SERVER_PATH_MAP[serverName];
    if (!path || path.length === 0) return { blocked: false };
    var mapData = _cachedMapData;
    if (!mapData) {
        sendCmd('get.map', {});
        try {
            mapData = await waitForEvent('COR3_WS_NETWORK_MAP', 10000);
            setCachedMapData(mapData);
        } catch (e) {
            log('\u26a0\ufe0f 无法获取网络地图：' + e.message, 'warn');
            return { blocked: false };
        }
    }
    if (mapData && mapData.servers) {
        for (var i = 0; i < path.length; i++) {
            var srv = path[i];
            var info = mapData.servers[srv.id];
            if (info && info.isInMaintenance) {
                var remaining = info.maintenanceEndsAt ? new Date(info.maintenanceEndsAt).getTime() - Date.now() : 0;
                if (remaining > 0) {
                    return { blocked: true, blockerName: srv.name, remainingMs: remaining };
                }
            }
        }
    }
    return { blocked: false };
}

// ---- Internal: send set.endpoint and wait for result ----

async function _sendSetEndpoint(serverId) {
    sendCmd('set.endpoint', { serverId: serverId });
    return await new Promise(function (resolve) {
        var timer;
        function endpointHandler(evt) {
            if (evt.data && evt.data.type === 'COR3_WS_ENDPOINT_RESULT') {
                cleanup();
                if (evt.data.success === false && evt.data.error &&
                    (evt.data.error.message === 'no-path-to-server' || evt.data.error.message === 'server-in-maintenance')) {
                    resolve({ ok: false, unreachable: true, errorMsg: evt.data.error.message });
                } else {
                    resolve({ ok: true, data: evt.data });
                }
            }
            if (evt.data && (evt.data.type === 'COR3_WS_DARK_MARKET_UNREACHABLE' || evt.data.type === 'COR3_WS_SOYUZ_MARKET_UNREACHABLE' || evt.data.type === 'COR3_WS_USOL_MARKET_UNREACHABLE')) {
                cleanup();
                resolve({ ok: false, unreachable: true });
            }
        }
        function cleanup() {
            window.removeEventListener('message', endpointHandler);
            clearTimeout(timer);
        }
        window.addEventListener('message', endpointHandler);
        timer = setTimeout(function () {
            window.removeEventListener('message', endpointHandler);
            resolve({ ok: true, timeout: true });
        }, 10000);
    });
}

export { _sendSetEndpoint };

// ---- Find path map entry for server name ----

function getPathForServerName(serverName) {
    var path = SERVER_PATH_MAP[serverName];
    if (path && path.length > 0) return path;
    return null;
}

// ---- Set endpoint with path-through hack on unreachable ----

export async function setEndpoint(serverId) {
    var name = getServerName(serverId);
    log('正在设置端点为 ' + name);
    var raceResult = await _sendSetEndpoint(serverId);

    if (raceResult.unreachable) {
        if (raceResult.errorMsg === 'server-in-maintenance') {
            log(name + ' 维护中 — 跳过', 'error');
            return false;
        }
        // Try path-through: hack intermediate servers on the path
        var path = getPathForServerName(name);
        if (!path || path.length <= 1) {
            var noPathCheck = await checkPathMaintenance(name);
            if (noPathCheck.blocked) {
                var nMins = Math.ceil(noPathCheck.remainingMs / 60000);
                log(name + ' 不可达 (' + noPathCheck.blockerName + ' 维护中, ~' + nMins + '分剩余)', 'error');
                return false;
            }
            log(name + ' 不可达 (无通往服务器的路径)', 'error');
            return false;
        }
        log('\u26a1 服务器不可达——尝试穿透破解（' + path.length + ' 个路径上的服务器)');
        // Walk through each intermediate server (excluding the target itself which is the last)
        for (var pi = 0; pi < path.length - 1; pi++) {
            var intermediate = path[pi];
            log('\u26a1 穿透：设置端点为 ' + intermediate.name + ' (' + (pi + 1) + '/' + (path.length - 1) + ')');
            var intResult = await _sendSetEndpoint(intermediate.id);
            if (intResult.unreachable) {
                var intCheck = await checkPathMaintenance(intermediate.name);
                var intMsg = intermediate.name + ' 不可达';
                if (intCheck.blocked) {
                    var iMins = Math.ceil(intCheck.remainingMs / 60000);
                    intMsg += ' (' + intCheck.blockerName + ' 维护中, ~' + iMins + '分剩余)';
                }
                log('\u26a1 穿透：' + intMsg, 'warn');
                return false;
            }
            await delay(humanDelay());
            // Login/hack to this intermediate server
            if (!await loginOrHack(intermediate.id)) {
                log('\u26a1 穿透：登录/破解在以下节点失败 ' + intermediate.name, 'warn');
                return false;
            }
            await delay(humanDelay());
        }
        // Retry the original endpoint
        log('\u26a1 穿透完成——重试端点以连接目标服务器');
        raceResult = await _sendSetEndpoint(serverId);
        if (raceResult.unreachable) {
            if (raceResult.errorMsg === 'server-in-maintenance') {
                log(name + ' 维护中 — 放弃穿透', 'error');
                return false;
            }
            var finalCheck = await checkPathMaintenance(name);
            if (finalCheck.blocked) {
                var fMins = Math.ceil(finalCheck.remainingMs / 60000);
                log(name + ' 穿透后仍不可达（' + finalCheck.blockerName + ' 维护中, ~' + fMins + '分剩余)', 'error');
            } else {
                log(name + ' 穿透破解后仍不可达', 'error');
            }
            return false;
        }
    }

    if (raceResult.timeout) {
        log('端点设置超时(可能已设置)', 'warn');
    }
    await delay(humanDelay());
    return true;
}

// ---- Check login status for a server (cached) ----

export async function getLoginStatus(serverId, forceRefresh) {
    if (!forceRefresh) {
        var cached = _loginStatusCache[serverId];
        if (cached && (Date.now() - cached.ts) < LOGIN_STATUS_CACHE_TTL) {
            return cached.data;
        }
    }
    sendCmd('get.login.status', { serverId: serverId });
    try {
        var resp = await waitForEvent('COR3_AUTOJOB_SAI_LOGIN_STATUS', 10000);
        if (resp.error) return null;
        var data = resp.data || null;
        _loginStatusCache[serverId] = { data: data, ts: Date.now() };
        return data;
    } catch (e) {
        return null;
    }
}

// ---- Internal: attempt a hack ----

async function _attemptHack(serverId, name) {
    log('开始破解 ' + name);
    ensureSolversEnabled();
    await delay(300);
    sendCmd('hack.start', { serverId: serverId });

    var hackResult;
    try {
        hackResult = await new Promise(function (resolve, reject) {
            var done = false;
            var timer = setTimeout(function () {
                if (!done) { done = true; window.removeEventListener('message', onMsg); reject(new Error('超时')); }
            }, 30000);
            function onMsg(evt) {
                if (!evt.data) return;
                if (evt.data.type === 'COR3_AUTOJOB_SAI_HACK_START') {
                    if (!done) { done = true; clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(evt.data); }
                } else if (evt.data.type === 'COR3_AUTOJOB_MINIGAME_START') {
                    if (!done) { done = true; clearTimeout(timer); window.removeEventListener('message', onMsg); resolve({ data: { minigameStarted: true }, error: null }); }
                }
            }
            window.addEventListener('message', onMsg);
        });
    } catch (e) {
        log('破解开始事件超时 — 检查破解是否已完成...', 'warn');
        var fallbackLogin = await getLoginStatus(serverId, true);
        if (fallbackLogin && fallbackLogin.activeAccesses && fallbackLogin.activeAccesses.length > 0) {
            var fbAccess = fallbackLogin.activeAccesses[0];
            log('破解已完成(发现 ' + (fbAccess.accessType || fbAccess.type || 'unknown') + ' 超时后访问) \u2014 正在登录', 'success');
            sendCmd('login.with-access', { serverId: serverId, accessGrantId: fbAccess.id });
            try { await waitForEvent('COR3_AUTOJOB_SAI_LOGIN_RESULT', 10000); } catch (e2) { /* proceed */ }
            await delay(humanDelay());
            return true;
        }
        log(name + '：破解启动超时', 'error');
        return false;
    }

    if (hackResult.error) {
        var errMsg = hackResult.error.message || JSON.stringify(hackResult.error);
        log('破解返回错误：' + errMsg + ' \u2014 正在检查访问权限...', 'warn');
        var errLogin = await getLoginStatus(serverId, true);
        if (errLogin && errLogin.activeAccesses && errLogin.activeAccesses.length > 0) {
            var errAccess = errLogin.activeAccesses[0];
            log('已拥有 ' + (errAccess.accessType || errAccess.type || 'unknown') + ' 破解出错但已有访问 \u2014 正在登录', 'success');
            sendCmd('login.with-access', { serverId: serverId, accessGrantId: errAccess.id });
            try { await waitForEvent('COR3_AUTOJOB_SAI_LOGIN_RESULT', 10000); } catch (e2) { /* proceed */ }
            await delay(humanDelay());
            return true;
        }
        if (errMsg.indexOf('sai-hack-impossible') >= 0 || errMsg.indexOf('sai-no-hack-software') >= 0) {
            return 'retry-loadout';
        }
        log(name + '：破解失败： ' + errMsg, 'error');
        return false;
    }

    if (hackResult.data && hackResult.data.autoHacked) {
        log('服务器已自动破解（无小游戏）\u2014 跳过等待求解器', 'success');
    } else if (hackResult.data && hackResult.data.minigameStarted) {
        log('通过小游戏事件检测到破解小游戏');
        await waitForHackToBeDone();
    } else {
        await waitForHackToBeDone();
    }

    await delay(humanDelay());
    var maxRetries = 3;
    for (var attempt = 0; attempt < maxRetries; attempt++) {
        var postHackLogin = await getLoginStatus(serverId, true);
        if (postHackLogin && postHackLogin.activeAccesses && postHackLogin.activeAccesses.length > 0) {
            var postHackAccess = postHackLogin.activeAccesses[0];
            var postHackType = postHackAccess.accessType || postHackAccess.type || 'unknown';
            sendCmd('login.with-access', { serverId: serverId, accessGrantId: postHackAccess.id });
            try {
                await waitForEvent('COR3_AUTOJOB_SAI_LOGIN_RESULT', 10000);
            } catch (e) { /* proceed anyway */ }
            log('已登录：' + name + ' (' + postHackType + ')', 'success');
            return true;
        } else {
            log('破解后没有有效访问（尝试 ' + (attempt + 1) + '/' + maxRetries + '), 正在重试...', 'warn');
            await delay(5000);
        }
    }
    log(name + '：破解后无有效访问权限（' + maxRetries + ' 次尝试) \u2014 破解可能已失败', 'error');
    return false;
}

// ---- Login/hack to a server (used by path-through and ensureServerAccess) ----

export async function loginOrHack(serverId) {
    var name = getServerName(serverId);
    log('正在检查登录状态 ' + name);
    var loginData = await getLoginStatus(serverId);

    // Check for active access
    if (loginData && loginData.activeAccesses && loginData.activeAccesses.length > 0) {
        var accessObj = loginData.activeAccesses[0];
        var accessId = accessObj.id;
        var accessType = accessObj.accessType || accessObj.type || 'unknown';
        log('使用已有访问：' + name + ' (' + accessType + ')');
        sendCmd('login.with-access', { serverId: serverId, accessGrantId: accessId });
        try {
            var loginResult = await waitForEvent('COR3_AUTOJOB_SAI_LOGIN_RESULT', 10000);
            if (loginResult.error || !(loginResult.data && loginResult.data.success)) {
                log(name + '：带权限登录失败', 'warn');
                return false;
            }
        } catch (e) {
            log(name + '：带权限登录超时', 'warn');
            return false;
        }
        log('通过已有访问登录：' + name, 'success');
        return true;
    }

    var loginDefenceRate = (loginData && loginData.serverDefenceRate) ? loginData.serverDefenceRate : 0;
    var loginHackPower = 0;
    if (loginData && loginData.hackTools && loginData.hackTools.length > 0) {
        loginHackPower = loginData.hackTools[0].hackPower || 0;
        log('破解信息 \u2014 serverDefenceRate: ' + loginDefenceRate + ', 已装备破解算力: ' + loginHackPower + ' (' + (loginData.hackTools[0].name || 'unknown') + ')' + (loginDefenceRate > 0 ? (loginHackPower >= loginDefenceRate ? ' \u2713' : ' \u2717 不足') : ''));
    } else if (loginDefenceRate > 0) {
        log('破解信息 \u2014 serverDefenceRate: ' + loginDefenceRate + ', 未装备破解工具', 'warn');
    }

    log('无有效访问：' + name + ' \u2014 正在装备破解配装');
    var loadoutResult = await ensureHackOnlyLoadout(serverId, getLoginStatus);
    if (loadoutResult && !loadoutResult.ok && loadoutResult.reason === 'insufficient-power') {
        log(name + '：跳过（破解算力 ' + loadoutResult.hackPower + ' < serverDefenceRate ' + loadoutResult.defenceRate + ')', 'error');
        return false;
    }
    await delay(humanDelay());

    var MAX_HACK_ATTEMPTS = 6;
    for (var hackAttempt = 1; hackAttempt <= MAX_HACK_ATTEMPTS; hackAttempt++) {
        if (!running) { return false; }
        if (hackAttempt > 1) {
            log('破解尝试 ' + hackAttempt + '/' + MAX_HACK_ATTEMPTS + ' 在 ' + name, 'warn');
        }

        var hackAttemptResult = await _attemptHack(serverId, name);
        if (hackAttemptResult === true) return true;

        if (hackAttemptResult === 'retry-loadout') {
            log(name + '：破解失败 sai-hack-impossible — 尝试切换装备栏后重试');
            var swapResult = await tryHackLoadoutSwap(serverId, getLoginStatus);
            if (!swapResult) {
                log(name + '：切换装备栏失败 — 跳过（无访问权限）', 'error');
                return false;
            }
            await delay(humanDelay());
            continue;
        }

        if (hackAttempt < MAX_HACK_ATTEMPTS) {
            log(name + '：破解失败 — 将重试（' + hackAttempt + '/' + MAX_HACK_ATTEMPTS + ')', 'warn');
            await delay(2000);
            continue;
        }
    }

    log(name + '：破解失败，已重试 ' + MAX_HACK_ATTEMPTS + ' 次尝试 \u2014 未获得访问权限', 'error');
    return false;
}

// ---- Ensure server access: set endpoint -> check login -> hack if needed ----

export async function ensureServerAccess(serverId) {
    var name = getServerName(serverId);
    log('正在确保访问 ' + name);

    // Check maintenance
    if (SERVER_PATH_MAP[name]) {
        var maint = await checkPathMaintenance(name);
        if (maint.blocked) {
            log('\u26a0\ufe0f ' + name + ' 不可达 \u2014 ' + maint.blockerName + ' 维护中', 'warn');
            return false;
        }
    }

    // Set endpoint (includes path-through hacking if unreachable)
    if (!await setEndpoint(serverId)) return false;

    // Login or hack
    return await loginOrHack(serverId);
}
