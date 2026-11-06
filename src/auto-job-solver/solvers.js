// Auto Job Solver — job type solver functions (9 types + dispatcher).

import { humanDelay } from '../shared/ws-utils.js';
import { ensureDecryptSolverEnabled, ensureIceWallSolverEnabled, ensureSimpleDecryptSolverEnabled } from '../shared/hack-utils.js';
import { friendlyError } from '../shared/error-map.js';
import { state, sendCmd, delay, waitForEvent, log, waitForHackToBeDone } from './state.js';
import { jobLabel, extractFileInfoFromConditions, jobConditionsRequireDecrypt, checkDecryptPowerViaAnalysis, ensureDecryptOnlyLoadout, tryLoadoutSwapForError, waitForMinigameOrError, throwMinigameLockError } from './helpers.js';
import { stepTakeJob, stepCompleteJob, stepSetEndpoint, stepLogin, stepDiscoverDownloadFolder } from './steps.js';

// ---- Shared decrypt flow helper ----
// Used by File Decryption, Data Download, and Decrypt & Extract
// Handles: equip loadout, analysis check, decrypt.file, minigame/error race, retries
async function runDecryptFlow(fileId, fileName, job) {
    // Equip decrypt-only loadout, then check power
    await ensureDecryptOnlyLoadout(job);
    await delay(humanDelay());

    var analysisOk = await checkDecryptPowerViaAnalysis(fileId, job);
    if (!analysisOk) {
        log('解密算力检查: 通过');
        var swapOk = await tryLoadoutSwapForError('insufficient_power', job, {});
        if (!swapOk) {
            throw new Error('破解算力不足 — 没有装备栏能满足要求');
        }
        await delay(humanDelay());
    }

    ensureDecryptSolverEnabled();
    ensureIceWallSolverEnabled();
    ensureSimpleDecryptSolverEnabled();
    log('正在打开文件以解密：' + fileName);
    sendCmd('decrypt.file', { fileId: fileId });

    var openResult = await waitForMinigameOrError(12000);

    if (openResult.locked) {
        throwMinigameLockError(openResult.locked);
    }

    var isAlreadyDecrypted = false;
    if (openResult.error) {
        var errMsg = openResult.error.message || openResult.error.kind || JSON.stringify(openResult.error);
        var isLoadoutError = errMsg.indexOf('missing-software') >= 0 || errMsg.indexOf('insufficient_power') >= 0 ||
            errMsg.indexOf('insufficient-power') >= 0 || errMsg.indexOf('File is encrypted') >= 0;
        isAlreadyDecrypted = errMsg.indexOf('cannot-read-sai-file') >= 0 || errMsg.indexOf('Cannot read SAI file') >= 0 || errMsg.indexOf('file-already-decrypted') >= 0;

        if (isAlreadyDecrypted) {
            log('文件已解密 — 直接尝试完成任务', 'success');
        } else if (isLoadoutError) {
            log('装备栏：打开文件失败（' + errMsg + '）— 尝试切换软件');
            var swapOk2 = await tryLoadoutSwapForError(errMsg, job, openResult.error);
            if (swapOk2) {
                log('装备栏：更换成功 — 重试打开文件');
                await delay(1000);
                ensureDecryptSolverEnabled();
                ensureIceWallSolverEnabled();
                ensureSimpleDecryptSolverEnabled();
                sendCmd('decrypt.file', { fileId: fileId });
                var retryResult = await waitForMinigameOrError(12000);
                if (retryResult.locked) throwMinigameLockError(retryResult.locked);
                if (retryResult.error) {
                    var retryErrMsg = retryResult.error.message || retryResult.error.kind || JSON.stringify(retryResult.error);
                    throw new Error(friendlyError(retryErrMsg));
                } else if (retryResult.timeout) {
                    log('重试时未检测到小游戏开始', 'warn');
                }
            } else {
                throw new Error(friendlyError(errMsg));
            }
        } else {
            throw new Error(friendlyError(errMsg));
        }
    } else if (openResult.timeout) {
        log('未检测到小游戏开始（求解器可能自行处理）', 'warn');
    }

    if (!isAlreadyDecrypted) {
        await waitForHackToBeDone();
    }

    // Retry loop for job completion after decrypt
    await delay(1500);
    var decryptRetries = 0;
    var MAX_DECRYPT_RETRIES = 6;
    while (true) {
        try {
            var reward = await stepCompleteJob(job);
            if (reward) return reward;
            if (decryptRetries >= MAX_DECRYPT_RETRIES) {
                log('解密后无奖励 — 已达最大重试次数', 'warn');
                return null;
            }
        } catch (e) {
            if (e.message && e.message.indexOf('job-not-found') >= 0) {
                log('任务 ID 已失效 — 任务列表过期，请求刷新', 'error');
                throw new Error('job-not-found-refresh');
            }
            if (e.message && e.message.indexOf('job-conditions-not-met') >= 0 && decryptRetries < MAX_DECRYPT_RETRIES) {
                // Fall through to retry block below
            } else {
                throw e;
            }
        }
        if (decryptRetries < MAX_DECRYPT_RETRIES) {
            decryptRetries++;
            log('未找到解密按钮' + decryptRetries + '/' + MAX_DECRYPT_RETRIES + ')', 'warn');
            await delay(2000);
            ensureDecryptSolverEnabled();
            ensureIceWallSolverEnabled();
            ensureSimpleDecryptSolverEnabled();
            sendCmd('decrypt.file', { fileId: fileId });
            var retryOpen = await waitForMinigameOrError(12000);
            if (retryOpen.locked) throwMinigameLockError(retryOpen.locked);
            if (retryOpen.error) {
                var retryErrMsg2 = retryOpen.error.message || retryOpen.error.kind || '';
                if (retryErrMsg2.indexOf('file-already-decrypted') >= 0 || retryErrMsg2.indexOf('cannot-read-sai-file') >= 0) {
                    log('重试时文件已解密 — 直接跳到任务完成', 'success');
                    await delay(1500);
                    continue;
                }
                log('更换装备栏后解密算力仍不足 — 尝试升级硬件' + retryErrMsg2, 'warn');
                await delay(1500);
                continue;
            } else if (retryOpen.timeout) {
                log('重试时未检测到小游戏开始', 'warn');
            }
            await waitForHackToBeDone();
            await delay(1500);
            continue;
        }
        return null;
    }
}

