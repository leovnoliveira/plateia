#!/usr/bin/env node
// Plateia: reads what a YouTube audience said, as compact JSON for the agent.
// Zero dependencies, Node 20+. Public data only: the same innertube endpoints
// the YouTube web page calls. No login, no API key, no profile scraping.
//
//   node plateia.mjs video <url|id> [--max 600] [--sort top|new]
//   node plateia.mjs channel <@handle|url|UC…> [--limit 10]
//
// `video` reads comments, or the chat replay of a past live when the video
// has one. It prints one JSON object on stdout: the video, counts, and the
// signals the agent turns into a reply. Errors go to stderr, exit 1.

const YT = 'https://www.youtube.com';
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9,pt-BR;q=0.8',
  // Skips the EU consent interstitial, which has no ytInitialData.
  cookie: 'CONSENT=YES+1; SOCS=CAI',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, opts = {}, attempt = 1) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20_000), headers: { ...HEADERS, ...(opts.headers || {}) } });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(800 * 2 ** attempt);
      return request(url, opts, attempt + 1);
    }
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url} -> HTTP ${res.status}`);
    return res;
  } catch (err) {
    if (attempt < 4 && !/HTTP 4\d\d/.test(err.message)) {
      await sleep(800 * 2 ** attempt);
      return request(url, opts, attempt + 1);
    }
    throw err;
  }
}

const getHtml = async (url) => (await request(url)).text();
const postJson = async (path, apiKey, body) => (await request(`${YT}${path}?key=${apiKey}&prettyPrint=false`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();

/* ---------- page payloads ---------- */

function embedded(html, name) {
  const m = html.match(new RegExp(`${name}(?:"\\])?\\s*=\\s*(\\{.+?\\});\\s*(?:var |<\\/script>)`, 's'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function client(html) {
  return {
    apiKey: html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1],
    clientVersion: html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20250101.00.00',
  };
}

// The innertube shape moves; searching by key survives more of that than paths.
function* walk(node) {
  if (node && typeof node === 'object') {
    yield node;
    for (const v of Object.values(node)) yield* walk(v);
  }
}

const runs = (r) => (r?.runs || []).map((x) => x.text ?? x.emoji?.shortcuts?.[0] ?? '').join('') || r?.simpleText || '';

