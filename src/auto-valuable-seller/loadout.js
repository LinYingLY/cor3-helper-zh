// Loadout orchestration for auto-valuable-seller.
// Uses shared pure-computation from loadout-resolver.js,
// combined with async WS interactions from state.js wired utilities.

import {
    sendCmd, delay, waitForEvent, log, humanDelay,
    _cachedLoadout, _cachedLoadoutAt, _lastLoadoutFetchAt,
    LOADOUT_COOLDOWN_MS,
    setCachedLoadout, setLastLoadoutFetchAt, invalidateLoadoutCache,
    getServerName
} from './state.js';

import {
    calculateAnalysis, findBestHardware,
    findHackSoftwareForServerType, findSearchSoftwareForServerType,
    getServerTypeName
} from '../shared/loadout-resolver.js';

// ---- Loadout data fetching ----

export async function getLoadoutData(forceRefresh) {
    if (!forceRefresh && _cachedLoadout && (Date.now() - _cachedLoadoutAt < 60000)) {
        return _cachedLoadout;
    }
    var sinceLastFetch = Date.now() - _lastLoadoutFetchAt;
    if (sinceLastFetch < LOADOUT_COOLDOWN_MS && _cachedLoadout) {
        return _cachedLoadout;
    }
    log('装备栏：通过 WS 请求最新数据...');
    setLastLoadoutFetchAt(Date.now());
    sendCmd('loadout.get', {});
    try {
        var resp = await waitForEvent('COR3_AUTOJOB_LOADOUT', 15000);
        if (resp.data) {
            setCachedLoadout(resp.data);
            return resp.data;
        }
    } catch (e) {
        log('装备栏：获取超时', 'warn');
    }
    return _cachedLoadout || null;
}

// ---- Apply loadout change (unequip/equip hardware+software) ----

export async function applyLoadoutChange(loadout, targetHw, targetSwIds) {
    log('装备栏：应用变更 — 目标软件数量：' + targetSwIds.length);
    var currentHw = loadout.equippedHardware || {};
    var currentSwIds = (loadout.equippedSoftware || []).map(function (s) { return s.id; });
    var changed = false;

    // 1. Unequip software that is NOT in targetSwIds
    for (var ui = 0; ui < currentSwIds.length; ui++) {
        if (targetSwIds.indexOf(currentSwIds[ui]) >= 0) continue;
        var unequipName = currentSwIds[ui];
        var eqSw = loadout.equippedSoftware || [];
        for (var un = 0; un < eqSw.length; un++) {
            if (eqSw[un].id === currentSwIds[ui]) { unequipName = eqSw[un].name + ' (' + currentSwIds[ui] + ')'; break; }
        }
        log('装备栏：卸下软件：' + unequipName);
        sendCmd('loadout.unequip.software', { moduleConfigId: currentSwIds[ui] });
        await waitForEvent('COR3_AUTOJOB_LOADOUT', 8000);
        await delay(500);
        changed = true;
    }

    // 2. Equip hardware if changed — smart order to avoid PSU rejection
    var hwChanges = [];
    var hwSlots = ['cpu', 'gpu', 'ram', 'psu'];
    for (var hci = 0; hci < hwSlots.length; hci++) {
        var hSlot = hwSlots[hci];
        var hCurId = currentHw[hSlot] ? currentHw[hSlot].id : null;
        var hTgtId = targetHw[hSlot] ? targetHw[hSlot].id : null;
        if (hTgtId && hTgtId !== hCurId) {
            var curConsume = 0, tgtConsume = 0;
            if (hSlot === 'cpu') { curConsume = currentHw.cpu ? (currentHw.cpu.specs.cpuConsuming || 0) : 0; tgtConsume = targetHw.cpu.specs.cpuConsuming || 0; }
            if (hSlot === 'gpu') { curConsume = currentHw.gpu ? (currentHw.gpu.specs.gpuConsuming || 0) : 0; tgtConsume = targetHw.gpu.specs.gpuConsuming || 0; }
            hwChanges.push({ slot: hSlot, id: hTgtId, name: targetHw[hSlot].name || hTgtId, delta: tgtConsume - curConsume, isPsu: hSlot === 'psu' });
        }
    }
    var psuUpgrade = hwChanges.find(function (c) { return c.isPsu && targetHw.psu && currentHw.psu && (targetHw.psu.specs.psuPower || 0) > (currentHw.psu.specs.psuPower || 0); });
    var orderedHwChanges = [];
    if (psuUpgrade) orderedHwChanges.push(psuUpgrade);
    hwChanges.sort(function (a, b) { return a.delta - b.delta; });
    for (var hoi = 0; hoi < hwChanges.length; hoi++) {
        if (hwChanges[hoi] !== psuUpgrade) orderedHwChanges.push(hwChanges[hoi]);
    }
    for (var hi = 0; hi < orderedHwChanges.length; hi++) {
        var hc = orderedHwChanges[hi];
        log('装备栏：正在装备 ' + hc.slot.toUpperCase() + ' \u2192 ' + hc.name);
        sendCmd('loadout.equip.hardware', { moduleConfigId: hc.id });
        await waitForEvent('COR3_AUTOJOB_LOADOUT', 8000);
        await delay(500);
        changed = true;
    }

    // 3. Equip target software
    for (var ei = 0; ei < targetSwIds.length; ei++) {
        var swName = '';
        var allSw = loadout.ownedSoftware || [];
        for (var k = 0; k < allSw.length; k++) {
            if (allSw[k].id === targetSwIds[ei]) { swName = allSw[k].name; break; }
        }
        log('装备栏：装备软件：' + swName + ' (' + targetSwIds[ei] + ')');
        sendCmd('loadout.equip.software', { moduleConfigId: targetSwIds[ei] });
        await waitForEvent('COR3_AUTOJOB_LOADOUT', 8000);
        await delay(500);
        changed = true;
    }

    if (changed) {
        return await getLoadoutData(true);
    }
    return loadout;
}