// ---- Shared: find file in download folder ----
function findFileInFolder(folderData, job, latestFileId, latestFileName, serverFileName) {
    if (!folderData || !folderData.data || !folderData.data.files) return null;
    var files = folderData.data.files;
    var target = null;
    var condFile = extractFileInfoFromConditions(job);

    if (latestFileId) {
        target = files.find(function (f) { return f.id === latestFileId; });
        if (target) { log('按更新事件 ID 匹配到文件：' + target.name); return target; }
    }
    if (job.fileInfo && job.fileInfo.id) {
        target = files.find(function (f) { return f.id === job.fileInfo.id; });
        if (target) { log('按接取事件 ID 匹配到文件：' + target.name); return target; }
    }
    if (condFile && condFile.id) {
        target = files.find(function (f) { return f.id === condFile.id; });
        if (target) { log('按条件 ID 匹配到文件：' + target.name); return target; }
    }
    if (job.fileInfo && job.fileInfo.name) {
        target = files.find(function (f) { return f.name === job.fileInfo.name; });
        if (target) { log('按名称匹配到文件：' + target.name); return target; }
    }
    if (condFile && condFile.name) {
        target = files.find(function (f) { return f.name === condFile.name; });
        if (target) { log('按条件名称匹配到文件：' + target.name); return target; }
    }
    if (latestFileName) {
        target = files.find(function (f) { return f.name === latestFileName; });
        if (target) { log('按更新事件名称匹配到文件：' + target.name); return target; }
    }
    if (serverFileName) {
        var baseName = serverFileName.replace(/\.[^.]+$/, '');
        target = files.find(function (f) { return f.name && f.name.replace(/\.[^.]+$/, '') === baseName; });
        if (target) { log('按基础名匹配文件"' + baseName + '": ' + target.name); return target; }
    }
    if (job.fileInfo && job.fileInfo.name) {
        var fdBaseName = job.fileInfo.name.replace(/\.[^.]+$/, '');
        target = files.find(function (f) { return f.name && f.name.replace(/\.[^.]+$/, '') === fdBaseName; });
        if (target) { log('按基础名匹配文件"' + fdBaseName + '": ' + target.name); return target; }
    }
    // Fallback: encrypted files or isNew or last file
    var encFiles = files.filter(function (f) { return f.isEncrypted || (f.name && f.name.indexOf('.enc') >= 0); });
    if (encFiles.length > 0) {
        target = encFiles.find(function (f) { return f.isNew; }) || encFiles[encFiles.length - 1];
        if (target) { log('通过兜底方式匹配到加密文件：' + target.name, 'warn'); return target; }
    }
    var newFiles = files.filter(function (f) { return f.isNew; });
    if (newFiles.length === 1) {
        log('按唯一 isNew 文件匹配：' + newFiles[0].name, 'warn');
        return newFiles[0];
    }
    target = files[files.length - 1];
    if (target) log('按最终兜底（最后一个）匹配到文件：' + target.name, 'warn');
    return target;
}

