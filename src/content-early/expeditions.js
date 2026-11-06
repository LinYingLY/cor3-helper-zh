// Expedition-related functions: request, respond, archive, mercs, launch, collect
import { USOL_MARKET_ID, USOL_SERVER_ID } from './state.js';
import { wsSend, enterRooms, humanDelay, queueRetryOp } from './ws-send.js';
import { __cor3FetchMapData, __cor3FindPathsToServer, __cor3EnsureServerAccess, __cor3WaitForMsg, __cor3PostUnreachable } from './market-requests.js';

var DEFAULT_LOCATION_NAMES = ['Skylift Remains', 'Koute Mining and Reprocessing Outpost'];

window.__cor3PickDefaultLocation = function (locations) {
    if (!locations || locations.length === 0) return null;
    if (locations.length === 1) return locations[0];
    var def = null;
    for (var i = 0; i < locations.length; i++) {
        if (DEFAULT_LOCATION_NAMES.indexOf(locations[i].name) !== -1) { def = locations[i]; break; }
    }
    return def || locations[0];
};

window.__cor3PickLocationConfig = function (locations) {
    var loc = window.__cor3PickDefaultLocation(locations);
    if (!loc) return { locationConfigId: null, zoneConfigId: null, goalId: null };
    var zone0 = loc.zones && loc.zones[0] ? loc.zones[0] : null;
    var goal0 = zone0 && zone0.goals && zone0.goals[0] ? zone0.goals[0] : null;
    return { locationConfigId: loc.id, zoneConfigId: zone0 ? zone0.id : null, goalId: goal0 ? goal0.id : null };
};

// Global variables to store versions as fallback
window.__cor3WebVersion = null;
window.__cor3SystemVersion = null;
window.__cor3PatchVersion = null;
window.__cor3DownloadFolderId = null;

// Send expedition request through any open tracked socket
// Joining the expedition room triggers the server to respond with get.active data.
// We track whether data already arrived to avoid sending a duplicate get.active.
window.__cor3RequestExpeditions = function () {
    console.log('[COR3 Helper] 正在请求远征数据');
    var gotData = false;
    // Listen for the response — if it arrives from room join alone, skip manual send
    var onExpData = function (evt) {
        if (evt.data && evt.data.type === 'COR3_WS_EXPEDITIONS') {
            gotData = true;
            window.removeEventListener('message', onExpData);
        }
    };
    window.addEventListener('message', onExpData);

    enterRooms(['expeditions']).then(function () {
        // Wait a bit — if data already arrived from room join, skip the manual send
        setTimeout(function () {
            window.removeEventListener('message', onExpData);
            if (!gotData) {
                var msg = '42["event",{"event":{"name":"expeditions","action":"get.active"}}]';
                wsSend(msg);
            }
        }, 2000);
    });
    return true;
};

// Send decision response via WS
window.__cor3RespondDecision = function (expeditionId, messageId, selectedOption) {
    var payload = JSON.stringify({
        expeditionId: expeditionId,
        messageId: messageId,
        selectedOption: selectedOption
    });
    var msg = '42["event",{"event":{"name":"expeditions","action":"respond.event"},"data":' + payload + '}]';
    console.log('[COR3 Helper] 正在发送决策响应：', selectedOption);
    var sent = wsSend(msg);
    if (!sent) {
        // Queue for retry if socket is down (token-expired)
        queueRetryOp('decision:' + payload);
    }
    return sent;
};

// Request archived expeditions
window.__cor3RequestArchivedExpeditions = function () {
    console.log('[COR3 Helper] 正在请求已归档远征');
    var msg = '42["event",{"event":{"name":"expeditions","action":"get.archived"},"data":{"cursor":null,"limit":20}}]';
    wsSend(msg);
    return true;
};

// CORE merc abort handle for cancelling in-flight requests
var coreMercAbort = null;

