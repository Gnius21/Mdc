/* Regional Weather Centre — background push worker
 *
 * Runs on a Cron Trigger, independent of whether the dashboard page is open.
 * Polls METAR for TNCA/TNCB/TNCC/TNCM/SVMI/SVVA, and for every subscribed
 * device sends a real Web Push notification (RFC 8291/8188, no library) when:
 *   - TNCA, TNCB or TNCC reports RA/SHRA/TS/TSRA (any intensity)      [default]
 *   - a station the device configured with a gust alarm meets its threshold
 *
 * Storage: a single KV key holds the JSON array of subscription records.
 * Fine for a personal dashboard with a handful of devices; migrate to one
 * key per subscription if this ever needs to scale up.
 */

const STATIONS = ['TNCA', 'TNCB', 'TNCC', 'TNCM', 'SVMI', 'SVVA'];
const WX_NOTIFY_ICAOS = ['TNCA', 'TNCB', 'TNCC'];
const SUBS_KEY = 'subs_v1';
const METAR_URL = (icao) => `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao}.TXT`;

/* ── base64url + byte helpers ── */
function utf8(s) { return new TextEncoder().encode(s); }
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function b64url(buf) {
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── METAR fetch + parse (mirrors the client's logic for RA/SHRA/TS/TSRA + gust) ── */
async function fetchMetar(icao) {
  try {
    const r = await fetch(METAR_URL(icao), { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    const txt = (await r.text()).trim();
    const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let raw = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (ln.startsWith(icao) || /\b\d{6}Z\b/.test(ln) || /^[A-Z]{4}\s+\d{6}Z/.test(ln)) {
        if ((icao === 'SVMI' || icao === 'SVVA') && /\bAUTO\b/i.test(ln)) continue;
        raw = ln; break;
      }
    }
    if (!raw) return null;
    const tm = raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
    const time = tm ? `${tm[2]}:${tm[3]}Z` : null;
    const gustM = raw.match(/\b(?:VRB|\d{3})\d{2}G(\d{2,3})KT\b/i);
    const gust = gustM ? parseInt(gustM[1], 10) : 0;
    const wxTokens = raw.split(/\s+/).filter(tok =>
      /^(?:\+|-)?(?:VC)?(?:TS|VCTS|VCSH|TSRA|SH|SHRA|RA|DZ|SN|FG|BR|HZ|SQ|PO)/i.test(tok));
    const wx = wxTokens.join(' ') || '--';
    return { time, gust, wx, raw };
  } catch (e) { return null; }
}
function hasNotifyWx(wxText) {
  const txt = String(wxText || '').trim();
  if (!txt || txt === '--') return false;
  return txt.split(/\s+/).some(tok => /^[+-]?(?:TSRA|SHRA|TS|RA)$/i.test(tok));
}
function tsPresent(wxText) {
  return /\b(?:TS|TSRA|VCTS)\b/i.test(String(wxText || ''));
}

/* ── HKDF via WebCrypto ── */
async function hkdf(ikm, salt, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBytes * 8);
  return new Uint8Array(bits);
}

/* ── Web Push payload encryption (RFC 8291 + RFC 8188 aes128gcm) ──
   Round-trip tested locally against a simulated subscriber before shipping. */
async function encryptPayload(payloadObj, p256dhB64, authB64) {
  const uaPublicRaw = b64urlToBuf(p256dhB64);
  const authSecret = b64urlToBuf(authB64);

  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));
  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256));

  const keyInfo = concat(utf8('WebPush: info'), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo = concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0]));
  const nonceInfo = concat(utf8('Content-Encoding: nonce'), new Uint8Array([0]));
  const cek = await hkdf(ikm, salt, cekInfo, 16);
  const nonce = await hkdf(ikm, salt, nonceInfo, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concat(utf8(JSON.stringify(payloadObj)), new Uint8Array([2])); // 0x02 = last-record delimiter
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext));

  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096, false);
  const header = concat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concat(header, ct);
}

