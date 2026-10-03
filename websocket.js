'use strict';
// Minimal RFC 6455 server. Zero dependencies on purpose: this app ships to a throwaway
// box by scp, and `npm install` there is one more thing to go wrong.
//
// ponytail: text + binary, fragmentation, ping/pong and close are handled; extensions
// (permessage-deflate) and subprotocol negotiation are not - no test here needs them.
// If you ever need compression, stop and take a dependency on `ws` instead.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function acceptKey(clientKey) {
    return crypto.createHash('sha1').update(clientKey + GUID).digest('base64');
}

/** True when this request is a WebSocket upgrade we should answer. */
function isUpgrade(req) {
    return (
        String(req.headers.upgrade || '').toLowerCase() === 'websocket' &&
        String(req.headers.connection || '').toLowerCase().includes('upgrade') &&
        Boolean(req.headers['sec-websocket-key'])
    );
}

function encodeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;

    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode; the server never fragments
    return Buffer.concat([header, data]);
}

/**
 * One connection. Emits 'message' (string), 'close', 'error'.
 * Server-to-client frames are never masked, per spec.
 */
class WebSocketConnection extends EventEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        this.closed = false;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.fragmentOpcode = null;

        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('close', () => this.#finish());
        socket.on('error', (err) => {
            this.emit('error', err);
            this.#finish();
        });
    }

    send(data) {
        if (this.closed || this.socket.destroyed) return false;
        this.socket.write(encodeFrame(OPCODE.TEXT, data));
        return true;
    }

    ping() {
        if (this.closed || this.socket.destroyed) return;
        this.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
    }

    close(code = 1000, reason = '') {
        if (this.closed) return;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        this.socket.write(encodeFrame(OPCODE.CLOSE, body));
        this.#finish();
        this.socket.end();
    }

    #finish() {
        if (this.closed) return;
        this.closed = true;
        this.emit('close');
    }

    #onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        // A single TCP read can carry several frames, or half of one.
        for (;;) {
            const frame = this.#readFrame();
            if (!frame) return;
            this.#handleFrame(frame);
            if (this.closed) return;
        }
    }

    /** Pulls one whole frame off the buffer, or returns null if more bytes are needed. */
    #readFrame() {
        const buf = this.buffer;
        if (buf.length < 2) return null;

        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let length = buf[1] & 0x7f;
        let offset = 2;

        if (length === 126) {
            if (buf.length < offset + 2) return null;
            length = buf.readUInt16BE(offset);
            offset += 2;
        } else if (length === 127) {
            if (buf.length < offset + 8) return null;
            const big = buf.readBigUInt64BE(offset);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
                this.close(1009, 'frame too large');
                return null;
            }
            length = Number(big);
            offset += 8;
        }

        let mask = null;
        if (masked) {
            if (buf.length < offset + 4) return null;
            mask = buf.subarray(offset, offset + 4);
            offset += 4;
        }

        if (buf.length < offset + length) return null;

        const payload = Buffer.from(buf.subarray(offset, offset + length));
        if (mask) {
            for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
        }
        this.buffer = buf.subarray(offset + length);
        return { fin, opcode, payload };
    }

    #handleFrame({ fin, opcode, payload }) {
        switch (opcode) {
            case OPCODE.PING:
                this.socket.write(encodeFrame(OPCODE.PONG, payload));
                return;
            case OPCODE.PONG:
                return;
            case OPCODE.CLOSE:
                this.#finish();
                this.socket.end();
                return;
            case OPCODE.CONTINUATION:
                this.fragments.push(payload);
                break;
            case OPCODE.TEXT:
            case OPCODE.BINARY:
                this.fragments = [payload];
                this.fragmentOpcode = opcode;
                break;
            default:
                this.close(1002, 'bad opcode');
                return;
        }

        if (!fin) return;
        const complete = Buffer.concat(this.fragments);
        this.fragments = [];
        const wasText = this.fragmentOpcode === OPCODE.TEXT;
        this.fragmentOpcode = null;
        this.emit('message', wasText ? complete.toString('utf8') : complete);
    }
}

/** Completes the handshake on an 'upgrade' event and hands back a connection. */
function accept(req, socket) {
    if (!isUpgrade(req)) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return null;
    }
    socket.setNoDelay(true);
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n` +
        '\r\n'
    );
    return new WebSocketConnection(socket);
}

module.exports = { accept, isUpgrade, acceptKey, encodeFrame, WebSocketConnection, OPCODE };
