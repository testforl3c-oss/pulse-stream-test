#!/usr/bin/env node
'use strict';
// Self-check: `npm test`. Covers the hand-rolled RFC 6455 framing and both transports
// end to end, including the two failure modes this app exists to reproduce.

const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { acceptKey, encodeFrame, OPCODE } = require('../websocket');

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
// Mirrors the server: the suite asserts the same behaviour whichever way the session is proven.
const MODE = process.env.AUTH_MODE === 'token' ? 'token' : 'cookie';
let passed = 0;

/**
 * Turns a login response into the credential this mode uses: a Cookie header, or a Bearer
 * header plus the query parameter a WebSocket needs because it cannot send headers.
 */
function credsFrom(login) {
    if (MODE === 'token') {
        const token = login.body.token;
        assert.ok(token, 'token mode returned no token');
        return { headers: { authorization: 'Bearer ' + token }, wsQuery: 'access_token=' + token };
    }
    const setCookie = login.headers['set-cookie'][0];
    assert.match(setCookie, /HttpOnly/);
    assert.ok(!/Domain=/i.test(setCookie), 'session cookie must stay host-only');
    return { headers: { cookie: setCookie.split(';')[0] }, wsQuery: '' };
}

/** Appends the WebSocket credential, which has to travel in the URL. */
const withCreds = (path, creds) =>
    creds && creds.wsQuery ? path + (path.includes('?') ? '&' : '?') + creds.wsQuery : path;

function ok(name) {
    passed += 1;
    console.log(`  ok  ${name}`);
}

// ---- unit: framing ----------------------------------------------------------

function checkFraming() {
    // The RFC 6455 test vector, hardcoded on purpose. Recomputing the digest here with the
    // same GUID the implementation uses would pass even when that GUID is wrong - which is
    // exactly how a transposed GUID shipped once already.
    assert.strictEqual(
        acceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
        's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
        'accept key does not match the RFC 6455 vector - check the GUID'
    );
    ok('handshake accept key matches the RFC 6455 test vector');

    // Short frame: FIN+TEXT, unmasked, length in the second byte.
    const short = encodeFrame(OPCODE.TEXT, 'hi');
    assert.strictEqual(short[0], 0x81);
    assert.strictEqual(short[1], 2);
    assert.strictEqual(short.subarray(2).toString(), 'hi');
    ok('short frame encodes with a 2-byte header');

    // 126..65535 uses the 16-bit extended length.
    const medium = encodeFrame(OPCODE.TEXT, 'x'.repeat(200));
    assert.strictEqual(medium[1], 126);
    assert.strictEqual(medium.readUInt16BE(2), 200);
    assert.strictEqual(medium.length, 4 + 200);
    ok('200-byte frame uses the 16-bit length');

    // >= 65536 uses the 64-bit extended length. Boundaries are where framing bugs live.
    const large = encodeFrame(OPCODE.TEXT, 'y'.repeat(70000));
    assert.strictEqual(large[1], 127);
    assert.strictEqual(Number(large.readBigUInt64BE(2)), 70000);
    assert.strictEqual(large.length, 10 + 70000);
    ok('70000-byte frame uses the 64-bit length');

    // The server must never mask what it sends.
    assert.strictEqual((short[1] & 0x80), 0);
    ok('server frames are unmasked');
}

// ---- helpers ----------------------------------------------------------------