// ---- Shared: create file update listener ----
function createFileUpdateListener() {
    var latestFileId = null;
    var latestFileName = null;
    var handler = function (evt) {
        if (evt.data && evt.data.type === 'COR3_AUTOJOB_DESKTOP_FILE' && evt.data.data && evt.data.data.file) {
            latestFileId = evt.data.data.file.id;
            latestFileName = evt.data.data.file.name;
            log('文件已更新: ' + evt.data.data.file.name + ' (新 id：' + latestFileId + ')');
        }
    };
    window.addEventListener('message', handler);
    return {
        get fileId() { return latestFileId; },
        get fileName() { return latestFileName; },
        remove: function () { window.removeEventListener('message', handler); }
    };
}

// ---- Shared: extract file type from file name ----
function extractFileType(fileName) {
    if (!fileName) return null;
    var dotIdx = fileName.lastIndexOf('.');
    return dotIdx >= 0 ? fileName.substring(dotIdx) : null;
}

// ---- Shared: open folder and find file, throws on failure ----
async function openFolderAndFindFile(job, latestFileId, latestFileName, serverFileName) {
    if (!state.downloadFolderId) {
        await stepDiscoverDownloadFolder();
    }
    if (!state.downloadFolderId) {
        throw new Error('未找到下载文件夹 ID — 无法发现下载文件夹');
    }

    log('正在打开下载文件夹');
    await delay(humanDelay());
    sendCmd('open.folder', { folderId: state.downloadFolderId });

    var folderData;
    try {
        folderData = await waitForEvent('COR3_AUTOJOB_DESKTOP_FOLDER', 10000);
    } catch (e) {
        throw new Error('打开下载文件夹失败');
    }

    var targetFile = findFileInFolder(folderData, job, latestFileId, latestFileName, serverFileName);
    if (!targetFile) {
        throw new Error('下载文件夹中未找到文件');
    }

    // Extract file type
    var ft = extractFileType(targetFile.name);
    if (ft) job.fileType = ft;

    return targetFile;
}

// ---- Shared: early completion attempt for already-taken jobs ----
async function tryEarlyCompletion(job, continueMsg) {
    if (job.alreadyTaken && job.canComplete) {
        log('任务已接取且可完成 — 立即完成');
        try {
            var earlyReward = await stepCompleteJob(job);
            if (earlyReward) return earlyReward;
        } catch (earlyErr) {
            if (earlyErr.message && earlyErr.message.indexOf('job-conditions-not-met') >= 0) {
                log('提前完成失败 (条件未满足) — 继续执行 ' + (continueMsg || '剩余步骤'), 'warn');
            } else {
                throw earlyErr;
            }
        }
        log('完成失败 — 继续执行剩余步骤');
    } else if (job.alreadyTaken) {
        log('任务已接取但尚未可完成 — 继续执行剩余步骤');
    }
    return null;
}

// ========================
// ---- Job Type Solvers ----
// ========================

