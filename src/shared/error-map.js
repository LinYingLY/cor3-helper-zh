// Human-friendly error message mappings for common server errors
export var ERROR_MAP = {
    'sai-transit-ip-duplicate': '服务器上已存在该 IP',
    'sai-transit-ip-limit': '已达服务器 IP 上限',
    'no-path-to-server': '无通往服务器的路径(不可达)',
    'server-in-maintenance': '服务器维护中',
    'sai-missing-software': '缺少所需软件',
    'missing-software': '缺少所需软件',
    'sai-hack-impossible': '破解算力不足',
    'sai-no-hack-software': '无破解软件',
    'cannot-read-sai-file': '读取 SAI 文件失败',
    'invalid-access-token': '访问令牌已过期或无效',
    'token-expired': '会话令牌已过期',
    'job-already-taken': '此任务之前已接取',
    'job-not-found': '任务已不存在',
    'job-expired': '任务已过期',
    'job-conditions-not-met': '任务条件未满足',
    'sai-file-not-found': '服务器上未找到文件',
    'sai-log-not-found': '服务器上未找到日志',
    'sai-access-denied': '无权访问该服务器',
    'rate-limited': '触发限流 — 请求过于频繁',
    'file-not-found': '服务器/文件夹中未找到文件',
    'market-not-reachable': '市场不可达',
    'Error: File is encrypted': '该文件扩展名无法解密。请安装对应的解密软件',
    'insufficient_power': '此文件破解算力不足',
    'file-already-decrypted': '文件已解密',
    'job-is-not-available': '任务不可用（数据过期）'
};

export function friendlyError(errMsg, failedConditions) {
    if (!errMsg) return '未知错误';
    var friendly = '';
    // Check for exact match first
    if (ERROR_MAP[errMsg]) {
        friendly = ERROR_MAP[errMsg];
    } else {
        // Check for partial match (error message contains a known key)
        var keys = Object.keys(ERROR_MAP);
        for (var i = 0; i < keys.length; i++) {
            if (errMsg.indexOf(keys[i]) >= 0) {
                friendly = ERROR_MAP[keys[i]];
                break;
            }
        }
    }
    if (!friendly) friendly = errMsg;
    if (failedConditions && Array.isArray(failedConditions) && failedConditions.length > 0) {
        friendly += ' (' + failedConditions.join(', ') + ')';
    }
    return friendly;
}
