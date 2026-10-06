#!/usr/bin/env node
// Pulse - a small team messaging product.
//
// It is a real app you sign into and use. It also happens to be built the way Teams and
// Outlook are built, which is the point: chat runs over a WebSocket, and a separate
// Server-Sent Events channel carries notifications, unread badges and presence. Both are
// long-lived connections correlated to the session by a host-only HttpOnly cookie.
//
// So when a proxy mishandles streams, Pulse fails the way those products fail: the app
// loads, everything looks fine, and messages simply do not arrive until you reload.
//
// Usage:  node server.js
// Env:    PORT (default 8080), TLS_KEY + TLS_CERT for https/wss, HEARTBEAT_MS (15000)

'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ws = require('./websocket');

const PORT = Number(process.env.PORT || 8080);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15000);
// Long-lived connections are recycled rather than held forever, the way SignalR recycles
// Outlook's notification channel. Without this you only ever see one request per page
// load, so there is nothing to observe unless devtools happened to be open at the time.
const FEED_LIFETIME_MS = Number(process.env.FEED_LIFETIME_MS || 60000);
const CHAT_LIFETIME_MS = Number(process.env.CHAT_LIFETIME_MS || 180000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_NAME = 'pulse_sid';
// How the session is proven to the server.
//   cookie - host-only HttpOnly cookie, the way most ordinary web apps work. Probes what a
//            proxy will do to the *next* app onboarded.
//   token  - Authorization: Bearer on fetch, ?access_token= on the WebSocket, which is how
//            M365 and Teams actually authenticate their channels. Mirrors production traffic.
// A browser cannot set headers on a WebSocket handshake, so token mode has to accept the
// token from the query string too - exactly the compromise the real apps make.
const AUTH_MODE = process.env.AUTH_MODE === 'token' ? 'token' : 'cookie';

const CHANNELS = [
    { id: 'general', name: 'general', topic: 'Anything and everything' },
    { id: 'releases', name: 'releases', topic: 'Ship logs and rollouts' },
    { id: 'support', name: 'support', topic: 'Customer questions' },
];

/** sid -> { name, joinedAt } */
const users = new Map();
/** channelId -> [{ id, channel, author, text, at }] */
const messages = new Map(CHANNELS.map((c) => [c.id, []]));
/** sid -> Set<WebSocketConnection>  — chat transport */
const chatSockets = new Map();
/** sid -> Set<{ res, heartbeat }>  — notification transport */
const feeds = new Map();
/** negotiated connection id -> { sid, createdAt }  — single-use, like SignalR's */
const pending = new Map();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => Date.now();

// ---- plumbing ----------------------------------------------------------------

function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
}

function tokenOf(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        return auth.slice(7).trim();
    }
    try {
        return new URL(req.url, 'http://x').searchParams.get('access_token');
    } catch {
        return null;
    }
}

const sidOf = (req) => {
    const sid = AUTH_MODE === 'token' ? tokenOf(req) : parseCookies(req)[COOKIE_NAME];
    return sid && users.has(sid) ? sid : null;
};

function json(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        ...headers,
    });
    res.end(payload);
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    });
}

const roster = () => [...users.entries()].map(([sid, u]) => ({
    name: u.name,
    online: chatSockets.has(sid) || feeds.has(sid),
}));

// ---- fan-out ----------------------------------------------------------------

/** Chat traffic: WebSocket only. This is what makes the message list live. */
function toChat(payload, { exceptSid } = {}) {
    const frame = JSON.stringify(payload);
    let sent = 0;
    for (const [sid, conns] of chatSockets) {
        if (exceptSid && sid === exceptSid) continue;
        for (const conn of conns) if (conn.send(frame)) sent += 1;
    }
    return sent;
}

/** Notifications, badges and presence: SSE only. Mirrors OWA's notification channel. */
function toFeeds(event, data, { onlySid } = {}) {
    let sent = 0;
    for (const [sid, set] of feeds) {
        if (onlySid && sid !== onlySid) continue;
        for (const feed of set) {
            if (feed.res.writableEnded) continue;
            feed.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            sent += 1;
        }
    }
    return sent;
}

// ---- product API ------------------------------------------------------------

