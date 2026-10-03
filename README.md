# Pulse

A small team messaging product — sign in, pick a channel, talk. Channels, message
history, unread badges, presence, typing indicators, desktop-style notifications.

It is also a deliberate stand-in for Teams and Outlook, because it is built the same way:

| feature | transport |
|---|---|
| chat messages, typing indicators | **WebSocket** `/api/chat` |
| notifications, unread badges, presence | **Server-Sent Events** `/api/feed` |
| sign-in, history, posting | ordinary HTTP |

## Two auth modes

How the session is proven is switchable, because the two shapes break differently:

```bash
node server.js                  # AUTH_MODE=cookie (default)
AUTH_MODE=token node server.js  # mimics M365 / Teams
```

| mode | credential | why it is here |
|---|---|---|
| `cookie` | host-only `HttpOnly` cookie | how most ordinary web apps work — probes what a proxy will do to the **next** app onboarded |
| `token` | `Authorization: Bearer` on fetch, `?access_token=` on the WebSocket | how M365 and Teams actually authenticate — mirrors the traffic **production already carries** |

The split in token mode is not arbitrary: a browser cannot set headers on a WebSocket
handshake, so the token has to travel in the query string there. That is the same compromise
the real apps make, and it is why token-authenticated channels survive a cross-domain hop
that cookie-authenticated ones do not.

Run both. A failure in one mode and not the other tells you immediately whether the problem
is credential transport or something else. `npm test` covers both — pass `AUTH_MODE=token`
to run the token variant.

Both long-lived connections are tied to the session, and
both are **recycled on a timer** rather than held open forever:

```
POST /api/feed/negotiate   ->  { id }          a short request, like SignalR's negotiate
GET  /api/feed?id=...      ->  text/event-stream, ends after its lifetime
                               client negotiates again immediately
```

That matters for testing. A stream opened once at page load is invisible unless devtools
happened to be open at that moment. Recycling means a fresh negotiate + stream pair
appears every cycle, so you can open the network panel at any time and watch it happen —
and watch it happen repeatedly, which is how the original Outlook bug was pinned down.

| env var | default | what it does |
|---|---|---|
| `FEED_LIFETIME_MS` | 60000 | how long each SSE stream lives before recycling |
| `CHAT_LIFETIME_MS` | 180000 | same for the chat WebSocket |
| `HEARTBEAT_MS` | 15000 | heartbeat interval on both |

Drop `FEED_LIFETIME_MS` to 20000 while testing to make cycles obvious.

That matters because it means Pulse **fails the way those products fail**. When a proxy
mishandles streams, the app still loads, the channel list still works, posting still
returns 200 — and messages simply never appear until you reload. No error, nothing in the
console. That is the symptom worth being able to reproduce on demand.

Zero dependencies. Node 18+ and the standard library only, so it ships by `scp` and runs.

```bash
node server.js                                              # http://localhost:8080
PORT=443 TLS_KEY=key.pem TLS_CERT=cert.pem node server.js   # https + wss
npm test                                                    # 16 checks
```

## Using it

Open it, pick a name, join. For a second person use **another browser or a private
window** — one browser profile holds one session cookie, same as any real app.

Or drive a second user from the shell and watch the browser update live:

```bash
curl -s -c grace.txt -X POST -H 'content-type: application/json' \
  -d '{"name":"Grace"}' http://localhost:8080/api/login

curl -s -b grace.txt -X POST -H 'content-type: application/json' \
  -d '{"channel":"general","text":"did the release go out?"}' \
  http://localhost:8080/api/messages
```

The message should appear in the open browser with no reload, `#general` should toast, and
posting to `#releases` instead should raise an unread badge.

The response tells you what the server managed to deliver:

```json
{ "ok": true, "deliveredLive": 1, "notified": 1 }
```

`deliveredLive: 0` means nobody's chat socket got it. `notified: 0` means no notification
feed got it. Those two numbers localise a stream problem immediately.

## Testing it through a proxy

Work up in three steps — each rules out a layer, so a failure at the last step has only one
possible cause left.

1. **Direct.** Run it, use it, confirm messages appear live. This is your control.
2. **Through your proxy, with no CDN or edge in front.** A failure here is the proxy itself.
3. **Through the full chain,** edge included. A failure only here is the edge.

What a failure looks like, and what it means:

| symptom | cause |
|---|---|
| messages appear only after reload | the stream is being buffered or cut |
| banner about an unrecognised session | the session credential did not survive the hop |
| chat works, badges and toasts do not | SSE specifically is broken; WebSocket is fine |
| badges work, messages do not | WebSocket specifically is broken |
| `deliveredLive: 0` in the post response | no chat socket is attached to any session |

Those last rows are why both transports live in one app: whatever breaks is usually one of
them, and running them side by side names which.

### Proving a buffering problem

Make the stream close itself after N seconds and time the **first** byte:

```bash
curl -N -o /dev/null -w 'first byte %{time_starttransfer}s\n' \
  '<host>/api/feed?id=<id>&close=5'
```

A host that streams correctly gives a flat first-byte time whatever N is. A host that
buffers gives a first byte at exactly N — everything withheld until the connection ends.
Vary N (2, 4, 8): if the first byte tracks it, that is buffering, not a timeout.

`?silent=10` sends nothing for 10s, mimicking a handshake-gated stream.

## API

| | |
|---|---|
| `POST /api/login` `{name}` | sets `pulse_sid` — `HttpOnly`, host-only, no `Domain` |
| `GET /api/me` | current user, channels, members |
| `GET /api/messages?channel=` | last 50 messages |
| `POST /api/messages` `{channel,text}` | post; returns `deliveredLive` and `notified` |
| `POST /api/feed/negotiate` | returns a single-use `{id}` for the stream to present |
| `GET /api/feed?id=&life=&close=&silent=` | `text/event-stream` — `hello`, `notification`, `presence`, `activity`, `ping`, `cycle` |
| `GET /api/chat` | WebSocket — `hello`, `message`, `typing` |
| `GET /api/health` | `{ok, users, chatSockets, feeds}` |

## Files

| | |
|---|---|
| `server.js` | product API, SSE feed, upgrade routing |
| `websocket.js` | RFC 6455 server — handshake and framing, no dependencies |
| `public/index.html` | the app |
| `test/check.js` | `npm test` — framing units plus both transports end to end |

`websocket.js` handles text, binary, fragmentation, ping/pong and close. It does **not**
do `permessage-deflate` or subprotocol negotiation; nothing here needs them. If you ever
want compression, take a dependency on `ws` rather than extending this.

The accept-key check in `test/check.js` asserts the RFC 6455 test vector as a literal, on
purpose. Recomputing the digest with the same GUID the implementation uses would pass even
when that GUID is wrong — which is exactly how a transposed GUID shipped here once.