// ---- File Decryption Job ----
async function solveFileDecryption(job) {
    log('=== 文件解密：' + jobLabel(job) + ' ===');

    var fileListener = createFileUpdateListener();

    try {
        await stepTakeJob(job);

        var earlyReward = await tryEarlyCompletion(job, '解密重试错误: ');
        if (earlyReward) return earlyReward;

        // Determine fileInfo
        var fileInfo = job.fileInfo || null;
        if (fileListener.fileId && fileInfo) {
            fileInfo.id = fileListener.fileId;
        }
        if (!fileInfo) {
            var condFile = extractFileInfoFromConditions(job);
            if (condFile) {
                fileInfo = condFile;
                if (fileListener.fileId) fileInfo.id = fileListener.fileId;
                log('从任务条件获取到文件信息: ' + condFile.name + ' (ID: ' + condFile.id + ')');
            }
        }

        var targetFile = await openFolderAndFindFile(job, fileListener.fileId, fileListener.fileName, null);
        return await runDecryptFlow(targetFile.id, targetFile.name, job);
    } finally {
        fileListener.remove();
    }
}

// ---- IP Injection Job ----
async function solveIPInjection(job) {
    log('=== IP 注入：' + jobLabel(job) + ' ===');

    await stepTakeJob(job);

    if (!job.serverId) {
        throw new Error('IP 注入任务没有目标服务器');
    }

    var earlyReward = await tryEarlyCompletion(job);
    if (earlyReward) return earlyReward;

    await stepSetEndpoint(job.serverId);
    await stepLogin(job.serverId);

    log('正在获取中转数据');
    sendCmd('get.transit', { serverId: job.serverId });
    var transitData;
    try {
        transitData = await waitForEvent('COR3_AUTOJOB_SAI_TRANSIT', 10000);
    } catch (e) {
        throw new Error('获取中转数据失败');
    }

    if (transitData.error) {
        throw new Error('中转错误：' + friendlyError(transitData.error.message || JSON.stringify(transitData.error)));
    }

    var ipsToInject = [];
    if (job.conditions) {
        for (var c of job.conditions) {
            if (c.details && c.details.ips && c.details.ips.length > 0) {
                ipsToInject = c.details.ips;
                break;
            }
            if (c.ip) { ipsToInject.push(c.ip); break; }
            if (c.targetIp) { ipsToInject.push(c.targetIp); break; }
        }
    }

    if (ipsToInject.length === 0) {
        throw new Error('无法从任务条件确定要注入的 IP');
    }

    for (var ipIdx = 0; ipIdx < ipsToInject.length; ipIdx++) {
        var ip = ipsToInject[ipIdx];
        log('正在注入 IP（' + (ipIdx + 1) + '/' + ipsToInject.length + '): ' + ip);
        sendCmd('transit.add', { serverId: job.serverId, ip: ip, description: '' });

        try {
            var addResult = await waitForEvent('COR3_AUTOJOB_SAI_TRANSIT_ADD', 10000);
            if (addResult.error) {
                var errMsg = addResult.error.message || '';
                if (errMsg === 'sai-transit-ip-duplicate') {
                    log('IP ' + ip + ' 服务器上已存在 — 跳过', 'warn');
                    if (ipIdx < ipsToInject.length - 1) await delay(humanDelay());
                    continue;
                }
                if (errMsg === 'sai-transit-ip-limit') {
                    var limit = addResult.error.limit || 20;
                    throw new Error('服务器 IP 数已达上限（' + limit + ' 个 IP 上限）。用“自动清除 IP”开关清掉旧 IP。');
                }
                throw new Error('IP 注入失败：' + ip + ': ' + friendlyError(addResult.error.message));
            }
        } catch (e) {
            if (e.message.indexOf('Server IP limit reached') === 0) throw e;
            throw new Error('IP 注入超时：' + ip + ': ' + e.message);
        }
        if (ipIdx < ipsToInject.length - 1) await delay(humanDelay());
    }

    log('所有 IP 已成功注入', 'success');
    await delay(humanDelay());

    return await stepCompleteJob(job);
}