/* ── VAPID (RFC 8292) ── */
async function importVapidPrivateKey(env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY_JWK);
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
async function vapidAuthHeader(env, endpoint) {
  const privKey = await importVapidPrivateKey(env);
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT };
  const signingInput = `${b64url(utf8(JSON.stringify(header)))}.${b64url(utf8(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, utf8(signingInput));
  const jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

/* ── Send one push; returns {ok, gone} — gone=true means the subscription is dead (404/410) ── */
async function sendPush(env, subRecord, payloadObj) {
  try {
    const body = await encryptPayload(payloadObj, subRecord.subscription.keys.p256dh, subRecord.subscription.keys.auth);
    const auth = await vapidAuthHeader(env, subRecord.subscription.endpoint);
    const res = await fetch(subRecord.subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '3600',
        'Urgency': 'high',
        'Authorization': auth
      },
      body
    });
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true };
    return { ok: res.ok, gone: false };
  } catch (e) {
    return { ok: false, gone: false };
  }
}

/* ── ntfy publishing (https://ntfy.sh) — the simple push channel ──
   If NTFY_TOPIC is set, the cron also publishes alerts to that topic; the
   ntfy app on the phone shows them natively. Needs no VAPID keys, secrets or
   device subscriptions — the easiest way to get background alerts. */
async function publishNtfy(env, title, message, priority, tags) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch(env.NTFY_SERVER || 'https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, priority: priority || 4, tags: tags || ['warning'] })
    });
  } catch (e) {}
}

/* ── KV helpers ── */
async function loadSubs(env) {
  const raw = await env.PUSH_KV.get(SUBS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
async function saveSubs(env, subs) {
  await env.PUSH_KV.put(SUBS_KEY, JSON.stringify(subs));
}

/* ── CORS ── */
function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || '*');
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = allowed === '*' ? '*' : (origin === allowed ? allowed : allowed);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Push-Secret',
    'Vary': 'Origin'
  };
}
function checkSecret(env, request) {
  if (!env.SHARED_SECRET) return true; // no secret configured = open (fine for a personal single-user dashboard)
  return request.headers.get('X-Push-Secret') === env.SHARED_SECRET;
}

/* ── HTTP handler ── */
async function handleRequest(request, env) {
  const cors = corsHeaders(env, request);
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  if (url.pathname === '/' && request.method === 'GET') {
    return new Response('OK', { headers: cors });
  }

  if (url.pathname === '/subscribe' && request.method === 'POST') {
    if (!checkSecret(env, request)) return new Response('unauthorized', { status: 401, headers: cors });
    let data;
    try { data = await request.json(); } catch (e) { return new Response('bad json', { status: 400, headers: cors }); }
    if (!data || !data.subscription || !data.subscription.endpoint) {
      return new Response('missing subscription', { status: 400, headers: cors });
    }
    const subs = await loadSubs(env);
    const idx = subs.findIndex(s => s.subscription.endpoint === data.subscription.endpoint);
    const record = {
      subscription: data.subscription,
      stations: data.stations || {},
      lastNotified: (idx >= 0 ? subs[idx].lastNotified : {}) || {}
    };
    if (idx >= 0) subs[idx] = record; else subs.push(record);
    await saveSubs(env, subs);
    return new Response(JSON.stringify({ ok: true, count: subs.length }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  if (url.pathname === '/unsubscribe' && request.method === 'POST') {
    if (!checkSecret(env, request)) return new Response('unauthorized', { status: 401, headers: cors });
    let data;
    try { data = await request.json(); } catch (e) { return new Response('bad json', { status: 400, headers: cors }); }
    const subs = await loadSubs(env);
    const filtered = subs.filter(s => s.subscription.endpoint !== (data && data.endpoint));
    await saveSubs(env, filtered);
    return new Response(JSON.stringify({ ok: true, count: filtered.length }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  return new Response('not found', { status: 404, headers: cors });
}

/* ── Cron handler: poll METAR, notify subscriptions whose conditions are newly met ── */
async function handleScheduled(env) {
  const subs = await loadSubs(env);
  const ntfyOn = !!env.NTFY_TOPIC;
  if (!subs.length && !ntfyOn) return;

  const metars = {};
  for (const icao of STATIONS) metars[icao] = await fetchMetar(icao);

  // ── ntfy channel: default wx alerts (TNCA/TNCB/TNCC RA/SHRA/TS/TSRA) plus
  //    the classic TNCA gust≥35+TS special alarm. Dedup state kept in KV. ──
  if (ntfyOn) {
    let last = {};
    try { last = JSON.parse(await env.PUSH_KV.get('ntfy_last_v1')) || {}; } catch (e) { last = {}; }
    let nChanged = false;
    for (const icao of WX_NOTIFY_ICAOS) {
      const m = metars[icao];
      if (!m || !m.time) continue;
      if (hasNotifyWx(m.wx) && last[icao + '_wx'] !== m.time) {
        await publishNtfy(env, `${icao} — significant weather`, `${m.wx} reported at ${m.time}.\n${m.raw}`, 4, ['zap']);
        last[icao + '_wx'] = m.time; nChanged = true;
      }
    }
    const a = metars['TNCA'];
    if (a && a.time && a.gust >= 35 && tsPresent(a.wx) && last['TNCA_gust'] !== a.time) {
      await publishNtfy(env, 'Special Alarm — TNCA', `Gust ${a.gust}kt with ${a.wx} — immediate attention required.\n${a.raw}`, 5, ['rotating_light']);
      last['TNCA_gust'] = a.time; nChanged = true;
    }
    if (nChanged) await env.PUSH_KV.put('ntfy_last_v1', JSON.stringify(last));
  }

  if (!subs.length) return;

  let changed = false;
  const stillAlive = [];
  for (const sub of subs) {
    let dead = false;
    sub.lastNotified = sub.lastNotified || {};
    for (const icao of STATIONS) {
      const m = metars[icao];
      if (!m || !m.time) continue;

      // Default weather notification (TNCA/TNCB/TNCC, RA/SHRA/TS/TSRA) — always on.
      if (WX_NOTIFY_ICAOS.includes(icao) && hasNotifyWx(m.wx)) {
        const key = icao + '_wx';
        if (sub.lastNotified[key] !== m.time) {
          const r = await sendPush(env, sub, {
            title: `🌧 ${icao} — significant weather`,
            body: `${m.wx} reported at ${m.time}.\n${m.raw}`,
            tag: `wx-alert-${icao}`
          });
          if (r.gone) { dead = true; break; }
          sub.lastNotified[key] = m.time; changed = true;
        }
      }

      // Per-station gust alarm (mirrors the client's Settings config).
      const cfg = sub.stations && sub.stations[icao];
      if (cfg && cfg.alarm && m.gust >= (cfg.gust || 35) && (!cfg.requireTS || tsPresent(m.wx))) {
        const key = icao + '_gust';
        if (sub.lastNotified[key] !== m.time) {
          const r = await sendPush(env, sub, {
            title: `⚠ Special Alarm — ${icao}`,
            body: `Gust ${m.gust}kt with ${m.wx} — immediate attention required.\n${m.raw}`,
            tag: `special-alarm-${icao}`
          });
          if (r.gone) { dead = true; break; }
          sub.lastNotified[key] = m.time; changed = true;
        }
      }
    }
    if (!dead) stillAlive.push(sub);
    else changed = true;
  }
  if (changed) await saveSubs(env, stillAlive);
}

export default {
  fetch: handleRequest,
  scheduled(event, env, ctx) { ctx.waitUntil(handleScheduled(env)); }
};