// Request mercenary data: get.mercenaries → (get.config if needed) → configure each merc sequentially
window.__cor3RequestMercenaries = function (marketId, callback) {
    if (window.__cor3CoreMercFetchInProgress) {
        console.log('[COR3 Helper] CORE 佣兵获取已在进行中 — 中止上一次');
        if (coreMercAbort) coreMercAbort();
    }
    var mid = marketId || window.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
    console.log('[COR3 Helper] 正在为该市场开始获取 CORE 佣兵数据：', mid);
    window.__cor3CoreMercFetchInProgress = true;

    var aborted = false;
    coreMercAbort = function () {
        aborted = true;
        window.__cor3CoreMercFetchInProgress = false;
        window.removeEventListener('message', onCoreData);
        clearTimeout(coreTimer);
        coreMercAbort = null;
    };

    var getMercs = '42["event",{"event":{"name":"expeditions","action":"get.mercenaries"},"data":{"marketId":"' + mid + '"}}]';
    wsSend(getMercs);
    setTimeout(function () {
        if (aborted) return;
        var getConfig = '42["event",{"event":{"name":"expeditions","action":"get.config"},"data":{"marketId":"' + mid + '"}}]';
        wsSend(getConfig);
    }, humanDelay());

    var coreMercData = null;
    var coreConfigData = null;
    var coreDone = false;
    function onCoreData(evt) {
        if (aborted || coreDone) return;
        if (!evt.data) return;
        if (evt.data.type === 'COR3_WS_MERCENARIES') {
            coreMercData = evt.data.data;
            checkAndConfigureCore();
        }
        if (evt.data.type === 'COR3_WS_EXPEDITION_CONFIG') {
            coreConfigData = window.__cor3PickLocationConfig(evt.data.data && evt.data.data.locations);
            window.__cor3ExpConfigIds = coreConfigData;
            checkAndConfigureCore();
        }
    }
    function checkAndConfigureCore() {
        if (!coreMercData || !coreConfigData) return;
        coreDone = true;
        window.removeEventListener('message', onCoreData);
        clearTimeout(coreTimer);
        var configIds = coreConfigData;
        var allMercIds = [];
        if (coreMercData.mercenaries) {
            allMercIds = coreMercData.mercenaries.map(function (m) { return m.id; });
        }
        if (coreMercData.eliteSlots) {
            coreMercData.eliteSlots.forEach(function (es) {
                if (es.mercenary && allMercIds.indexOf(es.mercenary.id) === -1) {
                    allMercIds.push(es.mercenary.id);
                }
            });
        }
        console.log('[COR3 Helper] 正在配置 ' + allMercIds.length + ' 个 CORE 佣兵');
        (function configureNext(i) {
            if (aborted || i >= allMercIds.length) {
                window.__cor3CoreMercFetchInProgress = false;
                coreMercAbort = null;
                if (!aborted) {
                    console.log('[COR3 Helper] CORE 佣兵配置完成');
                    if (callback) callback();
                }
                return;
            }
            window.__cor3RequestMercConfigure(allMercIds[i], mid, configIds.locationConfigId, configIds.zoneConfigId, configIds.goalId);
            function onConfigResponse(evt3) {
                if (aborted) { window.removeEventListener('message', onConfigResponse); return; }
                if (evt3.data && evt3.data.type === 'COR3_WS_MERC_CONFIGURE') {
                    window.removeEventListener('message', onConfigResponse);
                    clearTimeout(configTimeout);
                    setTimeout(function () { configureNext(i + 1); }, 200);
                }
            }
            window.addEventListener('message', onConfigResponse);
            var configTimeout = setTimeout(function () {
                window.removeEventListener('message', onConfigResponse);
                configureNext(i + 1);
            }, 5000);
        })(0);
    }
    window.addEventListener('message', onCoreData);
    var coreTimer = setTimeout(function () {
        if (!coreDone && !aborted) {
            coreDone = true;
            window.removeEventListener('message', onCoreData);
            window.__cor3CoreMercFetchInProgress = false;
            coreMercAbort = null;
            console.log('[COR3 Helper] CORE 佣兵数据获取超时');
            if (callback) callback();
        }
    }, 30000);
    return true;
};