// ---- Data Download Job ----
async function solveDataDownload(job) {
    log('=== 数据下载：' + jobLabel(job) + ' ===');

    var fileListener = createFileUpdateListener();

    try {
        await stepTakeJob(job);

        if (!job.serverId) {
            throw new Error('数据下载任务没有目标服务器');
        }

        var earlyReward = await tryEarlyCompletion(job, '下载/解密步骤');
        if (earlyReward) return earlyReward;

        await stepSetEndpoint(job.serverId);
        await stepLogin(job.serverId);

        log('正在获取服务器文件');
        sendCmd('get.files', { serverId: job.serverId });
        var filesData;
        try {
            filesData = await waitForEvent('COR3_AUTOJOB_SAI_FILES', 10000);
        } catch (e) {
            throw new Error('获取服务器文件失败');
        }

        if (filesData.error) {
            throw new Error('文件错误: ' + friendlyError(filesData.error.message || JSON.stringify(filesData.error)));
        }

        var jobFile = null;
        var serverFileName = null;
        if (filesData.data && filesData.data.files) {
            jobFile = filesData.data.files.find(function (f) { return f.jobId === job.jobId; });
        }

        if (!jobFile) {
            log('服务器上未找到任务文件(可能已下载)', 'warn');
        } else {
            serverFileName = jobFile.name;
            log('正在下载文件：' + jobFile.name);
            sendCmd('file.download', { serverId: job.serverId, fileId: jobFile.fileId });

            try {
                var dlResult = await waitForEvent('COR3_AUTOJOB_SAI_FILE_DOWNLOAD', 10000);
                if (dlResult.error) {
                    log('文件下载响应：' + friendlyError(dlResult.error.message || JSON.stringify(dlResult.error)), 'warn');
                }
            } catch (e) {
                log('文件下载超时(可能已下载)', 'warn');
            }

            log('文件已下载', 'success');
        }
        await delay(humanDelay());

        var needsDecrypt = jobConditionsRequireDecrypt(job);
        if (!needsDecrypt) {
            var reward = null;
            try {
                reward = await stepCompleteJob(job);
            } catch (e) {
                if (e.message && e.message.indexOf('job-conditions-not-met') >= 0) {
                    log('任务条件未满足 — 文件可能需要解密', 'warn');
                    needsDecrypt = true;
                } else {
                    throw e;
                }
            }
            if (reward) return reward;
            if (!needsDecrypt) {
                log('任务尚未完成 — 检查是否需要解密');
                needsDecrypt = true;
            }
        } else {
            log('任务条件需要文件解密 — 转入解密流程');
        }

        var condFile = extractFileInfoFromConditions(job);
        if (condFile) {
            log('任务条件文件：' + (condFile.name || 'unknown') + ' (ID: ' + (condFile.id || 'unknown') + ')');
        }

        var targetFile = await openFolderAndFindFile(job, fileListener.fileId, fileListener.fileName, serverFileName);
        return await runDecryptFlow(targetFile.id, targetFile.name, job);
    } finally {
        fileListener.remove();
    }
}

// ---- Log Deletion Job ----
async function solveLogDeletion(job) {
    log('=== 日志删除：' + jobLabel(job) + ' ===');

    await stepTakeJob(job);

    if (!job.serverId) {
        throw new Error('日志删除任务没有目标服务器');
    }

    var earlyReward = await tryEarlyCompletion(job);
    if (earlyReward) return earlyReward;

    await stepSetEndpoint(job.serverId);
    await stepLogin(job.serverId);

    log('正在获取服务器日志');
    sendCmd('get.logs', { serverId: job.serverId });
    var logsData;
    try {
        logsData = await waitForEvent('COR3_AUTOJOB_SAI_LOGS', 10000);
    } catch (e) {
        throw new Error('获取服务器日志失败');
    }

    if (logsData.error) {
        throw new Error('日志错误：' + friendlyError(logsData.error.message || JSON.stringify(logsData.error)));
    }

    var jobLog = null;
    if (logsData.data && logsData.data.logs) {
        jobLog = logsData.data.logs.find(function (l) { return l.jobId === job.jobId; });
    }

    if (!jobLog) {
        log('服务器上未找到任务日志（可能已被删除）', 'warn');
        return await stepCompleteJob(job);
    }

    log('正在删除日志序列 ' + jobLog.seq + ': ' + jobLog.message);
    sendCmd('log.delete', { serverId: job.serverId, seq: jobLog.seq });

    try {
        var delResult = await waitForEvent('COR3_AUTOJOB_SAI_LOG_DELETE', 10000);
        if (delResult.error) {
            throw new Error('日志删除失败：' + friendlyError(delResult.error.message || JSON.stringify(delResult.error)));
        }
    } catch (e) {
        throw new Error('日志删除超时：' + e.message);
    }

    log('日志已删除', 'success');
    await delay(humanDelay());

    return await stepCompleteJob(job);
}