// ---- Ensure hack-only loadout for a server ----

export async function ensureHackOnlyLoadout(serverId, getLoginStatusFn) {
    var serverTypeName = getServerTypeName(serverId);
    if (!serverTypeName) {
        log('装备栏: 未能判断服务器类型: ' + getServerName(serverId) + ' \u2014 跳过破解配装');
        return { ok: false, reason: 'unknown-server-type' };
    }

    var serverDefenceRate = 0;
    try {
        var preLoginData = await getLoginStatusFn(serverId);
        if (preLoginData && preLoginData.serverDefenceRate) {
            serverDefenceRate = preLoginData.serverDefenceRate;
        }
    } catch (e) { }

    invalidateLoadoutCache();
    var loadout = await getLoadoutData(true);
    if (!loadout) {
        log('装备栏：获取装备栏数据失败 \u2014 不带破解装备继续', 'warn');
        return { ok: false, reason: 'no-loadout-data' };
    }

    var allSw = loadout.ownedSoftware || [];
    var equippedSwIds = (loadout.equippedSoftware || []).map(function (s) { return s.id; });
    var hackCandidates = findHackSoftwareForServerType(allSw, serverTypeName);
    log('装备栏：找到 ' + hackCandidates.length + ' 个破解候选: ' + serverTypeName + (hackCandidates.length > 0 ? ' \u2014 最佳：' + hackCandidates[0].sw.name + ' (算力 ' + (hackCandidates[0].spec.power || []).join('-') + ')' : ''));

    if (hackCandidates.length === 0) {
        log('装备栏：没有可用的破解软件：' + serverTypeName, 'warn');
        return { ok: false, reason: 'no-hack-software' };
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
        log('装备栏：当前硬件启动不了破解软件 \u2014 查找兼容硬件');
        var betterHw = findBestHardware(loadout, targetSwIds);
        if (betterHw) {
            targetHw = betterHw;
        } else {
            log('装备栏：破解软件启动失败 \u2014 跳过装备栏变更', 'warn');
            return { ok: false, reason: 'cannot-boot' };
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
        log('装备栏：破解算力比较 \u2014 hackPower：' + computedHackPower + ' vs serverDefenceRate: ' + serverDefenceRate + (computedHackPower >= serverDefenceRate ? ' \u2713' : ' \u2717 不足'));
    } else {
        log('装备栏：计算破解算力：' + computedHackPower + ' (serverDefenceRate 未知)');
    }

    if (serverDefenceRate > 0 && computedHackPower < serverDefenceRate) {
        log('装备栏：破解算力不足 \u2014 尝试升级硬件提升算力');
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
                log('装备栏：找到硬件升级 \u2014 破解算力：' + upgradedPower + ' vs serverDefenceRate: ' + serverDefenceRate + (upgradedPower >= serverDefenceRate ? ' \u2713' : ' ✗ 仍然不足'));
                if (upgradedPower < serverDefenceRate) {
                    log('装备栏：达不到所需破解算力(' + serverDefenceRate + '）\u2014 最佳可达： ' + upgradedPower, 'error');
                    return { ok: false, reason: 'insufficient-power', hackPower: upgradedPower, defenceRate: serverDefenceRate };
                }
            } else {
                log('装备栏：没有更好硬件 \u2014 最佳破解算力：' + computedHackPower, 'warn');
                return { ok: false, reason: 'insufficient-power', hackPower: computedHackPower, defenceRate: serverDefenceRate };
            }
        } else {
            log('装备栏：无可用硬件升级', 'warn');
            return { ok: false, reason: 'insufficient-power', hackPower: computedHackPower, defenceRate: serverDefenceRate };
        }
    }

    if (!alreadyBest || targetHw !== currentHw) {
        log('装备栏：装备破解软件“' + bestHack.sw.name + '" (算力 ' + (bestHack.spec.power || []).join('-') + ') 用于 ' + serverTypeName);
        await applyLoadoutChange(loadout, targetHw, targetSwIds);
    }
    return { ok: true, hackPower: computedHackPower, defenceRate: serverDefenceRate };
}