function parseCount(s) {
  if (s == null) return 0;
  if (typeof s === 'number') return s;
  const t = String(s).trim().replace(/\s/g, '').toLowerCase();
  const m = t.match(/([\d.,]+)\s*(mil|mi|k|m|b)?/);
  if (!m) return 0;
  // "2,400,000" and "2.400.000" are thousands; "2.4" and "2,4" are decimals.
  const digits = /^\d{1,3}([.,]\d{3})+$/.test(m[1]) ? m[1].replace(/[.,]/g, '') : m[1].replace(',', '.');
  const n = parseFloat(digits);
  const mult = { k: 1e3, mil: 1e3, m: 1e6, mi: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.round(n * mult);
}

function videoId(target) {
  const t = String(target).trim();
  return t.match(/[?&]v=([\w-]{11})/)?.[1]
    || t.match(/youtu\.be\/([\w-]{11})/)?.[1]
    || t.match(/\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1]
    || (/^[\w-]{11}$/.test(t) ? t : null);
}

/* ---------- comments ---------- */

function commentToken(data) {
  for (const o of walk(data)) {
    const s = o.itemSectionRenderer;
    if (s?.sectionIdentifier === 'comment-item-section') {
      for (const c of s.contents || []) {
        const tok = c.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (tok) return tok;
      }
    }
  }
  // Fallback: any continuation whose target is the comments section.
  for (const o of walk(data)) {
    if (o.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
      && JSON.stringify(o).includes('comments-section')) {
      return o.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    }
  }
  return null;
}

function readCommentPage(json) {
  const comments = [];
  // Current layout: the text lives in entity mutations keyed by comment id.
  for (const m of json?.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
    const p = m.payload?.commentEntityPayload;
    if (!p) continue;
    comments.push({
      id: p.properties?.commentId,
      text: p.properties?.content?.content || '',
      author: p.author?.channelId || p.author?.displayName || '',
      likes: parseCount(p.toolbar?.likeCountNotliked || p.toolbar?.likeCountLiked),
      replies: parseCount(p.toolbar?.replyCount),
      when: p.properties?.publishedTime || '',
      reply: (p.properties?.replyLevel || 0) > 0,
    });
  }
  // Older layout.
  if (!comments.length) {
    for (const o of walk(json)) {
      const c = o.commentRenderer;
      if (!c) continue;
      comments.push({
        id: c.commentId, text: runs(c.contentText), author: c.authorEndpoint?.browseEndpoint?.browseId || runs(c.authorText),
        likes: parseCount(c.voteCount?.simpleText), replies: c.replyCount || 0, when: runs(c.publishedTimeText), reply: false,
      });
    }
  }
  let next = null;
  let newest = null;
  let total = null;
  for (const o of walk(json?.onResponseReceivedEndpoints)) {
    const tok = o.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    // A reply thread's "show more" button carries its own continuation; only the
    // page-level one is a bare continuationItemRenderer in the items list.
    if (tok && !o.continuationItemRenderer.button) next = tok;
    const h = o.commentsHeaderRenderer;
    if (h) {
      total = parseCount(runs(h.countText) || runs(h.commentsCount));
      const items = h.sortMenu?.sortFilterSubMenuRenderer?.subMenuItems || [];
      newest = items[1]?.serviceEndpoint?.continuationCommand?.token || null;
    }
  }
  return { comments, next, newest, total };
}

async function readComments(apiKey, ctx, token, { max, sort }) {
  let page = readCommentPage(await postJson('/youtubei/v1/next', apiKey, { context: ctx, continuation: token }));
  const total = page.total;
  if (sort === 'new' && page.newest) {
    page = readCommentPage(await postJson('/youtubei/v1/next', apiKey, { context: ctx, continuation: page.newest }));
  }
  const out = [...page.comments];
  while (page.next && out.length < max) {
    await sleep(250);
    page = readCommentPage(await postJson('/youtubei/v1/next', apiKey, { context: ctx, continuation: page.next }));
    if (!page.comments.length) break;
    out.push(...page.comments);
  }
  const seen = new Set();
  return { total, comments: out.filter((c) => c.id && !seen.has(c.id) && seen.add(c.id) && !c.reply).slice(0, max) };
}

/* ---------- chat replay of a past live ---------- */

function replayToken(data) {
  for (const o of walk(data)) {
    const lcr = o.conversationBar?.liveChatRenderer;
    if (lcr?.isReplay) return fullChat(lcr.continuations?.[0]?.reloadContinuationData?.continuation || null);
  }
  return null;
}

// The page's replay token serves "Top chat", which YouTube filters. One byte in
// the token picks the view: 4 is Top chat, 1 is the full chat.
function fullChat(token) {
  if (!token) return null;
  try {
    const hex = Buffer.from(decodeURIComponent(token).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex');
    const full = hex.replace(/720c0804/g, '720c0801');
    return full === hex ? token : Buffer.from(full, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  } catch {
    return token;
  }
}

async function readReplay(apiKey, ctx, token, { max }) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < 400 && token && out.length < max; i++) {
    const json = await postJson('/youtubei/v1/live_chat/get_live_chat_replay', apiKey, {
      context: ctx, continuation: token, currentPlayerState: { playerOffsetMs: String(offset) },
    });
    const lc = json?.continuationContents?.liveChatContinuation;
    if (!lc?.actions?.length) break;
    for (const a of lc.actions) {
      const r = a.replayChatItemAction;
      if (!r) continue;
      const at = Number(r.videoOffsetTimeMsec || 0);
      offset = Math.max(offset, at);
      for (const inner of r.actions || []) {
        const item = inner.addChatItemAction?.item;
        const m = item?.liveChatTextMessageRenderer || item?.liveChatPaidMessageRenderer;
        if (!m) continue;
        out.push({
          id: m.id, text: runs(m.message), author: m.authorExternalChannelId || runs(m.authorName),
          likes: 0, replies: 0, when: runs(m.timestampText), at_s: Math.round(at / 1000), paid: Boolean(item.liveChatPaidMessageRenderer),
        });
      }
    }
    token = lc.continuations?.[0]?.liveChatReplayContinuationData?.continuation || null;
    await sleep(150);
  }
  return out.slice(0, max);
}

/* ---------- signals ---------- */

const STOP = new Set(`a o e é de da do das dos em no na nos nas um uma uns umas que se por para pra com sem mais muito muita
mas como eu tu ele ela nós vocês eles elas me te lhe isso isto esse essa este esta aquele aquela já não sim só também foi ser ter
tem vai vou ao aos às à seu sua seus suas meu minha nosso nossa the a an and or of to in on for with is are was were be been it
this that you your i me my we our they them he she his her at as by from so but not no yes just do does did have has had what
how why when who all can will would there here about if than then out up get got like one more very really video vídeo kkk kkkk
kkkkk rs q vc vcs tá ta tô to pq oq ai aí la lá ja ne né`.split(/\s+/));

const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/https?:\S+/g, ' ').replace(/[^\p{L}\p{N}\s?]/gu, ' ').replace(/\s+/g, ' ').trim();

