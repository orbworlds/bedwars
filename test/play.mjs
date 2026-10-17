#!/usr/bin/env node
// Bed Wars (public/templates/bedwars.html) in a headless browser, through its ?debug hooks (window.__bw):
// every arena in both layouts is checked for what play needs, every mode plays (one to the very end), the shop and
// items work, progression pays out (quests, coins, the Bed Pass, boxes, achievements, the login streak, the wardrobe and
// credit purchases), and two players in one match room see each other, pick teams and play (orb.room faked with a
// relay between two browser windows). Then phones and tablets: a phone plays from the daily reward to the end of a match
// by touch alone, and in every size (and Safari's engine, WebKit, where it's installed) everything fits and takes a tap.
//
//   node scripts/test-bedwars.mjs [--quick: no whole match] [--phones: only the phones and tablets]
import { webkit, devices } from 'playwright';
import { launch, routeCdn } from './pw.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The game: index.html at the top of its own repository (where this suite is test/play.mjs), or
// Orb's copy of it (public/templates/bedwars.html, this suite being scripts/test-bedwars.mjs).
const GAME = ['index.html', 'public/templates/bedwars.html'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
const URL = 'file://' + GAME + '?debug';
const quick = process.argv.includes('--quick'), phonesOnly = process.argv.includes('--phones');
let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failures++; };

// A stand-in for Orb's runtime: rooms relayed between the pages by this process, a store and a shop in memory.
function fakeOrb({ id, name }) {
  window.orb = {
    me: { id, name, color: '#5ed1ff', wears: [] },
    world: { id: 'test', name: 'Bed Wars' },
    room: {
      invited: null,
      invite: async (r) => `https://example.test/?room=${r}`,
      join(cb, opts = {}) {
        const topic = 'room:' + (opts.name || ''), self = { id: `${id}:${Math.random().toString(36).slice(2, 8)}`, name, color: '#5ed1ff' };
        // a channel through the test process to the other pages (each page has a window of its own)
        const ch = { onmessage: null, postMessage: (data) => window.__relay?.(topic, data), close() { ch.closed = true; } };
        (window.__chans ||= []).push([topic, ch]);
        let state = null, left = false;
        const known = new Map();
        const peer = (p) => ({ id: p.id, name: p.name, color: p.color, wears: [], state: p.state, friend: false });
        ch.onmessage = (ev) => {
          const m = ev.data; if (left || !m || m.from?.id === self.id) return;
          if (m.t === 'hello' || m.t === 'state') {
            const had = known.has(m.from.id); known.set(m.from.id, { ...m.from, state: m.state });
            cb({ type: had ? 'state' : 'join', peer: peer(known.get(m.from.id)) });
            if (m.t === 'hello' && !m.reply) ch.postMessage({ t: 'hello', reply: true, from: self, state });
          } else if (m.t === 'msg') cb({ type: 'message', peer: peer(known.get(m.from.id) || m.from), data: m.data });
          else if (m.t === 'bye' && known.has(m.from.id)) { const p = known.get(m.from.id); known.delete(m.from.id); cb({ type: 'leave', peer: peer(p) }); }
        };
        setTimeout(() => { cb({ type: 'joined', self: peer(self), peers: [...known.values()].map(peer), live: true }); ch.postMessage({ t: 'hello', from: self, state }); }, 30);
        const room = {
          send: (data) => !left && ch.postMessage({ t: 'msg', from: self, data }),
          setState: (s) => { state = s; if (!left) ch.postMessage({ t: 'state', from: self, state: s }); },
          leave: () => { if (left) return; ch.postMessage({ t: 'bye', from: self }); left = true; ch.close(); },
        };
        return room;
      },
    },
    store: (() => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => (m.set(k, v), v), incr: async (k, by = 1) => { const v = (m.get(k) || 0) + by; m.set(k, v); return v; },
      merge: async (k, p) => { const v = { ...(m.get(k) || {}) }; for (const [a, b] of Object.entries(p)) { if (b === null) delete v[a]; else v[a] = b; } m.set(k, v); return v; } }; })(),
    shop: { owned: async () => window.__owned || [], items: async () => [], buy: async (item) => { (window.__owned ||= []).push(item); return { ok: true, item }; } },
    capture() {}, toast() {},
  };
}