// ---- Ensure search-only loadout for a server ----

export async function ensureSearchOnlyLoadout(serverId) {
    var serverTypeName = getServerTypeName(serverId);
    if (!serverTypeName) {
        log('装备栏: 未能判断服务器类型: ' + getServerName(serverId) + ' \u2014 跳过搜寻配装');
        return;
    }

    invalidateLoadoutCache();
    var loadout = await getLoadoutData(true);
    if (!loadout) {
        log('装备栏：获取装备栏数据失败 \u2014 不带搜寻装备继续', 'warn');
        return;
    }

    var allSw = loadout.ownedSoftware || [];
    var equippedSwIds = (loadout.equippedSoftware || []).map(function (s) { return s.id; });
    var searchCandidates = findSearchSoftwareForServerType(allSw, serverTypeName);
    if (searchCandidates.length === 0) {
        log('装备栏：没有可用的搜寻软件：' + serverTypeName);
        return;
    }

    var bestSearch = searchCandidates[0];
    var targetSwIds = [bestSearch.sw.id];
    var bestHw = findBestHardware(loadout, targetSwIds);
    var targetHw = bestHw || loadout.equippedHardware || {};
    var finalAnalysis = calculateAnalysis(
        Object.assign({}, loadout, { equippedHardware: targetHw }),
        targetSwIds
    );
    if (!finalAnalysis.canBoot) {
        log('装备栏：搜寻软件启动失败 \u2014 跳过装备栏变更', 'warn');
        return;
    }
    var searchPower = 0;
    for (var swId in finalAnalysis.swAnalysis) {
        var ab = finalAnalysis.swAnalysis[swId].abilities;
        for (var ai = 0; ai < ab.length; ai++) {
            if (ab[ai].type === 'SEARCH') searchPower = ab[ai].computedPower;
        }
    }
    var swAlreadyOk = equippedSwIds.length === 1 && equippedSwIds[0] === bestSearch.sw.id;
    var curHw = loadout.equippedHardware || {};
    var hwAlreadyOk = (!bestHw) ||
        ((curHw.cpu && curHw.cpu.id) === (targetHw.cpu && targetHw.cpu.id) &&
         (curHw.gpu && curHw.gpu.id) === (targetHw.gpu && targetHw.gpu.id) &&
         (curHw.ram && curHw.ram.id) === (targetHw.ram && targetHw.ram.id) &&
         (curHw.psu && curHw.psu.id) === (targetHw.psu && targetHw.psu.id));
    if (swAlreadyOk && hwAlreadyOk) {
        log('装备栏：最佳搜寻软件“' + bestSearch.sw.name + '" 已装备最优硬件（算力： ' + searchPower + '/' + bestSearch.spec.power[1] + ')');
        return searchPower;
    }

    log('装备栏：装备搜寻软件“' + bestSearch.sw.name + '"（计算算力： ' + searchPower + '/' + bestSearch.spec.power[1] + ') 用于 ' + serverTypeName);
    await applyLoadoutChange(loadout, targetHw, targetSwIds);
    return searchPower;
}

