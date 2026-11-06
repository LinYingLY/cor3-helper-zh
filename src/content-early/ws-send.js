// WebSocket send infrastructure: throttling, queuing, room management
import {
    OrigWebSocket, trackedSockets, socketLastActivity,
    getActiveSocket, setActiveSocket,
    getCapturedBearerToken,
    pendingRetryOps
} from './state.js';

// Send a WS message on the active socket (most recently received messages)
// Throttled: minimum 250ms between sends to avoid "请求过于频繁" errors.
// Uses timestamp-based approach: if last send was <250ms ago, delay this send.
var WS_THROTTLE_MS = 250;
var wsSendLastTime = 0;
var wsSendQueue = [];
var wsSendFlushTimer = null;
var WS_QUEUE_MAX = 50;

var _ceChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
var _ceCbs = [];
if (_ceChannel) {
    _ceChannel.port1.onmessage = function () {
        var cbs = _ceCbs.slice();
        _ceCbs.length = 0;
        for (var i = 0; i < cbs.length; i++) cbs[i]();
    };
}
export function ceNextTick(fn) {
    if (_ceChannel) { _ceCbs.push(fn); _ceChannel.port2.postMessage(0); }
    else { setTimeout(fn, 0); }
}
function scheduleFlush(delayMs) {
    if (wsSendFlushTimer) return;
    if (delayMs <= 0) { ceNextTick(wsSendFlush); wsSendFlushTimer = true; return; }
    var target = Date.now() + delayMs;
    function tick() {
        if (Date.now() >= target) { wsSendFlush(); return; }
        var rem = target - Date.now();
        if (rem > 200) { setTimeout(function () { ceNextTick(tick); }, Math.min(rem - 50, 500)); }
        else { ceNextTick(tick); }
    }
    wsSendFlushTimer = true;
    ceNextTick(tick);
}

export function wsSendRaw(msg) {
    var toSend = msg;
    var codec = window.__cor3MsgpackCodec;
    if (codec && codec.isReady() && typeof msg === 'string') {
        var buf = codec.stringToPacketBuffer(msg);
        if (buf) toSend = buf;
    }

    var activeSocket = getActiveSocket();
    if (activeSocket && activeSocket.readyState === OrigWebSocket.OPEN) {
        activeSocket.send(toSend);
        wsSendLastTime = Date.now();
        return true;
    }

    let bestSocket = null;
    let bestTime = 0;
    for (const ws of trackedSockets) {
        if (ws.readyState === OrigWebSocket.OPEN) {
            const lastActivity = socketLastActivity.get(ws) || 0;
            if (lastActivity > bestTime) {
                bestTime = lastActivity;
                bestSocket = ws;
            }
        }
    }

    if (bestSocket) {
        setActiveSocket(bestSocket);
        bestSocket.send(toSend);
        wsSendLastTime = Date.now();
        return true;
    }

    console.log('[COR3 Helper] 未找到活跃的 WebSocket — 重新排队等待重试');
    // Re-queue message and retry after a short delay
    if (wsSendQueue.length < WS_QUEUE_MAX) {
        wsSendQueue.unshift(msg);
        scheduleFlush(2000);
    } else {
        console.log('[COR3 Helper] 没有活跃的 WebSocket 且队列已满 — 消息已丢弃');
    }
    return false;
}

function wsSendFlush() {
    wsSendFlushTimer = null;
    if (wsSendQueue.length === 0) return;
    var now = Date.now();
    var elapsed = now - wsSendLastTime;
    if (elapsed >= WS_THROTTLE_MS) {
        var next = wsSendQueue.shift();
        wsSendRaw(next);
        if (wsSendQueue.length > 0) {
            scheduleFlush(WS_THROTTLE_MS);
        }
    } else {
        scheduleFlush(WS_THROTTLE_MS - elapsed);
    }
}

export function wsSend(msg) {
    var now = Date.now();
    var elapsed = now - wsSendLastTime;
    if (elapsed >= WS_THROTTLE_MS && wsSendQueue.length === 0) {
        // Can send immediately
        wsSendRaw(msg);
    } else {
        // Queue and schedule flush
        wsSendQueue.push(msg);
        // Overflow protection: drop oldest messages if queue grows too large
        if (wsSendQueue.length > WS_QUEUE_MAX) {
            var dropped = wsSendQueue.length - WS_QUEUE_MAX;
            wsSendQueue = wsSendQueue.slice(dropped);
            console.log('[COR3 助手] WS 发送队列溢出——已丢弃 ' + dropped + ' 条最旧消息');
        }
        if (!wsSendFlushTimer) {
            scheduleFlush(Math.max(0, WS_THROTTLE_MS - elapsed));
        }
    }
    return true;
}

export function queueRetryOp(opName) {
    if (!pendingRetryOps.includes(opName)) {
        pendingRetryOps.push(opName);
    }
}

// Get a random human-like delay (400–900ms)
export function humanDelay() {
    return 400 + Math.floor(Math.random() * 500);
}

// --- Room state tracking ---
const joinedRooms = new Set();

export function delay(ms) {
    return new Promise(function (resolve) {
        var target = Date.now() + ms;
        function check() {
            if (Date.now() >= target) { resolve(); return; }
            var remaining = target - Date.now();
            if (remaining > 200) {
                setTimeout(function () { ceNextTick(check); }, Math.min(remaining - 50, 500));
            } else {
                ceNextTick(check);
            }
        }
        ceNextTick(check);
    });
}

// Send a leave-room message. Only sends if tracked as joined.
export function leaveRoom(room) {
    if (!joinedRooms.has(room)) return false;
    wsSend('42["leave-room",{"room":"' + room + '"}]');
    joinedRooms.delete(room);
    return true;
}

// Send a join-room message and mark as joined.
// New format includes jwtToken and clientVersion.
function sendJoin(room) {
    var joinData = { room: room };
    // Include jwtToken (strip "Bearer " prefix from captured token)
    var capturedBearerToken = getCapturedBearerToken();
    if (capturedBearerToken) {
        var jwt = capturedBearerToken;
        if (jwt.startsWith('Bearer ')) jwt = jwt.substring(7);
        joinData.jwtToken = jwt;
    }
    // Include clientVersion from captured web version
    if (window.__cor3WebVersion) {
        joinData.clientVersion = window.__cor3WebVersion;
    }
    wsSend('42["join-room",' + JSON.stringify(joinData) + ']');
    joinedRooms.add(room);
}

// Leave multiple rooms in order (child first), with human delays between.
function leaveRoomsInOrder(rooms) {
    var chain = Promise.resolve();
    rooms.forEach(function (room) {
        chain = chain.then(function () {
            if (leaveRoom(room)) {
                return delay(humanDelay());
            }
        });
    });
    return chain;
}

// Join multiple rooms in order (parent first), with human delays between.
function joinRoomsInOrder(rooms) {
    var chain = Promise.resolve();
    rooms.forEach(function (room) {
        chain = chain.then(function () {
            sendJoin(room);
            return delay(humanDelay());
        });
    });
    return chain;
}

// Enter rooms properly: leave any already-joined rooms (child→parent),
// then join them all fresh (parent→child).
// `rooms` must be in parent→child order, e.g. ['network-map', 'market']
export function enterRooms(rooms) {
    // Build leave list: reverse order (child first), only rooms we're in
    var toLeave = rooms.slice().reverse().filter(function (r) { return joinedRooms.has(r); });
    return leaveRoomsInOrder(toLeave).then(function () {
        return joinRoomsInOrder(rooms);
    });
}