const pages = new Set();
async function openPage(browser, who, device = { viewport: { width: 960, height: 600 } }, { daily = false, seed = null } = {}) {
  const page = await (await browser.newContext(device)).newPage();
  pages.add(page); page.on('close', () => pages.delete(page));
  await page.exposeFunction('__relay', (topic, data) => {
    for (const p of pages) if (p !== page) p.evaluate(([t, d]) => { for (const [tp, ch] of window.__chans || []) if (tp === t && !ch.closed) ch.onmessage?.({ data: d }); }, [topic, data]).catch(() => {});
  });
  await routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${who} console: ${m.text()}`); });
  if (who !== 'solo') await page.addInitScript(fakeOrb, { id: `${who}-id`, name: who });
  if (seed) await page.addInitScript(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), seed);   // what this device kept from before
  await page.goto(URL);
  await page.waitForFunction(() => window.__bw?.game.mode === 'lobby', null, { timeout: 30000 });
  // the daily reward pops up a moment after the lobby: kept closed unless the test is about it
  if (!daily) await page.evaluate(() => { const d = document.getElementById('daily'), shut = () => d.classList.contains('hidden') || d.classList.add('hidden'); new MutationObserver(shut).observe(d, { attributes: true }); shut(); });
  return { page, errors };
}
const play = (page, mode, mp) => page.evaluate(([mode, mp]) => { const b = window.__bw; b.mp = mp; b.playMode(mode); }, [mode, mp]);
const startNow = (page) => page.evaluate(() => { window.__bw.match.cd = 0.05; });
const fast = (page, speed) => page.evaluate((s) => { window.__bw.speed = s; window.__bw.norender = s > 1; }, speed);

// Phones and tablets: real touches through Chromium's DevTools protocol (they arrive as touch and pointer events, and a
// tap clicks), in each size and both ways round.
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const device = (width, height, userAgent = IPHONE) => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent });
async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
  const at = (p) => (typeof p === 'string' ? page.$eval(p, (el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }) : p);
  return {
    async tap(p) { await send('touchStart', [await at(p)]); await page.waitForTimeout(60); await send('touchEnd', []); await page.waitForTimeout(300); },
    async down(p) { await send('touchStart', [await at(p)]); await page.waitForTimeout(120); },
    async up() { await send('touchEnd', []); await page.waitForTimeout(120); },
    async drag(p0, [x1, y1], ms = 300, holdMs = 0) {
      const [x0, y0] = await at(p0);
      await send('touchStart', [[x0, y0]]);
      for (let i = 1; i <= 8; i++) { await send('touchMove', [[x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8]]); await page.waitForTimeout(ms / 8); }
      if (holdMs) await page.waitForTimeout(holdMs);
      await send('touchEnd', []); await page.waitForTimeout(150);
    },
  };
}
/** What's wrong on screen: each control should be inside the screen, big enough for a thumb, on top where it is (a tap
 *  there reaches it) and clear of the other controls and of the HUD's panels (`[controls, panels]`); the panels should
 *  be inside the screen and clear of each other. */
const auditControls = (page, [controls, panels = []]) => page.evaluate(([controls, panels]) => {
  const bad = [], seen = [], shown = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && !el.closest('.hidden') && el.getBoundingClientRect().width > 0; };
  const over = (r, r2) => Math.min(r.right, r2.right) - Math.max(r.left, r2.left) > 3 && Math.min(r.bottom, r2.bottom) - Math.max(r.top, r2.top) > 3;
  const offScreen = (r) => r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1;
  // what of it shows: a list that scrolls clips what's scrolled away (a swipe brings it back)
  const inView = (el) => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (!/auto|scroll|hidden/.test(getComputedStyle(a).overflow)) continue;
      const c = a.getBoundingClientRect(); left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
    }
    return right - left > 3 && bottom - top > 3 ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  };
  const boxes = panels.flatMap((sel) => [...document.querySelectorAll(sel)].filter(shown).map((el) => [el.id || sel, el, el.getBoundingClientRect()]));
  for (const [i, [name, el, r]] of boxes.entries()) {
    if (offScreen(r)) bad.push(`${name} off screen`);
    for (const [n2, el2, r2] of boxes.slice(0, i)) if (!el.contains(el2) && !el2.contains(el) && over(r, r2)) bad.push(`${name} on ${n2}`);
  }
  for (const sel of controls) for (const el of document.querySelectorAll(sel)) {
    if (!shown(el)) continue;
    const r = inView(el), full = el.getBoundingClientRect(), name = el.id || el.getAttribute('aria-label') || sel;
    if (!r) continue;
    if (offScreen(r)) bad.push(`${name} off screen`);
    if (Math.min(full.width, full.height) < 36) bad.push(`${name} ${Math.round(full.width)}×${Math.round(full.height)} px`);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && !el.contains(hit)) bad.push(`${name} under ${hit.id || hit.className || hit.tagName}`);
    for (const [n2, r2] of seen) if (over(r, r2)) bad.push(`${name} on ${n2}`);
    for (const [n2, box, r2] of boxes) if (!box.contains(el) && over(r, r2)) bad.push(`${name} on ${n2}`);
    seen.push([name, r]);
  }
  return [...new Set(bad)];
}, [controls, panels]);
const LOBBY_CONTROLS = [['#bPlay', '#bEmote', '#tJump', '#tSneak', '#tUse', '#bQuests', '#bPass', '#bWardrobe', '#bBoxes', '#bBoards', '#inviteBtn', '#camBtn', '#muteBtn', '#pauseBtn'], ['#lTop']];
const WAIT_CONTROLS = [['#wStart', '#wInvite', '#wLeave', '#wTeams [data-t]', '#tJump', '#tSneak', '#pauseBtn', '#inviteBtn', '#camBtn', '#muteBtn'], ['#wait', '#tl']];
const MATCH_CONTROLS = [['#tBreak', '#tPlace', '#tJump', '#tSneak', '#shopBtn', '#chatBtn', '#pauseBtn', '#camBtn', '#muteBtn', '#inviteBtn', '#hotbar .slot'], ['#tl', '#bwTop', '#hearts', '#res', '#hotbar']];
const canvasAt = (page, x, y) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [x, y]);

const browser = await launch();
try {
  if (!phonesOnly) {
  // --- the lobby ----------------------------------------------------------------------------------------------------
  const { page, errors } = await openPage(browser, 'solo');
  const lobby = await page.evaluate(() => { const b = window.__bw, w = b.world(); return { kind: w.kind, keepers: b.npcs.filter((n) => n.keeper).length, modes: b.lobbyNpcs.filter((s) => s.kind === 'mode').map((s) => s.id), boards: w.boards?.length, statues: w.statues?.length,
    pk: !!w.pk?.start && w.pk.cps.length === 2 && !!w.pk.finish, range: !!w.range, onGround: b.getB(Math.floor(b.player.x), Math.floor(b.player.y - 0.5), Math.floor(b.player.z)) > 0, hud: document.body.classList.contains('lobby') }; });
  ok(lobby.kind === 'lobby' && lobby.hud, 'boots into the lobby');
  ok(lobby.keepers >= 13, `the lobby has its keepers (${lobby.keepers})`);
  ok(lobby.modes.length === 5 && ['solo', 'duos', 'trios', 'squads'].every((m) => lobby.modes.includes(m)), 'a portal for every mode and the dream mode');
  ok(lobby.boards === 3 && lobby.statues === 3 && lobby.pk && lobby.range, 'boards, statues, parkour and the bridging range are there');
  ok(lobby.onGround, 'you spawn on solid ground');
  // the parkour: start, both checkpoints and the finish count, and the finish pays out once
  const pk = await page.evaluate(async () => {
    const b = window.__bw, P = b.world().pk, p = b.player, at = async (c) => { p.x = c[0] + 0.5; p.z = c[2] + 0.5; p.y = c[1] + 0.05; p.vx = p.vz = p.vy = 0; await new Promise((r) => setTimeout(r, 250)); };
    const c0 = b.profile.coins;
    await at(P.start); const started = b.pk.on;
    for (const c of P.cps) await at(c);
    await at(P.finish);
    return { started, done: !b.pk.on, best: b.profile.pk.best > 0, coins: b.profile.coins - c0 };
  });
  ok(pk.started && pk.done && pk.best && pk.coins >= 200, `the parkour times you and pays out the first time (+${pk.coins} coins)`);

  // --- every arena, in both layouts ----------------------------------------------------------------------------------
  const maps = await page.evaluate(() => {
    const b = window.__bw, out = [];
    for (const M of b.MAPS) for (const n of [4, 8]) {
      b.genMap(M, n);
      const w = b.world(), solid = (x, y, z) => b.BP[b.getB(Math.floor(x), Math.floor(y), Math.floor(z))]?.solid;
      const errs = [];
      if (w.bases.length !== n) errs.push('bases ' + w.bases.length);
      if (w.gens.filter((g) => g.kind === 'forge').length !== n) errs.push('forges');
      if (w.gens.filter((g) => g.kind === 'diamond').length !== 4) errs.push('diamonds');
      if (!w.gens.some((g) => g.kind === 'emerald')) errs.push('emeralds');
      for (const base of w.bases) {
        if (b.getB(base.foot[0], base.y, base.foot[1]) !== b.B.BED || b.getB(base.head[0], base.y, base.head[1]) !== b.B.BED) errs.push(`bed ${base.t}`);
        if (!solid(base.x, base.y - 1, base.z)) errs.push(`spawn ${base.t}`);
        for (const c of [base.foot, base.head]) if (solid(c[0], base.y + 1, c[1])) errs.push(`over bed ${base.t}`);
        for (const k of [base.shop, base.up]) if (!solid(k[0], base.y - 1, k[1]) || solid(k[0], base.y, k[1])) errs.push(`keeper ${base.t}`);
        const g = base.gen; if (solid(g[0], base.y, g[1]) || solid(g[0], base.y + 1, g[1])) errs.push(`forge blocked ${base.t}`);
        // the front, where bridges start, is open
        const fx = base.x - base.out[0] * (base.r - 0.8), fz = base.z - base.out[1] * (base.r - 0.8);
        if (solid(fx, base.y, fz) || solid(fx, base.y + 1, fz)) errs.push(`front blocked ${base.t}`);
      }
      for (const g of w.gens) if (!solid(g.x, g.y - 1, g.z) || solid(g.x, g.y, g.z) || solid(g.x, g.y + 1, g.z)) errs.push(`gen ${g.kind}`);
      // every base can reach every other in legs a bot can bridge
      const p0 = { team: 0, x: 0, z: 0 };
      for (let t = 1; t < n; t++) { const r = b.routeTo(p0, t); for (let i = 1; i < r.length; i++) if (Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]) > 40) errs.push(`leg ${t}`); }
      out.push(`${M.id}/${n}${errs.length ? ': ' + [...new Set(errs)].join(', ') : ''}`);
    }
    b.enterLobby();
    return out;
  });
  const bad = maps.filter((m) => m.includes(':'));
  ok(!bad.length, `all ${maps.length} arena layouts are playable${bad.length ? ' — ' + bad.join(' · ') : ''}`);

  // --- progression ------------------------------------------------------------------------------------------------
  const meta = await page.evaluate(() => {
    const b = window.__bw, P = b.profile, r = {};
    const c0 = P.coins; const L = b.claimLogin(); r.login = !!L && P.coins >= c0 + 50 && !b.loginState().ready && b.claimLogin() === null;
    P.coins += 10000; const c = b.COS.find((x) => x.how === 'coins' && x.type === 'hat'); r.buy = b.buyWithCoins(c) && b.owns('hat', c.id) && !b.buyWithCoins(c);
    P.boxes += 12; const before = P.owned.length; let epic = false; for (let i = 0; i < 10; i++) { const o = b.openBox(); if (o && ['epic', 'legendary'].includes(o.item.rar)) epic = true; } r.boxes = P.owned.length > before && epic;
    const d = b.dailies().list[0]; const q = b.countQuests({ [d.id]: 999 }); r.quest = q.length > 0 && b.dailies().list[0].done;
    const t0 = b.passTier(), lv = b.level();
    const pass = b.pass(); pass.xp += 2500; r.tier = b.passTier() > t0; r.claim = !!b.claimPass(1, false) && !b.claimPass(1, false) && !b.claimPass(1, true);
    b.creditOwned.add('bed-pass'); r.prem = !!b.claimPass(1, true); b.creditOwned.delete('bed-pass');
    P.stats.wins = 12; const a = b.checkAchievements(); r.ach = a.length >= 2;
    r.level = lv >= 1;
    return r;
  });
  ok(meta.login, 'the daily reward pays once a day');
  ok(meta.buy, 'a look bought with coins is yours (and only once)');
  ok(meta.boxes, 'Bed Boxes give new looks, with an epic within ten');
  ok(meta.quest, 'quests count and pay out');
  ok(meta.tier && meta.claim, 'the Bed Pass fills with XP and its free rewards claim once');
  ok(meta.prem, 'Bed Pass+ opens the premium track');
  ok(meta.ach, 'achievements pay out as tiers are reached');
  // the Bed Pass a year on: the same month's season, its title yours already, pays coins for it instead
  const again = await page.evaluate(() => {
    const b = window.__bw, year = () => Object.assign(b.pass(), { xp: 600 * 15, free: [], prem: [] });
    year(); const title = b.claimPass(15, false)?.look?.[1];
    year(); b.openPanel('pass');
    const shown = [...document.querySelectorAll('#panel .prew')].filter((c) => c.textContent.includes('yours already')).length;
    const c0 = b.profile.coins, o0 = b.profile.owned.length, r = b.claimPass(15, false);
    b.closePanel();
    return { title, r, coins: b.profile.coins - c0, owned: b.profile.owned.length - o0, shown };
  });
  ok(again.title === `title-s${new Date().getUTCMonth()}` && again.r?.c === 400 && again.coins === 400 && !again.owned && again.shown >= 1, `a season comes back with its month: a year on, its title (yours already) pays 400 coins instead, as a rare from a Bed Box would, and the pass shows it (${JSON.stringify(again)})`);
  // a career from before October 2026's economy (level 40 on the old curve, 3,000 coins, tier 3 of this month's pass)
  const oldXp = (L) => { let t = 0; for (let l = 1; l < L; l++) t += 100 + 25 * Math.min(l - 1, 20); return t; };
  const vet = await openPage(browser, 'veteran', undefined, { seed: ['bw:profile', { v: 2, xp: oldXp(40) + 5, coins: 3000, ach: { level: 3 }, pass: { s: new Date().toISOString().slice(0, 7), xp: 1250, free: [], prem: [] } }] });
  const mig = await vet.page.evaluate(() => { const b = window.__bw; return { level: b.level(), coins: b.profile.coins, tier: b.passTier(), econ: b.profile.econ }; });
  errors.push(...vet.errors); await vet.page.context().close();
  ok(mig.level === 40 && mig.coins === 10000 && mig.tier === 3 && mig.econ === 1, `a career from before the new economy keeps its level (40), what its coins could buy (3,000 → 10,000) and its Bed Pass tier (${JSON.stringify(mig)})`);
  // a daily quest that finishes the weekly "finish 10 daily quests": each pays once
  const weekly = await page.evaluate(() => {
    const b = window.__bw, d = b.dailies(), w = b.weeklies();
    d.list = [{ id: 'kills', n: 0, done: false }]; w.list = [{ id: 'daily', n: 9, done: false }];
    const c0 = b.profile.coins, lv0 = b.level(), done = b.countQuests({ kills: 99 }), lv1 = b.level();
    let lc = 0; for (let l = lv0 + 1; l <= lv1; l++) if (l % 5 === 0) lc += 100 * Math.min(10, l / 5);   // (coins a level brings)
    return { done: done.map((q) => `${q.kind}:${q.id}`).join(), coins: b.profile.coins - c0 - lc };
  });
  ok(weekly.done === 'daily:kills,weekly:daily' && weekly.coins === 340, `a daily quest that finishes the weekly "finish 10 daily quests" pays each once, 40 + 300 coins (${JSON.stringify(weekly)})`);
  // leaving a match: in its first minute and still in, nothing; once you're out, or later on, a loss on your record
  const leaving = await page.evaluate(async () => {
    const b = window.__bw, wait = (ms) => new Promise((r) => setTimeout(r, ms)), until = async (f) => { for (let i = 0; i < 120 && !f(); i++) await wait(150); }, out = {};
    for (const [label, setup] of [['early', () => {}], ['out', () => { b.player.dead = b.player.out = true; }], ['later', () => { b.match.t = 75; }]]) {
      b.mp = 0; b.playMode('solo'); await until(() => b.match.phase === 'lobby'); b.match.cd = 0.05; await until(() => b.match.phase === 'play' && b.player?.team >= 0);
      const g0 = b.profile.stats.games; setup(); b.leaveToLobby(); await until(() => b.game.mode === 'lobby');
      out[label] = b.profile.stats.games - g0;
    }
    return out;
  });
  ok(leaving.early === 0 && leaving.out === 1 && leaving.later === 1, `leaving a match in its first minute pays nothing; leaving once you're out, or later, is a loss on your record (${JSON.stringify(leaving)})`);
  // credits: Orb's sheet (faked) says yes, and the look is worn
  const credits = await (async () => {
    const { page: p2, errors: e2 } = await openPage(browser, 'buyer');
    const r = await p2.evaluate(async () => { const b = window.__bw; b.openPanel('wardrobe'); document.querySelector('[data-ptab="hat"]').click(); document.querySelector('[data-v="hat-crown"]').click(); document.querySelector('[data-act="credits"]').click(); await new Promise((res) => setTimeout(res, 300)); return { owns: b.owns('hat', 'hat-crown'), worn: b.worn('hat') }; });
    errors.push(...e2); await p2.context().close(); return r;
  })();
  ok(credits.owns && credits.worn === 'hat-crown', 'a look bought with Orb credits is worn right away');

  // --- a match: the shop, items, then every mode ------------------------------------------------------------------
  await play(page, 'solo', 0); await startNow(page);
  await page.waitForFunction(() => window.__bw.match.phase === 'play', null, { timeout: 15000 });
  // the controls: Menu → Controls takes a new key for walking forward (the key it had goes to the other action), and it walks
  // where you respawn, facing the way you do
  const standAtHome = () => page.evaluate(() => { const b = window.__bw, p = b.player, base = b.world().bases[p.team]; Object.assign(p, { x: base.x, z: base.z, y: base.y + 0.05, ry: base.y + 0.05, vx: 0, vy: 0, vz: 0, dead: false, prot: 99 }); b.cam.yaw = base.yaw; });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__bw.game.state === 'pause');
  await page.click('#pKeys'); await page.click('#bindList button[data-a="fwd"]'); await page.keyboard.press('KeyI');
  await page.click('#bindList button[data-a="back"]'); await page.keyboard.press('KeyI');   // I again, for back: a swap
  const rebound = await page.evaluate(() => ({ ...window.__bw.binds, list: document.getElementById('bindList').innerText, help: document.getElementById('keysHelp2').innerText }));
  ok(rebound.back === 'KeyI' && rebound.fwd === 'KeyS' && /Forward\s*S/.test(rebound.list), `Controls: keys can be changed, and taking one that's in use swaps them (forward ${rebound.fwd}, back ${rebound.back})`);
  await page.click('#bindList button[data-a="fwd"]'); await page.keyboard.press('KeyO');
  await page.click('#bindList button[data-a="sprint"]'); await page.keyboard.press('KeyQ');
  await page.click('#pSprint');
  await page.click('#resume');
  await standAtHome();
  const walk = async (ms, sprintTap = false) => {
    if (sprintTap) await page.keyboard.press('KeyQ');
    const at = await page.evaluate(() => [window.__bw.player.x, window.__bw.player.z]);
    await page.keyboard.down('KeyO'); await page.waitForTimeout(ms);
    const r = await page.evaluate((at) => { const p = window.__bw.player; return { d: Math.hypot(p.x - at[0], p.z - at[1]), v: Math.hypot(p.vx, p.vz) }; }, at);
    await page.keyboard.up('KeyO'); return r;
  };
  const w1 = await walk(400);
  ok(w1.d > 0.8 && w1.v < 5.4, `the new forward key walks (${w1.d.toFixed(1)} blocks at ${w1.v.toFixed(1)}/s)`);
  await standAtHome();
  const w2 = await walk(400, true);
  await standAtHome();
  const w3 = await walk(400);
  await standAtHome();
  const w4 = await walk(400, true);
  ok(w2.v > 5.4 && w3.v > 5.4 && w4.v < 5.4, `Sprint: toggle — the sprint key turns sprinting on (${w2.v.toFixed(1)}/s), it stays on (${w3.v.toFixed(1)}/s), and off again (${w4.v.toFixed(1)}/s)`);
  const reset = await page.evaluate(() => { const b = window.__bw; Object.assign(b.binds, b.BINDS0); b.sprintMode.toggle = false; b.sprintMode.on = false; localStorage.removeItem('bw:binds'); localStorage.removeItem('bw:sprintToggle'); return b.binds.fwd; });
  ok(reset === 'KeyW' && rebound.help.includes('SAID'), `the key help in the menu says the keys as you have them (${rebound.help.slice(0, 40)}…)`);

  // your hand in first person: what you hold, and it changes with the hotbar
  const hand = await page.evaluate(async () => {
    const b = window.__bw, p = b.player, frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    b.cam.first = true; p.inv.wool = 32; p.sword = 1;
    const items = b.hotbarItems(), sw = items.findIndex((i) => i.kind === 'sword'), bl = items.findIndex((i) => i.kind === 'block');
    b.setSel(sw); await frame(); const a = { on: b.vm.on, key: b.vm.key, item: !!b.vm.item, arm: !!b.vm.arm };
    b.setSel(bl); await frame(); const c = { key: b.vm.key, item: !!b.vm.item };
    b.cam.first = false; await frame();
    p.inv.wool = 0; p.sword = 0; b.setSel(0);
    return { a, c, off: !b.vm.on };
  });
  ok(hand.a.on && hand.a.arm && hand.a.item && hand.a.key[0] === 's' && hand.c.item && hand.c.key[0] === 'b' && hand.off, `in first person your hand shows what it holds (${hand.a.key}, then ${hand.c.key}); behind you, your character holds it`);

  // your forge keeps your share while you're away, and pays it out when you're back
  const stash = await page.evaluate(() => {
    const b = window.__bw, p = b.player, w = b.world(), f = w.gens.find((g) => g.kind === 'forge' && g.t === p.team);
    p.res.iron = 0; p.res.gold = 0; p.stash = {};
    Object.assign(p, { x: f.x + 12, z: f.z, y: f.y });
    for (let i = 0; i < 300; i++) b.generators(p, 0.5);
    const kept = { ...p.stash }, carried = p.res.iron;
    Object.assign(p, { x: f.x, z: f.z, y: f.y });
    b.generators(p, 0.01);
    return { kept, carried, got: p.res.iron, gold: p.res.gold, left: p.stash.iron };
  });
  ok(stash.kept.iron === 48 && stash.kept.gold === 12 && stash.carried === 0 && stash.got === 48 && stash.gold === 12 && stash.left === 0, `the forge keeps your iron and gold while you're away (${stash.kept.iron} and ${stash.kept.gold}, at most) and pays it out when you're back`);

  // bots turn on whoever hit them from farther off than they'd chase (from Normal up)
  const hitBack = await page.evaluate(() => {
    const b = window.__bw, p = b.player, bot = [...b.net.bots.values()].find((e) => e.kind === 'p' && !e.dead && e.team !== p.team);
    b.match.botLevel = 1;
    Object.assign(bot, { x: p.x + 13, z: p.z, y: p.y, prot: 0 }); bot.ai.foe = null;
    b.hurt(bot, 0.5, p, {}); b.botThink(bot);
    const r = bot.ai.foe === p; bot.prot = 0;
    return { r, chase: b.BL().chase };
  });
  ok(hitBack.r, `a bot hit from 13 blocks off comes after you (it chases ${hitBack.chase} on its own)`);

  // the islands falling come as an earthquake: the ground shakes, and every few seconds a jolt
  const quake = await page.evaluate(async () => {
    const b = window.__bw, p = b.player, at = b.eventAt('fall');
    p.dead = false; p.spectating = false; b.match.cols = []; b.match.sd = true; b.match.t = at + 0.5; b.match.jolt = -1;   // nothing crumbles, no beds go: the shaking only
    await new Promise((r) => setTimeout(r, 120));
    const calm = b.match.jolt, shaking = b.game.shake > 0.02;
    b.match.t = at + 7.2; await new Promise((r) => setTimeout(r, 120));
    return { calm, jolt: b.match.jolt, shaking, shake: b.game.shake };
  });
  ok(quake.calm === 0 && quake.jolt === 1 && quake.shaking && quake.shake > 0.3, `the islands falling shake the ground, with a jolt every 7 s (${JSON.stringify(quake)})`);

  // others move smoothly however unevenly their updates arrive: each is timed by when it was sent
  const smooth = await page.evaluate(() => {
    const b = window.__bw, e = {}, real = performance.now;
    let fake = 1000000;
    performance.now = () => fake;
    try {
      for (let i = 0; i < 8; i++) { fake = 1000000 + i * 200 + [40, 160, 10, 120, 70, 150, 20, 90][i]; b.pushSample(e, [i, 60, 0, 0, 0, 5, 0], 5000 + i * 200); }
    } finally { performance.now = real; }
    const gaps = e.nb.slice(1).map((s, i) => s.t - e.nb[i].t);
    return { n: e.nb.length, min: Math.min(...gaps), max: Math.max(...gaps) };
  });
  ok(smooth.n === 8 && Math.abs(smooth.min - 0.2) < 0.02 && Math.abs(smooth.max - 0.2) < 0.02, `positions are timed by when they were sent, not by when they came (gaps ${smooth.min.toFixed(3)}–${smooth.max.toFixed(3)} s, sent every 0.2 s)`);
  await page.evaluate(() => { const m = window.__bw.match; Object.assign(m, { t: 30, jolt: -1, cols: null, fall: 0, sd: false }); m.said = new Set(); window.__bw.game.shake = 0; });
  const shop = await page.evaluate(async () => {
    const b = window.__bw, p = b.player, r = {};
    r.bots = b.net.bots.size; r.teams = b.world().n;
    Object.assign(p.res, { iron: 999, gold: 999, diamond: 99, emerald: 99 });
    for (const id of ['wool', 'sword1', 'armor1', 'pick', 'shears', 'bow1', 'fireball', 'tnt', 'popup', 'golem', 'bug', 'milk', 'tracker', 'ladder', 'egg', 'pearl']) r[id] = b.buy(p, b.SHOP.find((s) => s.id === id));
    r.up = b.buyUpgrade(p, 'forge') && b.buyUpgrade(p, 'sharp') && b.teamUp(p.team).forge === 1;
    p.x = b.world().bases[p.team].x; p.z = b.world().bases[p.team].z; p.y = b.world().Y; p.onGround = true;
    b.useItem(p, 'popup', null);
    let ladders = 0; for (let y = 0; y < 7; y++) if (b.getB(Math.floor(p.x), Math.floor(p.y) + y, Math.floor(p.z)) === b.B.LADDER) ladders++;
    r.popup = ladders >= 5;
    b.useItem(p, 'golem', { x: 1, z: 0 }); r.golem = [...b.net.bots.values()].some((e) => e.kind === 'golem');
    b.useItem(p, 'milk'); b.useItem(p, 'tracker'); r.fx = p.fx.milk > 0 && p.fx.track > 0;
    return r;
  });
  ok(shop.teams === 8 && shop.bots === 7, `Solo: 8 teams, a bot in each seat you don't take (${shop.bots} bots)`);
  ok(['wool', 'sword1', 'armor1', 'pick', 'shears', 'bow1', 'fireball', 'tnt', 'popup', 'golem', 'bug', 'milk', 'tracker', 'ladder', 'egg', 'pearl'].every((k) => shop[k]), 'everything in the shop can be bought');
  ok(shop.up, 'team upgrades apply');
  ok(shop.popup && shop.golem && shop.fx, 'pop-up towers, Dream Defenders, magic milk and the tracker work');

  for (const [mode, mp] of [['duos', 1], ['trios', 2], ['squads', 3], ['rush', 4], ['lowgrav', 5], ['voidless', 6], ['lucky', 7]]) {
    await play(page, mode, mp); await startNow(page);
    await page.waitForFunction((m) => window.__bw.match.phase === 'play' && window.__bw.match.mode === m, mode, { timeout: 15000 });
    await fast(page, 25); await page.waitForTimeout(quick ? 2500 : 5000); await fast(page, 1);
    const r = await page.evaluate(() => {
      const b = window.__bw, M = b.MODES[b.match.mode], w = b.world(), p = b.player;
      // Lucky Blocks: the diamond islands hand them out, and opening one changes something about you
      const dia = w.gens.find((g) => g.kind === 'diamond'), lucky = b.genRates(dia, p.team).some(([k]) => k === 'lucky');
      const look = () => JSON.stringify([p.inv, p.res, p.sword, p.armor, p.bow, p.fx, p.hp, p.absorb, p.vy]), before = look();
      if (lucky) for (let i = 0; i < 6; i++) b.luckyOpen(p, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return { n: w.n, seats: M.teams * M.size, ents: b.ents.filter((e) => e.kind === 'p' && e.team >= 0).length, t: b.match.t, grav: b.phys.grav,
        floor: b.getB(5, w.Y - 12, 5) === b.B.CLOUD, lucky: lucky && look() !== before, fx: b.match.up[0]?.forge };
    });
    const twist = { lowgrav: r.grav < 1, voidless: r.floor, rush: r.fx >= 2, lucky: r.lucky }[mode] ?? true;
    const what = { lowgrav: ', low gravity', voidless: ', a cloud floor', rush: ', forges start upgraded', lucky: ', lucky blocks from the diamond islands' }[mode] ?? '';
    ok(r.ents === r.seats && r.t > 30 && twist, `${mode}: ${r.n} teams, every seat filled (${r.ents}/${r.seats}), plays${what}`);
  }
  if (!quick) {
    // one match to the very end, then the rewards
    await play(page, 'solo', 8); await startNow(page);
    await page.waitForFunction(() => window.__bw.match.phase === 'play' && window.__bw.match.mode === 'solo', null, { timeout: 15000 });
    const xp0 = await page.evaluate(() => window.__bw.profile.xp);
    await fast(page, 40);
    await page.waitForFunction(() => window.__bw.match.phase === 'end', null, { timeout: 240000, polling: 1000 });
    await fast(page, 1);
    const end = await page.evaluate((xp0) => { const b = window.__bw; return { winner: b.match.winner, t: Math.round(b.match.t), xp: b.profile.xp - xp0, games: b.profile.stats.games }; }, xp0);
    ok(end.winner >= 0 && end.xp > 0, `a match plays to the end (team ${end.winner} won at ${end.t} s) and pays XP (+${end.xp})`);
  }
  await page.evaluate(() => window.__bw.leaveToLobby());
  ok(await page.evaluate(() => window.__bw.game.mode === 'lobby' && window.__bw.world().kind === 'lobby'), 'back to the lobby after a match');
  ok(!errors.length, `no errors on the page${errors.length ? ':\n' + errors.slice(0, 6).join('\n') : ''}`);
  await page.context().close();

  // --- two players in one room --------------------------------------------------------------------------------------
  const A = await openPage(browser, 'alice'), Bp = await openPage(browser, 'bob');
  // first the lobby: each sees the other walking around, and their emotes
  await A.page.waitForTimeout(1500);
  const inLobby = await Promise.all([A.page, Bp.page].map((p) => p.evaluate(() => ({ kind: window.__bw.net.kind, names: [...window.__bw.net.humans.values()].map((e) => e.name) }))));
  ok(inLobby.every((l) => l.kind === 'lobby') && inLobby[0].names.includes('bob') && inLobby[1].names.includes('alice'), `two players in the lobby see each other (${inLobby.map((l) => l.names.join('+')).join(' / ')})`);
  await A.page.evaluate(() => window.__bw.doEmote('wave'));
  const waved = await Bp.page.waitForFunction(() => [...window.__bw.net.humans.values()].some((e) => e.name === 'alice' && e.emote?.id === 'wave'), null, { timeout: 5000 }).then(() => true, () => false);
  ok(waved, 'an emote in the lobby shows for the other player');
  await A.page.evaluate(() => window.__bw.enterBw('bw-testroom', true, 'duos'));
  await A.page.waitForFunction(() => window.__bw.match.phase === 'lobby' && window.__bw.net.host, null, { timeout: 15000 });
  await Bp.page.evaluate(() => window.__bw.enterBw('bw-testroom', true, 'duos'));
  await Bp.page.waitForFunction(() => window.__bw.match.phase === 'lobby', null, { timeout: 15000 });
  await A.page.waitForTimeout(1500);
  const wait = await Promise.all([A.page, Bp.page].map((p) => p.evaluate(() => ({ host: window.__bw.net.host, peers: window.__bw.net.peers.size, others: window.__bw.net.humans.size, map: window.__bw.match.mp, mode: window.__bw.match.mode }))));
  ok(wait[0].host && !wait[1].host && wait[0].peers === 1 && wait[1].peers === 1, 'two players: one hosts, both see each other');
  ok(wait[0].map === wait[1].map && wait[1].mode === 'duos', 'the guest follows the host into the same waiting room');
  ok(wait[0].others === 1 && wait[1].others === 1, 'each sees the other in the waiting room');
  // friends end up together; the host starts
  await A.page.evaluate(() => { window.__bw.match.startReq = true; });
  await Promise.all([A.page, Bp.page].map((p) => p.waitForFunction(() => window.__bw.match.phase === 'play', null, { timeout: 15000 })));
  await A.page.waitForTimeout(1500);
  const m = await Promise.all([A.page, Bp.page].map((p) => p.evaluate(() => ({ team: window.__bw.player.team, bots: window.__bw.net.bots.size, n: window.__bw.world().n, ep: window.__bw.match.ep }))));
  ok(m[0].team === m[1].team && m[0].team >= 0, `friends are on the same team (${m[0].team})`);
  ok(m[0].bots === 14 && m[1].bots === 14 && m[0].ep === m[1].ep, `both run the same match, with 14 bots in Doubles (${m[0].bots}, ${m[1].bots}; ${m[0].ep === m[1].ep ? 'same' : 'different'} match)`);
  // a block placed by the guest shows up for the host
  const placedAt = await Bp.page.evaluate(() => { const b = window.__bw, p = b.player, base = b.world().bases[p.team]; p.inv.wool = 4; const x = Math.floor(base.x) + 1, z = Math.floor(base.z) + 1, y = base.y + 1; return b.placeBlock(p, x, y, z, b.B.W_RED) ? [x, y, z] : null; });
  await A.page.waitForTimeout(1500);
  ok(placedAt && (await A.page.evaluate((c) => window.__bw.getB(c[0], c[1], c[2]), placedAt)) === (await A.page.evaluate(() => window.__bw.B.W_RED)), 'a block the guest places appears for the host');
  // the host leaves: the guest takes over the match
  await A.page.context().close();
  await Bp.page.waitForFunction(() => window.__bw.net.host, null, { timeout: 20000 });
  ok(await Bp.page.evaluate(() => window.__bw.net.host && window.__bw.match.phase === 'play' && window.__bw.net.bots.size > 0), 'when the host leaves, the guest hosts the match on, bots and all');
  const netErrors = [...A.errors, ...Bp.errors];
  ok(!netErrors.length, `no errors with two players${netErrors.length ? ':\n' + netErrors.slice(0, 6).join('\n') : ''}`);
  await Bp.page.context().close();
  }

  // --- on a phone, by touch alone -------------------------------------------------------------------------------------
  const Ph = await openPage(browser, 'phone', device(390, 844), { daily: true }), P = Ph.page, f = await fingers(P);
  const me = () => P.evaluate(() => { const b = window.__bw, p = b.player; return { x: p.x, y: p.y, z: p.z, yaw: b.cam.yaw, pitch: b.cam.pitch, coins: b.profile.coins, scene: document.body.className }; });
  const popped = await P.waitForFunction(() => !document.getElementById('daily').classList.contains('hidden'), null, { timeout: 8000 }).then(() => true, () => false);
  await P.waitForTimeout(400);
  const arrive = await P.evaluate((popped) => ({ touch: document.body.classList.contains('touch'), daily: popped }), popped);
  ok(arrive.touch && arrive.daily, 'a phone gets the touch controls, and the daily reward on arrival');
  const c0 = (await me()).coins;
  await f.tap('#dClaim');
  const claimed = await P.evaluate(() => /\b(out|hidden)\b/.test(document.getElementById('daily').className));
  ok(claimed && (await me()).coins > c0, `a tap on Claim takes the daily reward (+${(await me()).coins - c0} coins)`);
  await P.waitForTimeout(500);
  let bad = await auditControls(P, LOBBY_CONTROLS);
  ok(!bad.length, `the lobby's buttons fit a phone, and each takes a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  // JUMP jumps, the left thumb walks, the right one looks around
  await P.evaluate(() => { const p = window.__bw.player; window.__y0 = window.__top = p.y; window.__jumpT = setInterval(() => { window.__top = Math.max(window.__top, p.y); }, 16); });
  await f.tap('#tJump'); await P.waitForTimeout(300);
  const rose = await P.evaluate(() => { clearInterval(window.__jumpT); return window.__top - window.__y0; });
  ok(rose > 0.8, `JUMP jumps (${rose.toFixed(2)} blocks up)`);
  const s0 = await me();
  ok(await canvasAt(P, 90, 690) && await canvasAt(P, 290, 470), 'the thumbs\' places are free (nothing over the game there)');
  await f.drag([90, 690], [90, 610], 200, 900);
  const s1 = await me();
  ok(Math.hypot(s1.x - s0.x, s1.z - s0.z) > 1.5, `the left thumb walks (${Math.hypot(s1.x - s0.x, s1.z - s0.z).toFixed(1)} blocks)`);
  await f.drag([290, 470], [190, 520], 250);
  const s2 = await me();
  ok(Math.abs(s2.yaw - s1.yaw) > 0.3 && Math.abs(s2.pitch - s1.pitch) > 0.1, 'the right thumb looks around');
  // a keeper: tap them where they stand, or walk up and press TALK
  await P.evaluate(() => {
    const b = window.__bw, n = b.lobbyNpcs.find((k) => k.kind === 'wardrobe').npc, p = b.player;
    p.x = n.x + Math.sin(n.yaw) * 3; p.z = n.z + Math.cos(n.yaw) * 3; p.y = n.y + 0.05; p.vx = p.vy = p.vz = 0;
    b.cam.yaw = Math.atan2(p.x - n.x, p.z - n.z); b.cam.pitch = -0.15;
  });
  await P.waitForTimeout(900);
  const kxy = await P.evaluate(() => { const b = window.__bw, n = b.lobbyNpcs.find((k) => k.kind === 'wardrobe').npc, v = b.camera.position.clone().set(n.x, n.y + 1.1, n.z).project(b.camera); return [(v.x * 0.5 + 0.5) * innerWidth, (0.5 - v.y * 0.5) * innerHeight]; });
  await f.tap(kxy);
  ok(await P.evaluate(() => document.getElementById('panel').classList.contains('on') && document.getElementById('panelTitle').textContent === 'Wardrobe'), 'a tap on a keeper talks to them (the wardrobe opens)');
  await f.tap('#panelClose');
  ok(await P.evaluate(() => !document.getElementById('panel').classList.contains('on') && !document.getElementById('tUse').classList.contains('hidden')), 'its × closes it, and TALK shows next to a keeper');
  await f.tap('#tUse');
  ok(await P.evaluate(() => document.getElementById('panel').classList.contains('on')), 'TALK talks to the keeper');
  await f.tap('#panelClose');
  // Play → Solo → the waiting room → a team → Start now
  await f.tap('#bPlay');
  ok(await P.evaluate(() => document.getElementById('playMenu').classList.contains('on')), 'PLAY opens the play menu');
  await f.tap('#pmModes [data-mode="solo"]');
  // while the room works out whose match it is, the waiting room's panel stays out of sight
  ok(await P.evaluate(() => document.body.classList.contains('wait') && (window.__bw.match.phase !== 'none' || getComputedStyle(document.getElementById('wait')).visibility === 'hidden')), 'finding a match: no half-made waiting room on screen');
  await P.waitForFunction(() => document.body.classList.contains('wait') && window.__bw.match.phase === 'lobby', null, { timeout: 15000 });
  await P.waitForTimeout(500);
  bad = await auditControls(P, WAIT_CONTROLS);
  ok(!bad.length, `the waiting room fits a phone, and each of its buttons takes a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  await f.tap('#wTeams [data-t="3"]'); await P.waitForTimeout(400);
  ok(await P.evaluate(() => window.__bw.dealSeats().seats[window.__bw.net.me] === 3), 'a tap on a team picks it');
  await f.tap('#wStart');
  await P.waitForFunction(() => document.body.classList.contains('bw') && window.__bw.match.phase === 'play', null, { timeout: 15000 });
  await P.waitForTimeout(800);
  ok(await P.evaluate(() => window.__bw.player.team === 3), 'Start now starts the match, on the team picked');
  bad = await auditControls(P, MATCH_CONTROLS);
  ok(!bad.length, `a match's controls fit a phone held upright, and each takes a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  // the hotbar, placing and breaking blocks
  await P.evaluate(() => { window.__bw.player.inv.wool = 32; window.__bw.player.prot = 999; });
  await P.waitForTimeout(400);
  const woolSlot = await P.evaluate(() => window.__bw.hotbarItems().findIndex((it) => it.inv === 'wool'));
  await f.tap(`#hotbar .slot[data-i="${woolSlot}"]`);
  ok(woolSlot >= 0 && await P.evaluate((i) => window.__bw.hot.sel === i, woolSlot), 'a tap on the hotbar picks the wool');
  await f.drag([290, 400], [290, 520], 250);
  await P.waitForTimeout(300);
  const cell = await P.evaluate(() => { const a = window.__bw.aim.block; return a ? [a.x + a.nx, a.y + a.ny, a.z + a.nz] : null; });
  const placed0 = await P.evaluate(() => window.__bw.player.stats.placed);
  await f.tap('#tPlace');
  const placedOk = await P.evaluate(([c, n0]) => { const b = window.__bw; return b.player.stats.placed === n0 + 1 && b.getB(c[0], c[1], c[2]) === b.TEAMS[3].wool; }, [cell, placed0]);
  ok(!!cell && placedOk, 'aimed at the ground, a tap on the block button puts a wool block there');
  await f.down('#tBreak'); await P.waitForTimeout(1600); await f.up();
  ok(await P.evaluate((c) => window.__bw.getB(c[0], c[1], c[2]) === 0, cell), 'holding the pickaxe button breaks it again');
  // the shop, quick chat, sneaking, pause
  await P.evaluate(() => Object.assign(window.__bw.player.res, { iron: 64, gold: 16 }));
  await f.tap('#shopBtn');
  ok(await P.evaluate(() => document.getElementById('shop').classList.contains('on')), 'Shop opens the shop');
  const wool0 = await P.evaluate(() => window.__bw.player.inv.wool);
  await f.tap('#shopGrid .item');
  ok(await P.evaluate((w) => window.__bw.player.inv.wool > w, wool0), 'a tap on Wool buys it');
  await f.tap('#shopClose');
  await f.tap('#chatBtn');
  ok(await P.evaluate(() => !document.getElementById('emoteMenu').classList.contains('hidden')), 'the chat button opens quick chat');
  await f.tap('#emoteMenu button');
  ok(await P.evaluate(() => document.getElementById('emoteMenu').classList.contains('hidden') && document.getElementById('bubbles').children.length > 0), 'a tap on a line says it (a bubble over your head)');
  await f.tap('#tSneak');
  const sneaking = await P.evaluate(() => window.__bw.input.crouch && document.getElementById('tSneak').classList.contains('on'));
  await f.tap('#tSneak');
  ok(sneaking && !(await P.evaluate(() => window.__bw.input.crouch)), 'SNEAK toggles sneaking (a tap on, a tap off)');
  await f.tap('#pauseBtn');
  const paused = await P.evaluate(() => window.__bw.game.state === 'pause' && !document.getElementById('pause').classList.contains('hidden'));
  await f.tap('#resume');
  ok(paused && await P.evaluate(() => window.__bw.game.state === 'play'), 'pause and resume');
  // turned sideways and back
  await P.setViewportSize({ width: 844, height: 390 }); await P.waitForTimeout(700);
  bad = await auditControls(P, MATCH_CONTROLS);
  const sized = await P.evaluate(() => { const c = document.querySelector('canvas'); return Math.abs(c.clientWidth - innerWidth) < 2 && Math.abs(c.clientHeight - innerHeight) < 2; });
  ok(!bad.length && sized, `turned sideways, the game fills the screen and every control still takes a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  await P.setViewportSize({ width: 390, height: 844 }); await P.waitForTimeout(700);
  bad = await auditControls(P, MATCH_CONTROLS);
  ok(!bad.length, `and upright again${bad.length ? ' — ' + bad.join(', ') : ''}`);
  // the end, and back to the lobby
  await P.evaluate(() => { const b = window.__bw; b.endMatch(b.player.team); });
  await P.waitForFunction(() => !document.getElementById('end').classList.contains('hidden'), null, { timeout: 20000 });
  bad = await auditControls(P, [['#again', '#toMenu']]);
  ok(!bad.length, `the end screen's buttons take a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  await f.tap('#toMenu');
  await P.waitForFunction(() => window.__bw.game.mode === 'lobby', null, { timeout: 15000 });
  ok(true, 'Lobby takes you back to the lobby');
  ok(!Ph.errors.length, `no errors on the phone${Ph.errors.length ? ':\n' + Ph.errors.slice(0, 6).join('\n') : ''}`);
  await P.context().close();

  // --- every screen size: the lobby, the waiting room and a match ------------------------------------------------------
  const sizes = [['iPhone SE', device(375, 667)], ['small Android', device(360, 740, ANDROID)], ['Pixel 7', device(412, 915, ANDROID)], ['iPhone SE sideways', device(667, 375)],
    ['iPhone 14 sideways', device(844, 390)], ['Pixel 7 sideways', device(915, 412, ANDROID)], ['iPad', device(820, 1180)], ['iPad sideways', device(1180, 820)]];
  for (const [name, d] of sizes) {
    const { page: S, errors: se } = await openPage(browser, 'size', d);
    const problems = [...(await auditControls(S, LOBBY_CONTROLS)).map((x) => 'lobby: ' + x)];
    await play(S, 'duos', 4);
    await S.waitForFunction(() => document.body.classList.contains('wait') && window.__bw.match.phase === 'lobby', null, { timeout: 15000 }); await S.waitForTimeout(500);
    problems.push(...(await auditControls(S, WAIT_CONTROLS)).map((x) => 'waiting: ' + x));
    await startNow(S);
    await S.waitForFunction(() => window.__bw.match.phase === 'play', null, { timeout: 15000 });
    await S.evaluate(() => { window.__bw.player.inv.wool = 16; window.__bw.player.inv.tnt = 2; window.__bw.player.inv.pearl = 1; window.__bw.player.bow = 1; });
    await S.waitForTimeout(800);
    problems.push(...(await auditControls(S, MATCH_CONTROLS)).map((x) => 'match: ' + x));
    ok(!problems.length && !se.length, `${name} (${d.viewport.width}×${d.viewport.height}): everything fits and takes a tap${problems.length ? ' — ' + problems.join(', ') : ''}${se.length ? '\n' + se.slice(0, 3).join('\n') : ''}`);
    await S.context().close();
  }

  // --- Safari's engine (WebKit), if it's installed here ----------------------------------------------------------------
  const wk = await webkit.launch().catch(() => null);
  if (!wk) console.log('– WebKit isn’t installed here (npx playwright install webkit): skipped Safari’s engine');
  else {
    const W = await (await wk.newContext({ ...devices['iPhone 14'] })).newPage();
    await routeCdn(W);
    const we = [];
    W.on('pageerror', (e) => we.push(e.message));
    await W.goto(URL);
    await W.waitForFunction(() => window.__bw?.game.mode === 'lobby' && document.getElementById('loading').classList.contains('out'), null, { timeout: 120000 });
    await W.tap('#dLater'); await W.tap('#bPlay'); await W.tap('#pmModes [data-mode="solo"]');
    await W.waitForFunction(() => document.body.classList.contains('wait') && window.__bw.match.phase === 'lobby', null, { timeout: 30000 });
    await W.tap('#wStart');
    await W.waitForFunction(() => window.__bw.match.phase === 'play', null, { timeout: 30000 });
    await W.waitForTimeout(1500);
    const wbad = await auditControls(W, MATCH_CONTROLS);
    ok(!wbad.length && !we.length, `in WebKit on an iPhone: from the lobby to a match by taps, and every control fits${wbad.length ? ' — ' + wbad.join(', ') : ''}${we.length ? '\n' + we.slice(0, 3).join('\n') : ''}`);
    await wk.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