// Request expedition config (returns location/zone/goal IDs)
window.__cor3RequestExpeditionConfig = function (marketId) {
    var mid = marketId || window.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
    console.log('[COR3 Helper] 正在请求该市场的远征配置：', mid);
    var msg = '42["event",{"event":{"name":"expeditions","action":"get.config"},"data":{"marketId":"' + mid + '"}}]';
    wsSend(msg);
    return true;
};

// Track pending mercenary configure requests (queue of mercenaryIds)
window.__cor3PendingMercConfigures = [];

// Request mercenary configure details (cost, risk, chances)
window.__cor3RequestMercConfigure = function (mercenaryId, marketId, locationConfigId, zoneConfigId, goalId) {
    var mid = marketId || window.__cor3LastMarketId || '019d3ea4-85bd-7389-904d-8f7c85841134';
    console.log('[COR3 Helper] 正在请求配置佣兵：', mercenaryId);
    window.__cor3PendingMercConfigures.push(mercenaryId);
    var data = {
        mercenaryId: mercenaryId,
        marketId: mid,
        locationConfigId: locationConfigId,
        zoneConfigId: zoneConfigId,
        goalId: goalId,
        hasInsurance: false
    };
    var msg = '42["event",{"event":{"name":"expeditions","action":"configure"},"data":' + JSON.stringify(data) + '}]';
    wsSend(msg);
    return true;
};

// USOL merc abort handle for cancelling in-flight requests
var usolMercAbort = null;