// ---- Log Download Job ----
async function solveLogDownload(job) {
    log('=== 日志下载：' + jobLabel(job) + ' ===');

    await stepTakeJob(job);

    if (!job.serverId) {
        throw new Error('日志下载任务没有目标服务器');
    }

    var earlyReward = await tryEarlyCompletion(job);
    if (earlyReward) return earlyReward;

    await stepSetEndpoint(job.serverId);
    await stepLogin(job.serverId);

    log('正在获取服务器日志');
    sendCmd('get.logs', { serverId: job.serverId });
    var logsData;
    try {
        logsData = await waitForEvent('COR3_AUTOJOB_SAI_LOGS', 10000);
    } catch (e) {
        throw new Error('获取服务器日志失败');
    }

    if (logsData.error) {
        throw new Error('日志错误：' + friendlyError(logsData.error.message || JSON.stringify(logsData.error)));
    }

    var jobLog = null;
    if (logsData.data && logsData.data.logs) {
        jobLog = logsData.data.logs.find(function (l) { return l.jobId === job.jobId; });
    }

    if (!jobLog) {
        log('服务器上未找到任务日志（可能已下载）', 'warn');
        return await stepCompleteJob(job);
    }

    log('正在下载日志序列 ' + jobLog.seq + ': ' + jobLog.message);
    sendCmd('log.download', { serverId: job.serverId, seq: jobLog.seq });

    try {
        var dlResult = await waitForEvent('COR3_AUTOJOB_SAI_LOG_DOWNLOAD', 10000);
        if (dlResult.error) {
            log('日志下载响应：' + friendlyError(dlResult.error.message || JSON.stringify(dlResult.error)), 'warn');
        }
    } catch (e) {
        log('日志下载超时（可能已下载）', 'warn');
    }

    log('日志已下载', 'success');
    await delay(humanDelay());

    return await stepCompleteJob(job);
}

// ---- Decrypt & Extract Job ----
async function solveDecryptExtract(job) {
    log('=== 解密与提取：' + jobLabel(job) + ' ===');

    var fileListener = createFileUpdateListener();

    try {
        await stepTakeJob(job);

        if (!job.serverId) {
            throw new Error('解密与提取任务没有目标服务器');
        }

        var earlyReward = await tryEarlyCompletion(job, '下载/解密步骤');
        if (earlyReward) return earlyReward;

        await stepSetEndpoint(job.serverId);
        await stepLogin(job.serverId);

        log('正在获取服务器文件');
        sendCmd('get.files', { serverId: job.serverId });
        var filesData;
        try {
            filesData = await waitForEvent('COR3_AUTOJOB_SAI_FILES', 10000);
        } catch (e) {
            throw new Error('获取服务器文件失败');
        }

        if (filesData.error) {
            var filesErr = filesData.error.message || JSON.stringify(filesData.error);
            if (filesErr.indexOf('missing-software') >= 0 || filesErr.indexOf('software') >= 0) {
                throw new Error('服务器缺少必需软件 — 访问不了文件');
            }
            throw new Error('文件错误: ' + filesErr);
        }

        var jobFile = null;
        var serverFileName = null;
        if (filesData.data && filesData.data.files) {
            jobFile = filesData.data.files.find(function (f) { return f.jobId === job.jobId; });
        }

        if (!jobFile) {
            log('服务器上未找到任务文件(可能已下载)', 'warn');
        } else {
            serverFileName = jobFile.name;
            log('正在下载文件：' + jobFile.name);
            sendCmd('file.download', { serverId: job.serverId, fileId: jobFile.fileId });

            try {
                var dlResult = await waitForEvent('COR3_AUTOJOB_SAI_FILE_DOWNLOAD', 10000);
                if (dlResult.error) {
                    log('文件下载响应：' + friendlyError(dlResult.error.message || JSON.stringify(dlResult.error)), 'warn');
                }
            } catch (e) {
                log('文件下载超时(可能已下载)', 'warn');
            }

            log('文件已下载 — 正在打开以解密', 'success');
        }
        await delay(humanDelay());

        var targetFile = await openFolderAndFindFile(job, fileListener.fileId, fileListener.fileName, serverFileName);
        return await runDecryptFlow(targetFile.id, targetFile.name, job);
    } finally {
        fileListener.remove();
    }
}

