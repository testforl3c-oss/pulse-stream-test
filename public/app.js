(function () {
  const $ = (id) => document.getElementById(id);
  const base = location.pathname.replace(/[^/]*$/, '');
  const api = (p) => base + 'api/' + p;

  // In token mode the credential rides in a header on fetch, and in the query string on the
  // WebSocket - a browser cannot set headers on a handshake. That is the same split M365 and
  // Teams use, which is why token mode survives a cross-domain hop that cookie mode does not.
  const authHeaders = (extra = {}) =>
    state.token ? { ...extra, authorization: 'Bearer ' + state.token } : extra;

  const withToken = (url) => {
    if (!state.token) return url;
    return url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(state.token);
  };

  const state = {
    me: null, channels: [], active: 'general', unread: {},
    chat: null, feed: null, typingTimer: null, lastTyped: 0,
    lastFeedAt: 0, events: 0, cycle: 0, token: null, authMode: 'cookie',
  };

  // ---- live activity log: the visible evidence that streams are flowing -------
  // Each entry is tagged with the transport it arrived on, so when one breaks you
  // can see at a glance which half of the app went quiet.
  function activity(transport, text, detail) {
    const list = $('activity');
    const blank = list.querySelector('.empty-ev');
    if (blank) blank.remove();

    const row = document.createElement('div');
    row.className = 'ev';
    row.innerHTML = `<span class="tag"></span><span class="body">`
      + `<span class="line"></span><div class="detail"></div></span><span class="t"></span>`;
    const tag = row.querySelector('.tag');
    tag.className = 'tag ' + (transport === 'ws' ? 'ws' : 'sse');
    tag.textContent = transport === 'ws' ? 'WS' : 'SSE';
    row.querySelector('.line').textContent = text;
    const d = row.querySelector('.detail');
    if (detail) d.textContent = detail; else d.remove();
    row.querySelector('.t').textContent = new Date()
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    list.prepend(row);
    while (list.children.length > 60) list.lastElementChild.remove();
    state.events += 1;
  }

  // "Last update" is driven only by the SSE channel. If the stream is buffered or cut
  // this number keeps climbing and turns amber, then red - a stalled stream becomes
  // visible without opening devtools.
  function markFeedAlive() { state.lastFeedAt = Date.now(); }

  setInterval(() => {
    if (!state.lastFeedAt) return;
    const age = Math.round((Date.now() - state.lastFeedAt) / 1000);
    $('syncAge').textContent = age < 1 ? 'just now' : age + 's ago';
    const box = $('sync');
    box.className = age > 60 ? 'dead' : age > 35 ? 'stale' : '';
  }, 1000);

  function pip(el, cls, title) {
    $(el).className = 'pip-item ' + cls;
    $(el).title = title;
  }

  // ---- sign in ----
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('name').value.trim();
    if (!name) return;
    const r = await fetch(api('login'), {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) return;
    const data = await r.json();
    state.token = data.token || null;
    state.authMode = data.authMode || 'cookie';
    start(data);
  });

  async function boot() {
    const r = await fetch(api('me'), { credentials: 'include', headers: authHeaders() });
    if (r.ok) start(await r.json());
  }

  function start(data) {
    state.me = data.name;
    state.channels = data.channels;
    $('signin').style.display = 'none';
    $('app').style.display = 'grid';
    $('whoami').textContent = data.name;
    renderChannels();
    renderPeople(data.members || []);
    openChat();
    openFeed();
    selectChannel('general');
  }

  // ---- rendering ----
  function renderChannels() {
    $('channels').innerHTML = '';
    for (const c of state.channels) {
      const b = document.createElement('button');
      b.className = 'chan';
      b.setAttribute('aria-current', String(c.id === state.active));
      b.innerHTML = `<span class="hash">#</span><span class="nm"></span><span class="badge" hidden></span>`;
      b.querySelector('.nm').textContent = c.name;
      const badge = b.querySelector('.badge');
      const n = state.unread[c.id] || 0;
      badge.textContent = n;
      badge.hidden = n === 0 || c.id === state.active;
      b.addEventListener('click', () => selectChannel(c.id));
      $('channels').append(b);
    }
  }

  function renderPeople(members) {
    $('people').innerHTML = '';
    for (const m of members) {
      const d = document.createElement('div');
      d.className = 'person' + (m.online ? ' on' : '');
      d.innerHTML = '<span class="pip"></span>';
      d.append(document.createTextNode(m.name));
      $('people').append(d);
    }
  }

  const initials = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function addMessage(m, { animate } = {}) {
    if (m.channel !== state.active) return;
    const empty = $('messages').querySelector('.empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML = `<div class="av"></div><div><div><span class="who"></span>`
      + `<span class="when"></span></div><div class="txt"></div></div>`;
    el.querySelector('.av').textContent = initials(m.author);
    el.querySelector('.who').textContent = m.author;
    el.querySelector('.when').textContent = clock(m.at);
    el.querySelector('.txt').textContent = m.text;
    if (animate) el.style.animation = 'pop .2s ease-out';
    $('messages').append(el);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  async function selectChannel(id) {
    state.active = id;
    state.unread[id] = 0;
    const c = state.channels.find((x) => x.id === id);
    $('chanName').textContent = '#' + c.name;
    $('chanTopic').textContent = c.topic;
    $('input').placeholder = 'Message #' + c.name;
    renderChannels();
    $('messages').innerHTML = '<div class="empty">Loading…</div>';
    const r = await fetch(api('messages') + '?channel=' + encodeURIComponent(id),
      { credentials: 'include', headers: authHeaders() });
    const { messages } = await r.json();
    $('messages').innerHTML = '';
    if (!messages.length) $('messages').innerHTML = '<div class="empty">No messages yet. Say something.</div>';
    for (const m of messages) addMessage(m);
  }

  function toast(title, body) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<b></b><p></p>';
    t.querySelector('b').textContent = title;
    t.querySelector('p').textContent = body;
    $('toasts').append(t);
    setTimeout(() => t.remove(), 5000);
  }

  function notice(text) {
    $('notice').hidden = !text;
    $('notice').textContent = text || '';
  }

  // ---- chat transport: WebSocket ----
  function openChat() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(withToken(`${scheme}//${location.host}${base}api/chat`));
    state.chat = sock;

    sock.onopen = () => {
      pip('pipChat', 'live', 'WebSocket connected');
      activity('ws', 'Chat connected', 'WebSocket /api/chat');
    };
    sock.onclose = () => {
      pip('pipChat', 'dead', 'WebSocket closed');
      activity('ws', 'Chat socket closed', 'reconnecting — new 101 handshake follows');
      setTimeout(openChat, 2000);
    };
    sock.onerror = () => pip('pipChat', 'dead', 'WebSocket error');
    sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') {
        if (!m.identified) {
          notice('Chat is connected but the server does not recognise this session, so no '
               + 'messages can arrive. Something between this page and the server dropped '
               + 'the session cookie.');
          activity('ws', 'Chat connected but UNIDENTIFIED', 'session cookie did not arrive');
        }
        renderPeople(m.members || []);
      } else if (m.type === 'message') {
        addMessage(m.message, { animate: true });
        activity('ws', `${m.message.author} posted in #${m.message.channel}`, m.message.text.slice(0, 60));
        if (m.message.channel !== state.active) {
          state.unread[m.message.channel] = (state.unread[m.message.channel] || 0) + 1;
          renderChannels();
        }
      } else if (m.type === 'typing' && m.channel === state.active) {
        $('typing').textContent = m.who + ' is typing…';
        clearTimeout(state.typingTimer);
        state.typingTimer = setTimeout(() => { $('typing').textContent = ''; }, 2500);
      }
    };
  }

  // ---- notification transport: SSE ----
  // Two steps, like SignalR: a short negotiate POST, then the stream GET carrying the id
  // it returned. The server recycles the stream on a timer and we immediately negotiate
  // again, so there is a fresh pair of requests every cycle - which is what makes this
  // observable in the network panel at any time, not just at page load.
  async function openFeed() {
    const ctrl = new AbortController();
    state.feed = ctrl;
    try {
      const neg = await fetch(api('feed/negotiate'), {
        method: 'POST', credentials: 'include', signal: ctrl.signal, headers: authHeaders(),
      });
      if (!neg.ok) throw new Error('negotiate ' + neg.status);
      const { id } = await neg.json();
      state.cycle += 1;
      activity('sse', `Negotiated notification channel #${state.cycle}`, 'POST /api/feed/negotiate');

      const res = await fetch(api('feed') + '?id=' + encodeURIComponent(id), {
        credentials: 'include', signal: ctrl.signal, headers: authHeaders(),
      });
      pip('pipFeed', 'live', 'Notification stream open');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        markFeedAlive();
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          const name = (block.match(/^event: (.*)$/m) || [])[1] || 'message';
          const data = JSON.parse((block.match(/^data: (.*)$/m) || [])[1] || '{}');
          onFeed(name, data);
        }
      }
      // Clean recycle: go straight round again, no backoff.
      pip('pipFeed', 'stale', 'Reconnecting notification stream');
      openFeed();
    } catch (err) {
      if (err.name === 'AbortError') return;
      pip('pipFeed', 'dead', 'Notification stream failed');
      activity('sse', 'Notification channel failed', String(err.message || err));
      setTimeout(openFeed, 3000);
    }
  }

  function onFeed(name, data) {
    if (name === 'hello') {
      activity('sse', 'Notification stream connected',
        `text/event-stream · recycles every ${Math.round((data.lifetimeMs || 0) / 1000)}s`);
      if (!data.identified) {
        notice('Notification stream connected but unidentified — alerts and unread badges '
             + 'will never arrive on this connection.');
        activity('sse', 'Stream connected but UNIDENTIFIED', 'session cookie did not arrive');
      }
      renderPeople(data.members || []);
    } else if (name === 'ping') {
      // Heartbeat. Not logged as an entry - it drives the "Last update" clock instead.
    } else if (name === 'cycle') {
      activity('sse', 'Stream recycled by server', `after ${Math.round(data.afterMs / 1000)}s — renegotiating`);
    } else if (name === 'presence') {
      renderPeople(data.members || []);
      activity('sse', 'Presence updated', (data.members || []).map((m) => m.name).join(', '));
    } else if (name === 'notification') {
      if (data.author === state.me) return;
      toast('#' + data.channel + ' · ' + data.author, data.preview);
      activity('sse', `Alert: ${data.author} in #${data.channel}`, data.preview);
      if (data.channel !== state.active) {
        state.unread[data.channel] = (state.unread[data.channel] || 0) + 1;
        renderChannels();
      }
    } else if (name === 'activity') {
      if (data.kind === 'joined') {
        activity('sse', `${data.who} joined`);
        if (data.who !== state.me) toast(data.who + ' joined', 'Say hello');
      }
    }
  }

  // ---- composing ----
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    $('input').value = '';
    await fetch(api('messages'), {
      method: 'POST', credentials: 'include',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ channel: state.active, text }),
    });
    // Deliberately not rendered here. It appears only when it comes back down the chat
    // socket, exactly like Teams - so a broken stream is immediately visible.
  });

  $('input').addEventListener('input', () => {
    const t = Date.now();
    if (t - state.lastTyped < 1500) return;
    state.lastTyped = t;
    if (state.chat && state.chat.readyState === WebSocket.OPEN) {
      state.chat.send(JSON.stringify({ type: 'typing', channel: state.active }));
    }
  });

  boot();
})();