function request(method, p, { creds, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(`${BASE}${p}`, {
            method,
            headers: {
                ...((creds && creds.headers) || {}),
                ...(payload ? { 'content-type': 'application/json' } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: data ? JSON.parse(data) : null,
            }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** Opens an SSE stream and collects decoded events until `stop` resolves. */
function openSse(p, creds) {
    const events = [];
    const started = Date.now();
    let firstByte = null;
    const done = new Promise((resolve, reject) => {
        const req = http.get(`${BASE}${p}`, { headers: (creds && creds.headers) || {} }, (res) => {
            let buf = '';
            res.on('data', (chunk) => {
                if (firstByte === null) firstByte = Date.now() - started;
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n\n')) !== -1) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    if (block.startsWith(':')) continue;
                    const name = (block.match(/^event: (.*)$/m) || [])[1] || 'message';
                    const data = (block.match(/^data: (.*)$/m) || [])[1] || '{}';
                    events.push({ name, data: JSON.parse(data) });
                }
            });
            res.on('end', resolve);
            res.on('error', reject);
        });
        req.on('error', reject);
        setTimeout(() => req.destroy(), 4000).unref?.();
    }).catch(() => {});
    return { events, done, firstByteMs: () => firstByte };
}

/** Opens a raw WebSocket, masking client frames as the spec requires. */
function openWs(p, creds) {
    const messages = [];
    const socket = net.connect(PORT, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const ready = new Promise((resolve, reject) => {
        let handshake = '';
        let upgraded = false;
        let buf = Buffer.alloc(0);

        socket.on('connect', () => {
            socket.write(
                `GET ${withCreds(p, creds)} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
                // cookie mode sends a header; token mode already carried it in the URL
                (creds && creds.headers.cookie ? `Cookie: ${creds.headers.cookie}\r\n` : '') + '\r\n'
            );
        });
        socket.on('data', (chunk) => {
            if (!upgraded) {
                handshake += chunk.toString('latin1');
                const end = handshake.indexOf('\r\n\r\n');
                if (end === -1) return;
                assert.match(handshake, /^HTTP\/1\.1 101/, 'expected 101 Switching Protocols');
                assert.ok(
                    handshake.includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`),
                    'accept key mismatch'
                );
                upgraded = true;
                buf = Buffer.from(handshake.slice(end + 4), 'latin1');
                resolve();
            } else {
                buf = Buffer.concat([buf, chunk]);
            }
            // Decode unmasked server frames; enough for the text payloads used here.
            for (;;) {
                if (buf.length < 2) return;
                let len = buf[1] & 0x7f;
                let off = 2;
                if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
                else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
                if (buf.length < off + len) return;
                const opcode = buf[0] & 0x0f;
                const payload = buf.subarray(off, off + len).toString('utf8');
                buf = buf.subarray(off + len);
                if (opcode === OPCODE.TEXT) messages.push(JSON.parse(payload));
            }
        });
        socket.on('error', reject);
    });

    return {
        ready,
        messages,
        send(text) {
            const data = Buffer.from(text, 'utf8');
            const mask = crypto.randomBytes(4);
            const header = Buffer.alloc(2);
            header[0] = 0x81;
            header[1] = 0x80 | data.length; // clients MUST mask
            for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i & 3];
            socket.write(Buffer.concat([header, mask, data]));
        },
        close() { socket.destroy(); },
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- integration ------------------------------------------------------------

async function checkServer() {
    const health = await request('GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
    ok('health responds');

    const login = await request('POST', '/api/login', { body: { name: 'Ada' } });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.body.authMode, MODE, 'server is not in the expected auth mode');
    const cookie = credsFrom(login);
    ok(MODE === 'token'
        ? 'login returns a bearer token and sets no cookie'
        : 'login sets a host-only HttpOnly session cookie');
    if (MODE === 'token') {
        assert.ok(!login.headers['set-cookie'], 'token mode must not set a cookie');
        // The query form exists only because a WebSocket handshake cannot carry headers.
        const viaQuery = await request('GET', '/api/me?access_token=' + login.body.token);
        assert.strictEqual(viaQuery.status, 200);
        assert.strictEqual(viaQuery.body.name, 'Ada');
        ok('token is accepted from the query string as well as the header');
    }

    assert.strictEqual((await request('GET', '/api/me')).status, 401);
    assert.strictEqual((await request('GET', '/api/me', { creds: cookie })).body.name, 'Ada');
    ok('session is required and resolves to the signed-in user');

    // --- notification channel: negotiate, then stream, like SignalR
    const neg = await request('POST', '/api/feed/negotiate', { creds: cookie });
    assert.strictEqual(neg.status, 200);
    assert.ok(neg.body.id, 'negotiate returned no connection id');
    assert.strictEqual((await request('POST', '/api/feed/negotiate')).status, 401);
    ok('negotiate issues a connection id and requires a session');

    const feed = openSse('/api/feed?id=' + neg.body.id, cookie);
    await sleep(300);
    assert.ok(feed.firstByteMs() < 1000, `feed first byte took ${feed.firstByteMs()}ms`);
    assert.strictEqual(feed.events[0].name, 'hello');
    assert.strictEqual(feed.events[0].data.identified, true);
    assert.strictEqual(feed.events[0].data.negotiated, true);
    ok('notification feed opens immediately and identifies the session');

    // A negotiated id is single use - replaying it must not yield a bound stream.
    const replay = openSse('/api/feed?id=' + neg.body.id, cookie);
    await sleep(250);
    assert.strictEqual(replay.events[0].data.negotiated, false);
    ok('a negotiated id cannot be replayed');

    // Recycling: the server ends the stream on its lifetime so the client renegotiates.
    const neg2 = await request('POST', '/api/feed/negotiate', { creds: cookie });
    const shortLived = openSse('/api/feed?life=1&id=' + neg2.body.id, cookie);
    await shortLived.done;
    assert.ok(
        shortLived.events.some((e) => e.name === 'cycle'),
        'stream ended without announcing a recycle'
    );
    ok('stream recycles on its lifetime and says so');

    // --- chat channel (WebSocket)
    const chat = openWs('/api/chat', cookie);
    await chat.ready;
    await sleep(200);
    assert.strictEqual(chat.messages[0].type, 'hello');
    assert.strictEqual(chat.messages[0].identified, true);
    ok('chat socket connects and identifies the session');

    // --- posting a message reaches both transports
    const posted = await request('POST', '/api/messages', { creds: cookie, body: { channel: 'general', text: 'hello world' },
    });
    assert.strictEqual(posted.status, 200);
    assert.ok(posted.body.deliveredLive >= 1, 'message was not delivered over chat');
    assert.ok(posted.body.notified >= 1, 'message produced no notification');
    await sleep(250);
    assert.ok(
        chat.messages.some((m) => m.type === 'message' && m.message.text === 'hello world'),
        'chat socket never received the message'
    );
    assert.ok(
        feed.events.some((e) => e.name === 'notification' && e.data.channel === 'general'),
        'feed never received the notification'
    );
    ok('posting delivers live over chat and as a notification over the feed');

    const hist = await request('GET', '/api/messages?channel=general', { creds: cookie });
    assert.strictEqual(hist.body.messages.at(-1).text, 'hello world');
    ok('history persists the message');

    // --- typing travels upstream: the thing SSE cannot do
    const second = await request('POST', '/api/login', { body: { name: 'Grace' } });
    const cookie2 = credsFrom(second);
    const chat2 = openWs('/api/chat', cookie2);
    await chat2.ready;
    await sleep(150);
    chat2.send(JSON.stringify({ type: 'typing', channel: 'general' }));
    await sleep(250);
    assert.ok(
        chat.messages.some((m) => m.type === 'typing' && m.who === 'Grace'),
        'typing indicator did not reach the other client'
    );
    ok('typing from one client reaches another (bidirectional)');

    // --- the silent failure: a stream that arrives without the session
    const anon = openSse('/api/feed', null);
    await sleep(300);
    assert.strictEqual(anon.events[0].data.identified, false);
    ok('unidentified feed still opens — reproduces the silent failure');

    const anonChat = openWs('/api/chat', null);
    await anonChat.ready;
    await sleep(200);
    assert.strictEqual(anonChat.messages[0].identified, false);
    await request('POST', '/api/messages', { creds: cookie, body: { channel: 'general', text: 'unseen' } });
    await sleep(250);
    assert.ok(
        !anonChat.messages.some((m) => m.type === 'message'),
        'an unidentified socket must never receive messages'
    );
    ok('unidentified chat socket receives nothing, while staying open');

    chat.close();
    chat2.close();
    anonChat.close();

    // The decisive handshake check: a real WebSocket client, not our own framing code.
    if (typeof WebSocket === 'function') {
        const login3 = await request('POST', '/api/login', { body: { name: 'Alan' } });
        const cookie3 = credsFrom(login3);
        const hello = await new Promise((resolve, reject) => {
            const client = new WebSocket(
                `ws://127.0.0.1:${PORT}` + withCreds('/api/chat', cookie3),
                { headers: cookie3.headers.cookie ? { cookie: cookie3.headers.cookie } : {} });
            client.onmessage = (ev) => { client.close(); resolve(JSON.parse(ev.data)); };
            client.onerror = () => reject(new Error('real WebSocket client failed to connect'));
            setTimeout(() => reject(new Error('real WebSocket client timed out')), 4000);
        });
        assert.strictEqual(hello.type, 'hello');
        ok('a real WebSocket client completes the handshake');
    } else {
        console.log('  --  skipped real-client interop (no global WebSocket on this Node)');
    }
}

// ---- runner -----------------------------------------------------------------

(async () => {
    checkFraming();

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), HEARTBEAT_MS: '1000' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const serverLog = [];
    server.stdout.on('data', (d) => serverLog.push(d.toString()));
    server.stderr.on('data', (d) => serverLog.push(d.toString()));

    try {
        for (let i = 0; i < 50; i += 1) {
            try { await request('GET', '/api/health'); break; } catch { await sleep(100); }
        }
        await checkServer();
        console.log(`\n${passed} checks passed`);
    } catch (err) {
        console.error('\nFAILED:', err.message);
        if (serverLog.length) console.error('--- server output ---\n' + serverLog.join(''));
        process.exitCode = 1;
    } finally {
        server.kill();
    }
})();