function signals(items) {
  // Same text from many different accounts is coordination (copypasta).
  const byText = new Map();
  for (const c of items) {
    const k = norm(c.text).replace(/\?/g, '');
    // Three words at least: "kkkkkk" from three people is laughter, not coordination.
    if (k.length < 12 || new Set(k.split(' ')).size < 3) continue;
    if (!byText.has(k)) byText.set(k, { text: c.text.slice(0, 200), authors: new Set(), n: 0 });
    const e = byText.get(k); e.authors.add(c.author); e.n++;
  }
  const copypasta = [...byText.values()].filter((e) => e.authors.size >= 3)
    .sort((a, b) => b.authors.size - a.authors.size).slice(0, 5)
    .map((e) => ({ text: e.text, accounts: e.authors.size, times: e.n }));

  // One account posting a lot: flood.
  const perAuthor = new Map();
  for (const c of items) perAuthor.set(c.author, (perAuthor.get(c.author) || 0) + 1);
  const flood = [...perAuthor.values()].filter((n) => n >= 8).length;

  // Repeated two- and three-word phrases: what people keep saying.
  const grams = new Map();
  for (const c of items) {
    const w = norm(c.text).replace(/\?/g, '').split(' ').filter((x) => x.length > 2 && !STOP.has(x));
    const local = new Set();
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) local.add(w.slice(i, i + n).join(' '));
    for (const g of local) grams.set(g, (grams.get(g) || 0) + 1);
  }
  // Longest phrase first among near-equal counts, then drop the fragments of a
  // phrase already kept: "via pix" says nothing "envie mensagem via pix" did not.
  const kept = [];
  const ranked = [...grams.entries()].filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  for (const [g, n] of ranked) {
    const words = g.split(' ');
    const overlaps = kept.some((k) => k.n >= n * 0.7 && words.filter((w) => k.words.includes(w)).length >= words.length - 1);
    if (!overlaps) kept.push({ g, n, words });
    if (kept.length === 15) break;
  }
  const phrases = kept.map(({ g, n }) => ({ phrase: g, comments: n }));

  // Timestamps people point at ("12:30"), the moments that landed or broke.
  const stamps = new Map();
  for (const c of items) for (const m of c.text.matchAll(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g)) stamps.set(m[0], (stamps.get(m[0]) || 0) + 1);
  const moments = [...stamps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([at, comments]) => ({ at, comments }));

  const questions = items.filter((c) => /\?\s*$|\?\s|^(como|qual|quando|onde|por que|porque|tem |vai ter|how|what|when|where|why|is there|can you|will you|does)/i.test(c.text.trim()))
    .sort((a, b) => b.likes - a.likes).slice(0, 40).map((c) => ({ text: c.text.slice(0, 280), likes: c.likes }));

  const clip = (c) => ({ text: c.text.slice(0, 280), likes: c.likes, replies: c.replies });
  const isChat = items.some((c) => c.at_s !== undefined);
  if (!isChat) {
    const top = [...items].sort((a, b) => b.likes - a.likes).slice(0, 25).map(clip);
    return { copypasta, flood_accounts: flood, phrases, moments, questions, top };
  }

  // Chat has no likes. What matters is when it spiked: the minutes with the most
  // messages, each with a few lines from that minute. Link posts are mostly the
  // channel's own promos, so they are left out of the samples.
  const fmt = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:00`;
  const perMin = new Map();
  for (const c of items) {
    const k = Math.floor(c.at_s / 60);
    if (!perMin.has(k)) perMin.set(k, []);
    perMin.get(k).push(c);
  }
  const avg = items.length / Math.max(perMin.size, 1);
  const peaks = [...perMin.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6)
    .filter(([, cs]) => cs.length >= Math.max(3, avg * 1.5))
    .map(([k, cs]) => ({ at: fmt(k * 60), messages: cs.length, sample: cs.filter((c) => !/https?:/.test(c.text)).slice(0, 4).map((c) => c.text.slice(0, 160)) }));
  const plain = items.filter((c) => !/https?:/.test(c.text));
  const step = Math.max(1, Math.floor(plain.length / 25));
  const sample = plain.filter((_, i) => i % step === 0).slice(0, 25).map((c) => ({ text: c.text.slice(0, 280), at: fmt(c.at_s).slice(0, -3) }));
  return { copypasta, flood_accounts: flood, phrases, moments, chat_peaks: peaks, questions, sample, paid_messages: items.filter((c) => c.paid).length };
}

/* ---------- commands ---------- */

async function video(target, { max, sort }) {
  const id = videoId(target);
  if (!id) throw new Error(`not a YouTube video link or id: ${target}`);
  const html = await getHtml(`${YT}/watch?v=${id}&hl=en`);
  const { apiKey, clientVersion } = client(html);
  const data = embedded(html, 'ytInitialData');
  const player = embedded(html, 'ytInitialPlayerResponse');
  if (!apiKey || !data) throw new Error('YouTube did not return a watch page (blocked, removed or private video)');
  const vd = player?.videoDetails || {};
  const ctx = { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } };

  const base = {
    video: {
      id, url: `https://youtu.be/${id}`, title: vd.title || null, channel: vd.author || null, channel_id: vd.channelId || null,
      views: Number(vd.viewCount || 0), length_s: Number(vd.lengthSeconds || 0), was_live: Boolean(vd.isLiveContent),
      live_now: Boolean(vd.isLive), published: player?.microformat?.playerMicroformatRenderer?.publishDate || null,
    },
  };

  const ct = commentToken(data);
  let source = 'comments';
  let total = null;
  let items = [];
  if (ct) ({ total, comments: items } = await readComments(apiKey, ctx, ct, { max, sort }));
  // A past live often has comments off but a chat replay; a big chat beats a few comments.
  const rt = vd.isLiveContent && !vd.isLive ? replayToken(data) : null;
  if (rt && items.length < 50) {
    const chat = await readReplay(apiKey, ctx, rt, { max: Math.max(max, 2000) });
    if (chat.length > items.length) { source = 'live_chat_replay'; items = chat; total = chat.length; }
  }
  if (!items.length) {
    return { ...base, source: ct ? 'comments' : 'none', read: 0, total: total ?? 0, note: ct ? 'no comments yet' : 'comments are turned off and there is no chat replay' };
  }
  return { ...base, source, read: items.length, total: total ?? items.length, sort, distinct_accounts: new Set(items.map((c) => c.author)).size, ...signals(items) };
}