// ---- File Elimination (DeleteFile) Job ----
async function solveFileElimination(job) {
    log('=== 文件清除：' + jobLabel(job) + ' ===');

    await stepTakeJob(job);

    if (!job.serverId) {
        throw new Error('文件清除任务没有目标服务器');
    }

    var earlyReward = await tryEarlyCompletion(job);
    if (earlyReward) return earlyReward;

    await stepSetEndpoint(job.serverId);
    await stepLogin(job.serverId);

    log('正在获取服务器文件');
    sendCmd('get.files', { serverId: job.serverId });
    var filesData;
    try {
        filesData = await waitForEvent('COR3_AUTOJOB_SAI_FILES', 10000);
    } catch (e) {
        throw new Error('获取服务器文件失败');
    }

    if (filesData.error) {
        throw new Error('文件错误: ' + friendlyError(filesData.error.message || JSON.stringify(filesData.error)));
    }

    var jobFile = null;
    var targetFileIds = [];
    if (job.conditions) {
        for (var c = 0; c < job.conditions.length; c++) {
            if (job.conditions[c].type === 'DeleteFile' && job.conditions[c].details && job.conditions[c].details.fileIds) {
                targetFileIds = job.conditions[c].details.fileIds;
                break;
            }
        }
    }
    if (filesData.data && filesData.data.files) {
        jobFile = filesData.data.files.find(function (f) { return f.jobId === job.jobId; });
        if (!jobFile && targetFileIds.length > 0) {
            jobFile = filesData.data.files.find(function (f) { return targetFileIds.indexOf(f.fileId) >= 0; });
        }
        if (!jobFile) {
            jobFile = filesData.data.files.find(function (f) { return f.source === 'job'; });
        }
    }

    if (!jobFile) {
        log('服务器上未找到任务文件（可能已被删除）', 'warn');
        return await stepCompleteJob(job);
    }

    log('正在删除文件: ' + jobFile.name + ' (fileId：' + jobFile.fileId + ')');
    sendCmd('file.delete', { serverId: job.serverId, fileId: jobFile.fileId });

    try {
        var delResult = await waitForEvent('COR3_AUTOJOB_SAI_FILE_DELETE', 10000);
        if (delResult.error) {
            throw new Error('文件删除失败: ' + friendlyError(delResult.error.message || JSON.stringify(delResult.error)));
        }
    } catch (e) {
        throw new Error('文件删除超时: ' + e.message);
    }

    log('文件已删除', 'success');
    await delay(humanDelay());

    return await stepCompleteJob(job);
}

// ---- Data Upload (UploadFile) Job ----
async function solveDataUpload(job) {
    log('=== 数据上传：' + jobLabel(job) + ' ===');

    await stepTakeJob(job);

    if (!job.serverId) {
        throw new Error('数据上传任务没有目标服务器');
    }

    var earlyReward = await tryEarlyCompletion(job);
    if (earlyReward) return earlyReward;

    var uploadFile = job.fileInfo || null;
    if (!uploadFile && job.conditions) {
        for (var c = 0; c < job.conditions.length; c++) {
            if (job.conditions[c].type === 'UploadFile' && job.conditions[c].details && job.conditions[c].details.files && job.conditions[c].details.files.length > 0) {
                uploadFile = job.conditions[c].details.files[0];
                break;
            }
        }
    }
    if (!uploadFile) {
        throw new Error('无法从任务条件确定要上传的文件');
    }

    await stepSetEndpoint(job.serverId);
    await stepLogin(job.serverId);

    log('正在获取服务器文件');
    sendCmd('get.files', { serverId: job.serverId });
    try {
        await waitForEvent('COR3_AUTOJOB_SAI_FILES', 10000);
    } catch (e) {
        log('获取服务器文件失败 (非致命)', 'warn');
    }
    await delay(humanDelay());

    log('正在上传文件：' + uploadFile.name);
    sendCmd('file.upload', { serverId: job.serverId, name: uploadFile.name, sizeMb: 0 });

    try {
        await waitForEvent('COR3_AUTOJOB_SAI_FILE_UPLOAD', 10000);
        log('服务器已确认文件上传', 'success');
    } catch (e) {
        log('未收到文件上传响应 (仍尝试完成)', 'warn');
    }
    await delay(humanDelay());

    return await stepCompleteJob(job);
}