async function login(req, res) {
    const { name } = await readBody(req);
    const display = String(name || '').trim().slice(0, 24);
    if (!display) return json(res, 400, { error: 'name required' });

    const sid = crypto.randomUUID();
    users.set(sid, { name: display, joinedAt: now() });

    if (AUTH_MODE === 'token') {
        // No cookie at all. The client holds the token and presents it on every call, which is
        // what makes this mode survive a cross-domain hop the way M365's channels do.
        json(res, 200, { name: display, channels: CHANNELS, token: sid, authMode: AUTH_MODE });
    } else {
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
        // Host-only and HttpOnly, with no Domain attribute - the same scoping real apps use,
        // and the reason a stream moved to another domain silently loses its identity.
        json(res, 200, { name: display, channels: CHANNELS, authMode: AUTH_MODE }, {
            'set-cookie': `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
        });
    }
    log('login', display);
    toFeeds('presence', { members: roster() });
    toFeeds('activity', { kind: 'joined', who: display, at: now() });
}

function me(req, res) {
    const sid = sidOf(req);
    if (!sid) return json(res, 401, { error: 'not signed in' });
    json(res, 200, {
        name: users.get(sid).name,
        channels: CHANNELS,
        members: roster(),
        authMode: AUTH_MODE,
    });
}

function history(req, res, url) {
    if (!sidOf(req)) return json(res, 401, { error: 'not signed in' });
    const channel = url.searchParams.get('channel') || 'general';
    json(res, 200, { channel, messages: (messages.get(channel) || []).slice(-50) });
}

/**
 * Posting is an ordinary short request - it is never the thing a proxy breaks. The live
 * delivery that follows is, which is why a failure looks like "my message vanished".
 */
async function postMessage(req, res) {
    const sid = sidOf(req);
    if (!sid) return json(res, 401, { error: 'not signed in' });

    const { channel, text } = await readBody(req);
    const body = String(text || '').trim().slice(0, 500);
    if (!messages.has(channel)) return json(res, 400, { error: 'unknown channel' });
    if (!body) return json(res, 400, { error: 'empty message' });

    const message = {
        id: crypto.randomUUID(),
        channel,
        author: users.get(sid).name,
        text: body,
        at: now(),
    };
    messages.get(channel).push(message);

    const liveTo = toChat({ type: 'message', message });
    const notifiedTo = toFeeds('notification', {
        kind: 'message',
        channel,
        author: message.author,
        preview: body.slice(0, 80),
        at: message.at,
    });

    log('message', `#${channel}`, `by ${message.author}`, `chat=${liveTo} feed=${notifiedTo}`);
    json(res, 200, { ok: true, message, deliveredLive: liveTo, notified: notifiedTo });
}

// ---- notification channel (SSE) ---------------------------------------------

// Step one of two, mirroring SignalR: a short POST that hands back a connection id, which
// the stream GET then presents. Splitting it this way is what made the original Outlook
// bug diagnosable - the negotiate succeeded while the stream that followed did not.
function negotiateFeed(req, res) {
    const sid = sidOf(req);
    if (!sid) return json(res, 401, { error: 'not signed in' });
    const id = crypto.randomUUID();
    pending.set(id, { sid, createdAt: now() });
    // Expire unclaimed ids so a stalled client cannot leak them.
    setTimeout(() => pending.delete(id), 30000).unref?.();
    json(res, 200, { id, lifetimeMs: FEED_LIFETIME_MS });
}

function openFeed(req, res, url) {
    const sid = sidOf(req);
    const silentMs = Number(url.searchParams.get('silent') || 0) * 1000;
    const closeMs = Number(url.searchParams.get('close') || 0) * 1000;
    const lifetime = Number(url.searchParams.get('life') || 0) * 1000 || FEED_LIFETIME_MS;

    // A negotiated id is consumed here, exactly once.
    const id = url.searchParams.get('id');
    const ticket = id ? pending.get(id) : null;
    if (id) pending.delete(id);
    // Deliberately still 200 and still open when unidentified: that is how the real thing
    // behaves, and why this failure is so easy to misread as "the stream is fine".

    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
    });

    const openedAt = now();
    const feed = { res, heartbeat: null };

    const start = () => {
        res.write(':\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({
            identified: Boolean(sid),
            negotiated: Boolean(ticket) && ticket.sid === sid,
            name: sid ? users.get(sid).name : null,
            members: roster(),
            heartbeatMs: HEARTBEAT_MS,
            lifetimeMs: lifetime,
        })}\n\n`);
    };
    if (silentMs > 0) setTimeout(start, silentMs); else start();

    if (sid) {
        if (!feeds.has(sid)) feeds.set(sid, new Set());
        feeds.get(sid).add(feed);
    } else {
        log('feed opened WITHOUT a session - no notifications can reach it');
    }

    feed.heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`event: ping\ndata: ${JSON.stringify({ t: now() - openedAt })}\n\n`);
    }, HEARTBEAT_MS);

    if (closeMs > 0) setTimeout(() => res.end(), closeMs);

    // Recycle on a timer. The client is expected to negotiate again straight away, so a
    // fresh request shows up in the network panel every lifetime window.
    const recycle = setTimeout(() => {
        if (res.writableEnded) return;
        res.write(`event: cycle\ndata: ${JSON.stringify({ reason: 'lifetime', afterMs: now() - openedAt })}\n\n`);
        res.end();
    }, lifetime);

    const cleanup = () => {
        clearInterval(feed.heartbeat);
        clearTimeout(recycle);
        if (sid && feeds.has(sid)) {
            feeds.get(sid).delete(feed);
            if (feeds.get(sid).size === 0) feeds.delete(sid);
        }
        toFeeds('presence', { members: roster() });
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    log('feed opened', sid ? users.get(sid).name : 'ANONYMOUS',
        `life=${lifetime}ms`, ticket ? 'negotiated' : 'no-ticket');
}

// ---- chat channel (WebSocket) -----------------------------------------------

function openChat(req, socket, url) {
    const conn = ws.accept(req, socket);
    if (!conn) return;
    const sid = sidOf(req);

    conn.send(JSON.stringify({
        type: 'hello',
        identified: Boolean(sid),
        name: sid ? users.get(sid).name : null,
        members: roster(),
    }));

    if (sid) {
        if (!chatSockets.has(sid)) chatSockets.set(sid, new Set());
        chatSockets.get(sid).add(conn);
        toFeeds('presence', { members: roster() });
    } else {
        log('chat socket opened WITHOUT a session - it will receive nothing');
    }

    const heartbeat = setInterval(() => conn.ping(), HEARTBEAT_MS);
    // Chat is recycled too, on a longer window - Teams does the same.
    const recycle = setTimeout(() => conn.close(1000, 'lifetime'), CHAT_LIFETIME_MS);

    conn.on('message', (raw) => {
        if (!sid) return;
        let msg = {};
        try { msg = JSON.parse(raw); } catch { return; }
        // Typing indicators exist to make the upstream direction visible: they only work
        // if the client can talk back, which SSE cannot do.
        if (msg.type === 'typing') {
            toChat({ type: 'typing', who: users.get(sid).name, channel: msg.channel }, { exceptSid: sid });
        }
    });

    conn.on('close', () => {
        clearInterval(heartbeat);
        clearTimeout(recycle);
        if (sid && chatSockets.has(sid)) {
            chatSockets.get(sid).delete(conn);
            if (chatSockets.get(sid).size === 0) chatSockets.delete(sid);
        }
        toFeeds('presence', { members: roster() });
        log('chat socket closed', sid ? users.get(sid).name : 'anonymous');
    });
    conn.on('error', (err) => log('chat socket error', err.message));

    log('chat socket opened', sid ? users.get(sid).name : 'ANONYMOUS');
}

// ---- static + routing -------------------------------------------------------

// ---- Set-Cookie survival probe -------------------------------------------------
// Reproduces the shape of a SAML session-issuing response: a 302 that carries Set-Cookie
// headers and no body. Emits several probe cookies of different sizes in one response, so
// a size-based cap is distinguishable from wholesale Set-Cookie stripping.
//
// Deliberately self-verifying: the redirect lands on /api/cookies, which reports what
// actually arrived. One navigation gives the answer.
//
// Note on Domain: a Set-Cookie whose Domain does not cover the serving host is dropped by
// the browser without comment, which looks identical to an intermediary stripping it. The
// default here is host-only (no Domain attribute) to keep the probe honest; pass ?domain=
// only when it genuinely covers the host you are testing.
function cookieProbe(req, res, url) {
    const sizes = (url.searchParams.get('sizes') || '16,512,1199,1558')
        .split(',')
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 8000);

    const domain = url.searchParams.get('domain');          // omit => host-only
    const sameSite = url.searchParams.get('samesite') || 'None';
    // Absolute path: a relative Location resolves against /api/ and yields /api/api/cookies.
    const target = url.searchParams.get('to') || '/api/cookies';

    const cookies = sizes.map((size, i) => {
        const name = `zrpProbe${i + 1}_${size}`;
        // Value padded to exactly `size` bytes so the header length is predictable.
        const value = 'x'.repeat(Math.max(1, size));
        const attrs = [
            `${name}=${value}`,
            domain ? `Domain=${domain}` : null,
            'Path=/',
            'Secure',
            `SameSite=${sameSite}`,
            i % 2 === 1 ? 'HttpOnly' : null,   // alternate, mirroring the real pair
        ].filter(Boolean);
        return attrs.join('; ');
    });

    res.writeHead(302, {
        'set-cookie': cookies,
        'cache-control': 'no-store, private',
        location: target,
        'content-length': 0,
    });
    res.end();

    log('cookie probe: 302 with', cookies.length, 'Set-Cookie headers,',
        'sizes=[' + sizes.join(',') + ']',
        'bytes=[' + cookies.map((c) => Buffer.byteLength(c)).join(',') + ']');
}

// Readback: what the browser actually holds and sent us.
function cookieReadback(req, res) {
    const got = parseCookies(req);
    const probes = Object.entries(got)
        .filter(([name]) => name.startsWith('zrpProbe'))
        .map(([name, value]) => ({
            name,
            declaredSize: Number(name.split('_')[1]) || null,
            receivedSize: value.length,
            intact: Number(name.split('_')[1]) === value.length,
        }))
        .sort((a, b) => (a.declaredSize || 0) - (b.declaredSize || 0));

    json(res, 200, {
        probeCookiesReceived: probes.length,
        probes,
        allCookieNames: Object.keys(got),
        verdict: probes.length === 0
            ? 'NO probe cookies arrived — Set-Cookie did not survive, or the browser rejected every one'
            : `${probes.length} arrived; any missing size was dropped between origin and browser`,
    });
}

function serveStatic(req, res, url) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });

    fs.readFile(file, (err, content) => {
        if (err) return json(res, 404, { error: 'not found' });
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
        res.writeHead(200, {
            'content-type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`,
            'cache-control': 'no-store',
        });
        res.end(content);
    });
}