// Request USOL mercenary data: set endpoint → get.mercenaries → (get.config if needed) → configure each merc
window.__cor3RequestUsolMercenaries = function (callback) {
    var cachedUnreachable = window.__cor3IsMarketUnreachable('usol');
    if (cachedUnreachable) {
        console.log('[COR3 Helper] USOL 市场已知不可达 (' + cachedUnreachable.blockerName + ' 维护中）— 跳过佣兵获取');
        window.postMessage({
            type: 'COR3_WS_USOL_MARKET_UNREACHABLE',
            error: 'no-path-to-server',
            blockerServerName: cachedUnreachable.blockerName,
            maintenanceEndsAt: cachedUnreachable.maintenanceEndsAt,
            cached: true
        }, '*');
        if (callback) callback();
        return true;
    }
    if (window.__cor3UsolMercFetchInProgress) {
        console.log('[COR3 Helper] USOL 佣兵获取已在进行中 — 中止上一次');
        if (usolMercAbort) usolMercAbort();
    }
    console.log('[COR3 Helper] 正在开始获取 USOL 佣兵数据');
    window.__cor3UsolMercFetchInProgress = true;

    var aborted = false;
    usolMercAbort = function () {
        aborted = true;
        window.__cor3UsolMercFetchInProgress = false;
        usolMercAbort = null;
    };

    var setEndpoint = '42["event",{"event":{"name":"network-map","action":"set.endpoint"},"data":{"serverId":"' + USOL_SERVER_ID + '"}}]';
    wsSend(setEndpoint);

    function fetchMercData() {
        setTimeout(function () {
            if (aborted) return;
            console.log('[COR3 Helper] 正在请求 USOL 佣兵');
            var getMercs = '42["event",{"event":{"name":"expeditions","action":"get.mercenaries"},"data":{"marketId":"' + USOL_MARKET_ID + '"}}]';
            wsSend(getMercs);
            setTimeout(function () {
                if (aborted) return;
                var getConfig = '42["event",{"event":{"name":"expeditions","action":"get.config"},"data":{"marketId":"' + USOL_MARKET_ID + '"}}]';
                wsSend(getConfig);
            }, humanDelay());
        }, humanDelay());

        var usolMercData = null;
        var usolConfigData = null;
        var usolDone = false;
        function onUsolData(evt2) {
            if (usolDone || aborted) return;
            if (!evt2.data) return;
            if (evt2.data.type === 'COR3_WS_USOL_MERCENARIES') {
                usolMercData = evt2.data.data;
                checkAndConfigure();
            }
            if (evt2.data.type === 'COR3_WS_USOL_EXPEDITION_CONFIG') {
                usolConfigData = window.__cor3PickLocationConfig(evt2.data.data && evt2.data.data.locations);
                window.__cor3UsolExpConfigIds = usolConfigData;
                checkAndConfigure();
            }
        }
        function checkAndConfigure() {
            if (!usolMercData || !usolConfigData) return;
            usolDone = true;
            window.removeEventListener('message', onUsolData);
            clearTimeout(usolTimer);
            var configIds = usolConfigData;
            var allMercIds = [];
            if (usolMercData.mercenaries) {
                allMercIds = usolMercData.mercenaries.map(function (m) { return m.id; });
            }
            if (usolMercData.eliteSlots) {
                usolMercData.eliteSlots.forEach(function (es) {
                    if (es.mercenary && allMercIds.indexOf(es.mercenary.id) === -1) {
                        allMercIds.push(es.mercenary.id);
                    }
                });
            }
            console.log('[COR3 Helper] 正在配置 ' + allMercIds.length + ' USOL 佣兵');
            (function configureNext(i) {
                if (aborted || i >= allMercIds.length) {
                    window.__cor3UsolMercFetchInProgress = false;
                    usolMercAbort = null;
                    if (!aborted) {
                        console.log('[COR3 Helper] USOL 佣兵配置完成');
                        if (callback) callback();
                    }
                    return;
                }
                window.__cor3RequestMercConfigure(allMercIds[i], USOL_MARKET_ID, configIds.locationConfigId, configIds.zoneConfigId, configIds.goalId);
                function onConfigResponse(evt3) {
                    if (aborted) { window.removeEventListener('message', onConfigResponse); return; }
                    if (evt3.data && evt3.data.type === 'COR3_WS_MERC_CONFIGURE') {
                        window.removeEventListener('message', onConfigResponse);
                        clearTimeout(configTimeout);
                        setTimeout(function () { configureNext(i + 1); }, 200);
                    }
                }
                window.addEventListener('message', onConfigResponse);
                var configTimeout = setTimeout(function () {
                    window.removeEventListener('message', onConfigResponse);
                    configureNext(i + 1);
                }, 5000);
            })(0);
        }
        window.addEventListener('message', onUsolData);
        var usolTimer = setTimeout(function () {
            if (!usolDone && !aborted) {
                usolDone = true;
                window.removeEventListener('message', onUsolData);
                window.__cor3UsolMercFetchInProgress = false;
                usolMercAbort = null;
                console.log('[COR3 Helper] USOL 佣兵数据获取超时');
                if (callback) callback();
            }
        }, 30000);
    }

    function startPathThroughThenRetry() {
        console.log('[COR3 助手] USOL 佣兵：端点不可达——启动动态穿透');
        __cor3FetchMapData().then(function (mapData) {
            if (aborted) return;
            if (!mapData) {
                console.log('[COR3 助手] USOL 佣兵穿透：地图数据超时——放弃');
                window.__cor3UsolMercFetchInProgress = false;
                usolMercAbort = null;
                __cor3PostUnreachable('usol', null);
                if (callback) callback();
                return;
            }
            var paths = __cor3FindPathsToServer(mapData.servers, mapData.connections, USOL_SERVER_ID);
            if (paths.length === 0) {
                console.log('[COR3 助手] USOL 佣兵穿透：无可用路径（维护封锁）');
                window.__cor3UsolMercFetchInProgress = false;
                usolMercAbort = null;
                __cor3PostUnreachable('usol', null);
                if (callback) callback();
                return;
            }
            console.log('[COR3 Helper] USOL 佣兵路径穿行：找到 ' + paths.length + ' 条路径');
            var pathIdx = 0;
            function tryNextPath() {
                if (aborted) return;
                if (pathIdx >= paths.length) {
                    console.log('[COR3 Helper] USOL 佣兵路径穿行：所有路径已用尽');
                    window.__cor3UsolMercFetchInProgress = false;
                    usolMercAbort = null;
                    __cor3PostUnreachable('usol', null);
                    if (callback) callback();
                    return;
                }
                var currentPath = paths[pathIdx];
                pathIdx++;
                var intermediates = currentPath.length > 1 ? currentPath.slice(0, currentPath.length - 1) : [];
                if (intermediates.length === 0) { retryEndpoint(); return; }
                var pathNames = currentPath.map(function (s) { return s.name; }).join(' → ');
                console.log('[COR3 助手] USOL 佣兵穿透：尝试路径 ' + pathIdx + '/' + paths.length + ': ' + pathNames);
                var stepIdx = 0;
                function nextStep() {
                    if (aborted) return;
                    if (stepIdx >= intermediates.length) { retryEndpoint(); return; }
                    var server = intermediates[stepIdx];
                    stepIdx++;
                    var setEp = '42["event",{"event":{"name":"network-map","action":"set.endpoint"},"data":{"serverId":"' + server.id + '"}}]';
                    wsSend(setEp);
                    __cor3WaitForMsg('COR3_WS_ENDPOINT_RESULT', 10000).then(function (epData) {
                        if (aborted) return;
                        if (epData.success === false) {
                            console.log('[COR3 Helper] USOL 佣兵路径穿行： ' + server.name + ' 不可达 — 尝试下一条路径');
                            tryNextPath();
                            return;
                        }
                        __cor3EnsureServerAccess(server.id, server.name).then(function () {
                            if (aborted) return;
                            setTimeout(nextStep, 500);
                        }).catch(function () {
                            tryNextPath();
                        });
                    }).catch(function () {
                        __cor3EnsureServerAccess(server.id, server.name).then(function () {
                            if (aborted) return;
                            setTimeout(nextStep, 500);
                        }).catch(function () {
                            tryNextPath();
                        });
                    });
                }
                nextStep();
            }
            function retryEndpoint() {
                if (aborted) return;
                console.log('[COR3 助手] USOL 佣兵穿透：正在重试端点');
                var setEp2 = '42["event",{"event":{"name":"network-map","action":"set.endpoint"},"data":{"serverId":"' + USOL_SERVER_ID + '"}}]';
                wsSend(setEp2);
                __cor3WaitForMsg('COR3_WS_ENDPOINT_RESULT', 10000).then(function (retryData) {
                    if (aborted) return;
                    if (retryData.success === false) {
                        console.log('[COR3 Helper] USOL 佣兵路径穿行：端点重试失败');
                        window.__cor3UsolMercFetchInProgress = false;
                        usolMercAbort = null;
                        __cor3PostUnreachable('usol', null);
                        if (callback) callback();
                        return;
                    }
                    console.log('[COR3 Helper] USOL 佣兵路径穿行：端点已设置 — 正在获取佣兵数据');
                    fetchMercData();
                }).catch(function () {
                    window.__cor3UsolMercFetchInProgress = false;
                    usolMercAbort = null;
                    console.log('[COR3 助手] USOL 佣兵穿透：重试超时');
                    if (callback) callback();
                });
            }
            tryNextPath();
        });
    }

    var handled = false;
    function onEndpointResult(evt) {
        if (handled || aborted) return;
        if (evt.data && evt.data.type === 'COR3_WS_ENDPOINT_RESULT') {
            handled = true;
            window.removeEventListener('message', onEndpointResult);
            clearTimeout(epTimer);
            if (evt.data.success === false) {
                startPathThroughThenRetry();
                return;
            }
            fetchMercData();
        }
        if (evt.data && evt.data.type === 'COR3_WS_USOL_MARKET_UNREACHABLE') {
            handled = true;
            window.removeEventListener('message', onEndpointResult);
            clearTimeout(epTimer);
            startPathThroughThenRetry();
        }
    }
    window.addEventListener('message', onEndpointResult);
    var epTimer = setTimeout(function () {
        if (!handled && !aborted) {
            handled = true;
            window.removeEventListener('message', onEndpointResult);
            window.__cor3UsolMercFetchInProgress = false;
            usolMercAbort = null;
            console.log('[COR3 Helper] USOL 佣兵端点超时');
            if (callback) callback();
        }
    }, 10000);
    return true;
};