async function channel(target, { limit }) {
  const t = String(target).trim();
  const path = t.includes('youtube.com/') ? new URL(t.startsWith('http') ? t : `https://${t}`).pathname.replace(/\/(videos|streams|shorts|featured)?\/?$/, '')
    : /^UC[\w-]{22}$/.test(t) ? `/channel/${t}` : `/${t.startsWith('@') ? t : `@${t}`}`;
  const found = new Map();
  let name = null;
  for (const tab of ['videos', 'streams']) {
    let html;
    try { html = await getHtml(`${YT}${path}/${tab}?hl=en`); } catch { continue; }
    const data = embedded(html, 'ytInitialData');
    name ||= data?.metadata?.channelMetadataRenderer?.title || null;
    for (const o of walk(data)) {
      const v = o.videoRenderer;
      if (v?.videoId && !found.has(v.videoId)) {
        found.set(v.videoId, { id: v.videoId, url: `https://youtu.be/${v.videoId}`, title: runs(v.title), published: runs(v.publishedTimeText), views: runs(v.viewCountText), tab });
      }
      const l = o.lockupViewModel;
      if (l?.contentId && l.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST' && !found.has(l.contentId)) {
        const rows = l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
        const parts = rows.flatMap((r) => (r.metadataParts || []).map((p) => p.text?.content)).filter(Boolean);
        found.set(l.contentId, { id: l.contentId, url: `https://youtu.be/${l.contentId}`, title: l.metadata?.lockupMetadataViewModel?.title?.content || '', meta: parts.join(' · '), tab });
      }
    }
  }
  if (!found.size) throw new Error(`no public videos found for ${target}`);
  return { channel: name, handle: path.replace(/^\//, ''), videos: [...found.values()].slice(0, limit) };
}

function args(argv) {
  const [cmd, target, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  return { cmd, target, opt };
}

const { cmd, target, opt } = args(process.argv.slice(2));
try {
  let out;
  if (cmd === 'video' && target) out = await video(target, { max: Math.min(Number(opt.max || 600), 3000), sort: opt.sort === 'new' ? 'new' : 'top' });
  else if (cmd === 'channel' && target) out = await channel(target, { limit: Math.min(Number(opt.limit || 10), 50) });
  else {
    console.error('usage: plateia.mjs video <url|id> [--max 600] [--sort top|new]\n       plateia.mjs channel <@handle|url> [--limit 10]');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
} catch (err) {
  console.error(`plateia: ${err.message}`);
  process.exit(1);
}