function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/health':
            return json(res, 200, {
                ok: true, authMode: AUTH_MODE,
                users: users.size, chatSockets: chatSockets.size, feeds: feeds.size,
            });
        case 'POST /api/login':      return login(req, res);
        case 'GET /api/me':          return me(req, res);
        case 'GET /api/messages':    return history(req, res, url);
        case 'POST /api/messages':   return postMessage(req, res);
        case 'POST /api/feed/negotiate': return negotiateFeed(req, res);
        case 'GET /api/feed':        return openFeed(req, res, url);
        case 'GET /api/cookie-probe': return cookieProbe(req, res, url);
        case 'GET /api/cookies':     return cookieReadback(req, res);
        default:
            if (req.method === 'GET') return serveStatic(req, res, url);
            return json(res, 405, { error: 'method not allowed' });
    }
}

const { TLS_KEY, TLS_CERT } = process.env;
const server = TLS_KEY && TLS_CERT
    ? https.createServer({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }, handle)
    : http.createServer(handle);

server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/chat') return openChat(req, socket, url);
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});

// Node's defaults would close a connection that is only heartbeating.
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(PORT, '0.0.0.0', () => {
    const scheme = TLS_KEY ? 'https' : 'http';
    log(`Pulse listening on ${scheme}://0.0.0.0:${PORT}  (auth: ${AUTH_MODE})`);
    log(`  chat          ${TLS_KEY ? 'wss' : 'ws'}  /api/chat   (WebSocket)`);
    log(`  notifications POST /api/feed/negotiate -> GET /api/feed  (text/event-stream)`);
    log(`  feed recycles every ${FEED_LIFETIME_MS}ms, chat every ${CHAT_LIFETIME_MS}ms`);
    log(`  cookie probe  GET /api/cookie-probe  -> 302 + Set-Cookie, lands on /api/cookies`);
});
