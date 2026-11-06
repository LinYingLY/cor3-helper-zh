// Seller mode for auto-valuable-seller.
// Downloads valuable files/logs from selected servers,
// then sells at markets in priority order.

import {
    log, delay, humanDelay,
    running,
    setCachedMapData, clearDesktopToServerMap,
    _lastServersData, _fileAnalysisCache, _desktopToServerMap,
    MARKET_SELL_ORDER, SERVER_PATH_MAP,
    getServerName,
    updateServersUI, updateDownloadsUI, signalDone
} from './state.js';

import { ensureServerAccess, _sendSetEndpoint } from './server-access.js';
import { ensureSearchOnlyLoadout } from './loadout.js';
import {
    getServerFiles, getServerLogs,
    filterValuableFiles, filterValuableLogs,
    searchValuableFiles, searchValuableLogs,
    downloadFile, downloadLog,
    getDownloadsFolder, getFileAnalysis,
    getSellableItems, sellItems
} from './operations.js';
import { fetchMaintenanceData } from './maintenance.js';

export async function runSeller(selectedServers, selectedDownloads) {
    log('=== 高价出售已开始 ===', 'info');
    setCachedMapData(null);
    clearDesktopToServerMap();

    // Sort selected servers furthest-first (longer path = further) to reduce maintenance risk
    selectedServers = selectedServers.slice().sort(function (a, b) {
        var nameA = getServerName(a);
        var nameB = getServerName(b);
        var pathA = SERVER_PATH_MAP[nameA] || [];
        var pathB = SERVER_PATH_MAP[nameB] || [];
        return pathB.length - pathA.length;
    });

    log('已选：' + selectedServers.length + ' 个服务器， ' + selectedDownloads.length + ' 个下载(优先处理最远的)');
    var _sellerDownloadsData = { files: [] };

    // Step 1: For selected servers, access + search-valuable + download
    for (var si = 0; si < selectedServers.length; si++) {
        if (!running) { log('自动出售已被用户停止。', 'warn'); break; }

        var serverId = selectedServers[si];
        var serverName = getServerName(serverId);
        log('正在处理服务器 ' + (si + 1) + '/' + selectedServers.length + ': ' + serverName);

        // Ensure access (hack loadout equipped internally if needed)
        if (!await ensureServerAccess(serverId)) {
            log(serverName + ': 跳过 (无访问权限)', 'warn');
            continue;
        }

        await delay(humanDelay());

        // Check what the search phase found for this server to skip unnecessary calls
        var searchPhaseEntry = _lastServersData ? _lastServersData.servers.find(function (s) { return s.id === serverId; }) : null;
        var hasSearchFiles = !searchPhaseEntry || (searchPhaseEntry.files && searchPhaseEntry.files.length > 0);
        var hasSearchLogs = !searchPhaseEntry || (searchPhaseEntry.logs && searchPhaseEntry.logs.length > 0);

        // Only equip search loadout and search if there's something to find
        if (hasSearchFiles || hasSearchLogs) {
            await ensureSearchOnlyLoadout(serverId);
            await delay(humanDelay());
        }

        // Search for valuable files (skip if search phase found no files on this server)
        var detectedFileIds = {};
        if (hasSearchFiles) {
            log(serverName + '：正在搜索高价值文件...');
            var fileSearchResult = await searchValuableFiles(serverId);
            if (fileSearchResult && fileSearchResult.found) {
                var valuableFound = fileSearchResult.found.filter(function (f) { return f.basePrice > 0; });
                for (var dfi = 0; dfi < valuableFound.length; dfi++) {
                    detectedFileIds[valuableFound[dfi].id] = true;
                }
                log(serverName + '：文件高价值搜索完成 \u2014 检测到 ' + valuableFound.length + ' 个文件' + (valuableFound.length < fileSearchResult.found.length ? ' (' + (fileSearchResult.found.length - valuableFound.length) + ' 已跳过, basePrice=0)' : '') + '，searchPower 用量： ' + (fileSearchResult.searchPowerUsed || '?'), 'success');
            }
            await delay(humanDelay());
        } else {
            log(serverName + '：跳过文件高价值搜索（扫描期间未发现高价值文件）');
        }

        // Search for valuable logs (skip if search phase found no logs on this server)
        var detectedLogIds = {};
        if (hasSearchLogs) {
            log(serverName + '：正在搜索高价值日志...');
            var logSearchResult = await searchValuableLogs(serverId);
            if (logSearchResult && logSearchResult.found) {
                var valuableLogsFound = logSearchResult.found.filter(function (l) { return l.basePrice > 0; });
                for (var dli = 0; dli < valuableLogsFound.length; dli++) {
                    detectedLogIds[valuableLogsFound[dli].id] = true;
                }
                log(serverName + '：日志高价值搜索完成 \u2014 检测到 ' + valuableLogsFound.length + ' 条日志' + (valuableLogsFound.length < logSearchResult.found.length ? ' (' + (logSearchResult.found.length - valuableLogsFound.length) + ' 已跳过, basePrice=0)' : ''), 'success');
            }
            await delay(humanDelay());
        } else {
            log(serverName + '：跳过日志高价值搜索（扫描期间未发现高价值日志）');
        }

        // Re-fetch files from server
        var files = await getServerFiles(serverId);
        var valuableFiles = filterValuableFiles(files);

        // Filter to only files that were detected by search-valuable
        var hasFileFilter = Object.keys(detectedFileIds).length > 0;
        if (hasFileFilter) {
            var beforeCount = valuableFiles.length;
            valuableFiles = valuableFiles.filter(function (f) { return detectedFileIds[f.fileId || f.id]; });
            if (beforeCount !== valuableFiles.length) {
                log(serverName + '：已筛选文件： ' + valuableFiles.length + ' 已探测，共 ' + beforeCount + ' 共计高价物品');
            }
        }

        // Update UI
        if (_lastServersData) {
            var srvEntry = _lastServersData.servers.find(function (s) { return s.id === serverId; });
            if (srvEntry) {
                srvEntry.files = valuableFiles.map(function (f) {
                    return { fileId: f.fileId || f.id, name: f.name, tags: f.tags || [], basePrice: f.basePrice || 0 };
                });
                updateServersUI(_lastServersData);
            }
        }

        // Download detected files only
        for (var fi = 0; fi < valuableFiles.length; fi++) {
            if (!running) break;
            var vf = valuableFiles[fi];
            var tagLabels = (vf.tags || []).map(function (t) { return typeof t === 'string' ? t : (t.label || t.key); }).join(', ');
            log(serverName + '：正在下载文件 "' + vf.name + '" (标签: ' + tagLabels + ', 价格: ' + vf.basePrice + ')');
            var dlOk = await downloadFile(serverId, vf.fileId);
            if (dlOk) {
                log(serverName + '：文件已下载 \u2713', 'success');
            } else {
                log(serverName + '：文件下载失败', 'error');
            }
            await delay(humanDelay());
        }

        // Re-fetch logs from server
        var logs = await getServerLogs(serverId);
        var valuableLogs = filterValuableLogs(logs);

        // Filter to only logs that were detected by search-valuable
        var hasLogFilter = Object.keys(detectedLogIds).length > 0;
        if (hasLogFilter) {
            var beforeLogCount = valuableLogs.length;
            valuableLogs = valuableLogs.filter(function (l) { return detectedLogIds[String(l.seq)]; });
            if (beforeLogCount !== valuableLogs.length) {
                log(serverName + '：已筛选日志： ' + valuableLogs.length + ' 已探测，共 ' + beforeLogCount + ' 共计高价物品');
            }
        }

        // Update UI
        if (_lastServersData) {
            var srvEntryLogs = _lastServersData.servers.find(function (s) { return s.id === serverId; });
            if (srvEntryLogs) {
                srvEntryLogs.logs = valuableLogs.map(function (l) {
                    return { seq: l.seq, message: l.message, tags: l.tags || [], basePrice: l.basePrice || 0 };
                });
                updateServersUI(_lastServersData);
            }
        }

        // Download detected logs only
        for (var li = 0; li < valuableLogs.length; li++) {
            if (!running) break;
            var vl = valuableLogs[li];
            var ltagLabels = (vl.tags || []).map(function (t) { return typeof t === 'string' ? t : (t.label || t.key); }).join(', ');
            log(serverName + '：正在下载日志 "' + vl.message + '" (标签: ' + ltagLabels + ', 价格: ' + vl.basePrice + ')');
            var dlLogOk = await downloadLog(serverId, vl.seq);
            if (dlLogOk) {
                log(serverName + '：日志已下载 \u2713', 'success');
            } else {
                log(serverName + '：日志下载失败', 'error');
            }
            await delay(humanDelay());
        }

        // Mark server as DOWNLOADED in UI
        if (_lastServersData) {
            var srvDone = _lastServersData.servers.find(function (s) { return s.id === serverId; });
            if (srvDone) {
                srvDone.status = 'DOWNLOADED';
                updateServersUI(_lastServersData);
            }
        }

        // Refresh downloads folder and update Downloads tab
        log(serverName + '：正在刷新下载文件夹...');
        await delay(500);
        var dlFiles = await getDownloadsFolder();
        var valuableDlFiles = dlFiles.filter(function (f) { return f.isValuable; });
        _sellerDownloadsData = { files: [] };
        for (var di = 0; di < valuableDlFiles.length; di++) {
            var dlFile = valuableDlFiles[di];
            var isCached = !!_fileAnalysisCache[dlFile.id];
            if (!isCached) await delay(300);
            var analysis = await getFileAnalysis(dlFile.id);
            var dlTags = [];
            var dlSource = '\u2014';
            if (analysis) {
                dlTags = (analysis.tags || []).map(function (t) {
                    return typeof t === 'string' ? { key: t, label: t } : t;
                });
                dlSource = analysis.source || '\u2014';
            }
            if (dlTags.length === 0) {
                continue;
            }
            _sellerDownloadsData.files.push({
                id: dlFile.id,
                name: dlFile.name,
                source: dlSource,
                tags: dlTags,
                status: 'OPEN',
                selected: false
            });
        }
        updateDownloadsUI(_sellerDownloadsData);
        log(serverName + '：下载文件夹中有 ' + _sellerDownloadsData.files.length + ' 个高价文件');

        log(serverName + '：处理完成');
    }

    // Step 2: Sell items at markets in priority order
    var grandTotalCredits = 0;
    var grandTotalRep = 0;
    var grandTotalSold = 0;

    if (running) {
        log('--- 在市场出售高价值物品 ---');

        for (var mi = 0; mi < MARKET_SELL_ORDER.length; mi++) {
            if (!running) break;

            var market = MARKET_SELL_ORDER[mi];
            log('正在检查 ' + market.name + ' 市场找可出售物品...');

            // Set endpoint to market server before requesting sellable items (HOME is default, skip)
            if (market.serverId) {
                log(market.name + '：正在将端点设为市场服务器...');
                var epOk = await _sendSetEndpoint(market.serverId);
                if (!epOk) {
                    log(market.name + '：设置端点失败 — 跳过', 'warn');
                    continue;
                }
                await delay(humanDelay());
            }

            var sellableResult = await getSellableItems(market.id);
            var sellableItems = sellableResult.items || [];
            if (sellableItems.length === 0) {
                log(market.name + '：没有可出售物品');
                await delay(humanDelay());
                continue;
            }

            var items = sellableItems.map(function (item) {
                var id = item.itemId || item.id || item.fileId;
                var type = item.itemType || 'file';
                return id ? { itemType: type, itemId: id } : null;
            }).filter(Boolean);
            var marketCredits = sellableResult.totalPrice;
            var marketRep = sellableResult.totalRepGain;
            log(market.name + ': 找到 ' + items.length + ' 件可出售物品（\ud83d\udcb0' + marketCredits + ' \u2b50' + marketRep + ')');

            if (items.length > 0) {
                await delay(humanDelay());
                log(market.name + '：正在出售 ' + items.length + ' 件物品...');
                var sold = await sellItems(market.id, items, function (soldItem) {
                    var sid = soldItem.itemId;
                    _sellerDownloadsData.files = _sellerDownloadsData.files.filter(function (f) { return f.id !== sid; });
                    updateDownloadsUI(_sellerDownloadsData);
                    if (_lastServersData) {
                        var mapping = _desktopToServerMap[sid];
                        if (mapping) {
                            var targetSrv = _lastServersData.servers.find(function (s) { return s.id === mapping.serverId; });
                            if (targetSrv) {
                                if (mapping.type === 'file') {
                                    targetSrv.files = (targetSrv.files || []).filter(function (f) { return (f.fileId || f.id) !== mapping.originalId; });
                                } else if (mapping.type === 'log') {
                                    targetSrv.logs = (targetSrv.logs || []).filter(function (l) { return l.seq !== mapping.originalId; });
                                }
                                var remaining = (targetSrv.files || []).length + (targetSrv.logs || []).length;
                                if (remaining === 0 && targetSrv.status === 'DOWNLOADED') {
                                    targetSrv.status = 'DONE';
                                }
                            }
                            delete _desktopToServerMap[sid];
                        }
                        updateServersUI(_lastServersData);
                    }
                });
                if (sold > 0) {
                    log(market.name + '：已出售 ' + sold + '/' + items.length + ' 件物品 \u2713', 'success');
                    grandTotalCredits += marketCredits;
                    grandTotalRep += marketRep;
                    grandTotalSold += sold;
                } else {
                    log(market.name + '：出售失败', 'error');
                }
                await delay(humanDelay());
            }
        }
    }

    if (grandTotalSold > 0) {
        log('=== 总计：' + grandTotalSold + ' 件物品已出售 \u2014 \ud83d\udcb0' + grandTotalCredits + ' 信用点,⭐' + grandTotalRep + ' 声望 ===', 'success');
    }
    await fetchMaintenanceData();
    log('=== 高价出售完成 ===', 'success');
    signalDone();
}