// ---- Try hack loadout swap after sai-hack-impossible ----

export async function tryHackLoadoutSwap(serverId, getLoginStatusFn) {
    invalidateLoadoutCache();
    var loadout = await getLoadoutData(true);
    if (!loadout) {
        log('装备栏：重试失败 \u2014 没有装备栏数据', 'warn');
        return false;
    }

    var serverTypeName = getServerTypeName(serverId);
    if (!serverTypeName) {
        log('装备栏: 未能判断服务器类型: ' + getServerName(serverId), 'warn');
        return false;
    }

    var allSw = loadout.ownedSoftware || [];
    var equippedSwIds = (loadout.equippedSoftware || []).map(function (s) { return s.id; });
    var hackCandidates = findHackSoftwareForServerType(allSw, serverTypeName);
    if (hackCandidates.length === 0) {
        log('装备栏: 没有可用的破解软件: ' + serverTypeName, 'warn');
        return false;
    }

    var bestHack = hackCandidates[0];
    var targetSwIds = [bestHack.sw.id];

    var serverDefenceRate = 0;
    try {
        var loginStatus = await getLoginStatusFn(serverId, true);
        if (loginStatus && loginStatus.serverDefenceRate) {
            serverDefenceRate = loginStatus.serverDefenceRate;
        }
    } catch (e) { }

    if (equippedSwIds.length === 1 && equippedSwIds[0] === bestHack.sw.id) {
        log('装备栏：最佳破解软件"' + bestHack.sw.name + '" 已单独装备 \u2014 尝试升级硬件');
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
            log('装备栏：没有可用硬件升级 \u2014 破解算力已到上限' + (serverDefenceRate > 0 ? ' (需要 ' + serverDefenceRate + ', 当前 ' + currentHackPower + ')' : ''), 'error');
            return false;
        }
        var testLoadout = JSON.parse(JSON.stringify(loadout));
        testLoadout.equippedHardware = betterHw;
        var hwAnalysis = calculateAnalysis(testLoadout, targetSwIds);
        if (!hwAnalysis.canBoot) {
            log('装备栏：换更好硬件也启动失败 \u2014 放弃', 'error');
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
            log('装备栏：升级硬件也提升不了破解算力 \u2014 放弃', 'error');
            return false;
        }
        if (serverDefenceRate > 0 && upgradedHackPower < serverDefenceRate) {
            log('装备栏：升级硬件后仍不足 \u2014 需要：' + serverDefenceRate + ', 可达最佳: ' + upgradedHackPower, 'error');
            return false;
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
            log('装备栏：纯破解软件启动失败 \u2014 放弃', 'warn');
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
                log('装备栏：找到更好硬件 \u2014 破解算力：' + retryPower);
            } else {
                log('装备栏：可达到的最高破解算力：' + retryPower + ' \u2014 仍低于 serverDefenceRate(' + serverDefenceRate + ')', 'error');
                return false;
            }
        } else {
            log('装备栏：没有可用硬件升级 \u2014 达不到 serverDefenceRate（' + serverDefenceRate + ')', 'error');
            return false;
        }
    }

    log('装备栏：装备纯 HACK 软件"' + bestHack.sw.name + '" 用于重试');
    await applyLoadoutChange(loadout, targetHw, targetSwIds);
    return true;
}