// ---- IP Cleanup (DeleteIps) Job ----
async function solveIPCleanup(job) {
    log('=== IP 清理：' + jobLabel(job) + ' ===');

    await stepTakeJob(job);

    if (!job.serverId) {
        throw new Error('IP 清理任务没有目标服务器');
    }

    var earlyReward = await tryEarlyCompletion(job);
    if (earlyReward) return earlyReward;

    await stepSetEndpoint(job.serverId);
    await stepLogin(job.serverId);

    log('正在获取中转数据');
    sendCmd('get.transit', { serverId: job.serverId });
    var transitData;
    try {
        transitData = await waitForEvent('COR3_AUTOJOB_SAI_TRANSIT', 10000);
    } catch (e) {
        throw new Error('获取中转数据失败');
    }

    if (transitData.error) {
        throw new Error('中转错误：' + friendlyError(transitData.error.message || JSON.stringify(transitData.error)));
    }

    var ipsToRemove = [];
    if (job.conditions) {
        for (var c = 0; c < job.conditions.length; c++) {
            if (job.conditions[c].type === 'DeleteIps' && job.conditions[c].details && job.conditions[c].details.ips) {
                ipsToRemove = job.conditions[c].details.ips;
                break;
            }
        }
    }

    if (ipsToRemove.length === 0 && transitData.data && transitData.data.ips) {
        var jobIps = transitData.data.ips.filter(function (entry) {
            return entry.source === 'job' && entry.jobId === job.jobId;
        });
        ipsToRemove = jobIps.map(function (entry) { return entry.ip; });
        if (ipsToRemove.length > 0) {
            log('找到 ' + ipsToRemove.length + ' 个待从中转数据移除的 IP（source=job）');
        }
    }

    if (ipsToRemove.length === 0) {
        throw new Error('无法从任务条件或传输数据确定要移除的 IP');
    }

    for (var ipIdx = 0; ipIdx < ipsToRemove.length; ipIdx++) {
        var ip = ipsToRemove[ipIdx];
        log('正在移除 IP（' + (ipIdx + 1) + '/' + ipsToRemove.length + '): ' + ip);
        sendCmd('transit.remove', { serverId: job.serverId, ip: ip });

        try {
            var rmResult = await waitForEvent('COR3_AUTOJOB_SAI_TRANSIT_REMOVE', 10000);
            if (rmResult.error) {
                throw new Error('IP 移除失败：' + ip + ': ' + friendlyError(rmResult.error.message || JSON.stringify(rmResult.error)));
            }
        } catch (e) {
            throw new Error('IP 移除超时：' + ip + ': ' + e.message);
        }
        if (ipIdx < ipsToRemove.length - 1) await delay(humanDelay());
    }

    log('所有 IP 已成功移除', 'success');
    await delay(humanDelay());

    return await stepCompleteJob(job);
}

// ---- Main job dispatcher ----
export async function solveJob(job) {
    var type = job.type || job.name;
    switch (type) {
        case 'File Decryption':
            return await solveFileDecryption(job);
        case 'IP Injection':
            return await solveIPInjection(job);
        case 'Data Download':
            return await solveDataDownload(job);
        case 'Log Deletion':
            return await solveLogDeletion(job);
        case 'Log Download':
            return await solveLogDownload(job);
        case 'Decrypt & Extract':
            return await solveDecryptExtract(job);
        case 'File Elimination':
            return await solveFileElimination(job);
        case 'Data Upload':
            return await solveDataUpload(job);
        case 'IP Cleanup':
            return await solveIPCleanup(job);
        default:
            throw new Error('不支持的任务类型：' + type);
    }
}