// Configure and launch expedition with mercenary
// For non-HOME markets, set.endpoint to the market server first
window.__cor3LaunchExpedition = function (configData) {
    console.log('[COR3 Helper] 正在按配置发起远征：', configData);
    var marketId = configData.marketId;
    var needsEndpoint = marketId && marketId !== '019d3ea4-85bd-7389-904d-8f7c85841134'; // not HOME
    var serverId = null;
    if (marketId === USOL_MARKET_ID) serverId = USOL_SERVER_ID;

    function doConfigureAndLaunch() {
        var configureMsg = '42["event",{"event":{"name":"expeditions","action":"configure"},"data":' + JSON.stringify(configData) + '}]';
        wsSend(configureMsg);
        // After configure, launch after a delay (launch needs same data as configure)
        setTimeout(function () {
            var launchMsg = '42["event",{"event":{"name":"expeditions","action":"launch"},"data":' + JSON.stringify(configData) + '}]';
            wsSend(launchMsg);
            console.log('[COR3 Helper] 远征发起请求已发送');
        }, humanDelay() + 500);
    }

    if (needsEndpoint && serverId) {
        console.log('[COR3 Helper] 发起前正在将端点设为市场服务器：', serverId);
        var setEp = '42["event",{"event":{"name":"network-map","action":"set.endpoint"},"data":{"serverId":"' + serverId + '"}}]';
        wsSend(setEp);
        var epHandled = false;
        function onEpResult(evt) {
            if (epHandled) return;
            if (evt.data && evt.data.type === 'COR3_WS_ENDPOINT_RESULT') {
                epHandled = true;
                window.removeEventListener('message', onEpResult);
                clearTimeout(epTimeout);
                if (evt.data.success === false) {
                    console.log('[COR3 Helper] 发起远征时端点不可访问，中止');
                    return;
                }
                setTimeout(doConfigureAndLaunch, humanDelay());
            }
        }
        window.addEventListener('message', onEpResult);
        var epTimeout = setTimeout(function () {
            if (!epHandled) {
                epHandled = true;
                window.removeEventListener('message', onEpResult);
                console.log('[COR3 Helper] 发起远征时端点超时，仍继续执行');
                doConfigureAndLaunch();
            }
        }, 8000);
    } else {
        doConfigureAndLaunch();
    }
    return true;
};

// Open reward container for a completed expedition
window.__cor3OpenContainer = function (expeditionId) {
    console.log('[COR3 Helper] 正在为远征打开容器：', expeditionId);
    var msg = '42["event",{"event":{"name":"expeditions","action":"open.container"},"data":{"expeditionId":"' + expeditionId + '"}}]';
    wsSend(msg);
    return true;
};

// Collect all contents from an opened container
window.__cor3CollectAll = function (expeditionId) {
    console.log('[COR3 Helper] 正在从远征中全部收取：', expeditionId);
    var msg = '42["event",{"event":{"name":"expeditions","action":"collect.all"},"data":{"expeditionId":"' + expeditionId + '"}}]';
    wsSend(msg);
    return true;
};
