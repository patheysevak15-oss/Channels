/* SevakTV player controls: skip ±10s, seek bar, speed, audio, quality,
   subtitles (built-in, files, OpenSubtitles), live rewind, PiP, fullscreen,
   double-tap gestures and an up-next countdown. Uses globals from app.js. */
'use strict';

const PUI = (() => {
  const $id = (id) => document.getElementById(id);
  const pEl = $id('player');
  const pc = $id('pc');
  const subsBox = $id('pc-subs');
  const menu = $id('pc-menu');
  const SKIP = 10;
  const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const canSetVolume = (() => { try { const v = document.createElement('video'); v.volume = 0.5; return v.volume === 0.5; } catch { return false; } })();
  const pipSupported = !!(document.pictureInPictureEnabled || (video.webkitSupportsPresentationMode && video.webkitSupportsPresentationMode('picture-in-picture')));

  const ui = {
    mode: 'idle', meta: {}, hls: null,
    selected: null, userPicked: false, offset: 0, dead: new WeakSet(),
    menuPage: null, hideTimer: 0, dragging: false, nativeFs: false,
    nextTimer: 0, raf: 0, lastSubHTML: '', search: null, osConfig: null,
  };

  function prefs() {
    state.store.settings.player ||= { volume: 1, muted: false, speed: 1, subSize: 'm', subLang: null };
    return state.store.settings.player;
  }

  /* ------------------------------------------------------------ helpers */
  const fmt = (s) => (Number.isFinite(s) ? fmtDur(s) : '0:00');
  function seekWindow() {
    const r = video.seekable;
    if (!r || !r.length) return null;
    const start = r.start(0), end = r.end(r.length - 1);
    return Number.isFinite(end) && end - start > 0 ? { start, end } : null;
  }
  const liveRewindable = () => { const w = seekWindow(); return !!(w && w.end - w.start > 30); };
  const canSeek = () => ui.mode === 'vod' ? Number.isFinite(video.duration) && video.duration > 0 : liveRewindable();

  function setClass() {
    pc.classList.toggle('is-idle', ui.mode === 'idle');
    pc.classList.toggle('is-live', ui.mode === 'live');
    pc.classList.toggle('is-playing', !video.paused && !video.ended);
    pc.classList.toggle('is-muted', video.muted || video.volume === 0);
    pc.classList.toggle('no-seek', !canSeek());
    pc.classList.toggle('no-volume', !canSetVolume);
    pc.classList.toggle('is-fs', !!(document.fullscreenElement || document.webkitFullscreenElement));
    $id('pc-pip').hidden = !pipSupported;
  }

  /* ----------------------------------------------------- show / hide bar */
  function show(stay) {
    pc.classList.add('show');
    clearTimeout(ui.hideTimer);
    if (!stay) ui.hideTimer = setTimeout(maybeHide, 3200);
  }
  function maybeHide() {
    if (video.paused || ui.menuPage || ui.dragging || ui.mode === 'idle') return;
    pc.classList.remove('show');
  }
  pEl.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') show(); });
  pEl.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { clearTimeout(ui.hideTimer); ui.hideTimer = setTimeout(maybeHide, 800); } });
  pc.querySelector('.pc-bottom').addEventListener('pointerdown', () => show());

  /* ------------------------------------------------------------ actions */
  function togglePlay() {
    if (ui.mode === 'idle') return;
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
    show();
  }
  function flash(side) {
    const r = $id(side < 0 ? 'rip-l' : 'rip-r');
    r.classList.add('flash');
    clearTimeout(r._t);
    r._t = setTimeout(() => r.classList.remove('flash'), 350);
  }
  function seekBy(d) {
    if (!canSeek()) return;
    if (ui.mode === 'vod') {
      video.currentTime = Math.max(0, Math.min(video.duration - 0.5, video.currentTime + d));
    } else {
      const w = seekWindow();
      video.currentTime = Math.max(w.start + 1, Math.min(w.end - 2, video.currentTime + d));
    }
    flash(d);
    hideUpNext();
    show();
  }
  function goLive() {
    const w = seekWindow();
    if (ui.hls && Number.isFinite(ui.hls.liveSyncPosition)) video.currentTime = ui.hls.liveSyncPosition;
    else if (w) video.currentTime = w.end - 3;
    video.play().catch(() => {});
  }
  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
    prefs().muted = video.muted; saveStore();
    setClass(); show();
  }
  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document)?.catch?.(() => {});
      return;
    }
    if (pEl.requestFullscreen) pEl.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
    else if (pEl.webkitRequestFullscreen) pEl.webkitRequestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone: Apple's own player
  }
  function togglePip() {
    if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
    if (video.requestPictureInPicture && document.pictureInPictureEnabled) video.requestPictureInPicture().catch((e) => toast('Picture-in-picture isn’t available: ' + e.message));
    else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
  }

  /* --------------------------------------------------- gestures on video */
  // Mouse: click = play/pause, double-click = fullscreen.
  // Touch: tap = show/hide controls, double-tap left/right = skip 10s.
  const gesture = $id('pc-gesture');
  let lastTap = 0, lastSide = 0, tapTimer = 0;
  gesture.addEventListener('pointerup', (e) => {
    if (ui.mode === 'idle') return;
    const rect = gesture.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const side = x < 0.4 ? -1 : x > 0.6 ? 1 : 0;
    const now = Date.now();
    if (ui.menuPage) { closeMenu(); return; }
    if (now - lastTap < 300 && side === lastSide) {
      clearTimeout(tapTimer);
      lastTap = now; // allow triple-tap to keep skipping
      if (e.pointerType === 'mouse') { toggleFullscreen(); lastTap = 0; }
      else if (side) seekBy(side * SKIP);
      else togglePlay();
      return;
    }
    lastTap = now; lastSide = side;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      if (e.pointerType === 'mouse') togglePlay();
      else if (pc.classList.contains('show')) { clearTimeout(ui.hideTimer); pc.classList.remove('show'); }
      else show();
    }, e.pointerType === 'mouse' ? 220 : 300);
  });

  /* --------------------------------------------------------- seek bar */
  const range = $id('pc-range'), tip = $id('pc-tip');
  function seekTarget(frac) {
    if (ui.mode === 'vod') return frac * (video.duration || 0);
    const w = seekWindow();
    return w ? w.start + frac * (w.end - w.start) : 0;
  }
  function labelFor(t) {
    if (ui.mode === 'vod') return fmt(t);
    const w = seekWindow();
    return w ? '−' + fmt(Math.max(0, w.end - t)) : '';
  }
  range.addEventListener('input', () => {
    ui.dragging = true;
    const frac = range.value / 1000;
    $id('pc-played').style.width = frac * 100 + '%';
    tip.hidden = false;
    tip.style.left = frac * 100 + '%';
    tip.textContent = labelFor(seekTarget(frac));
    show(true);
  });
  range.addEventListener('change', () => {
    video.currentTime = seekTarget(range.value / 1000);
    ui.dragging = false;
    tip.hidden = true;
    hideUpNext();
    show();
  });
  $id('pc-seek').addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || ui.dragging) return;
    const r = range.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    tip.hidden = false;
    tip.style.left = frac * 100 + '%';
    tip.textContent = labelFor(seekTarget(frac));
  });
  $id('pc-seek').addEventListener('pointerleave', () => { if (!ui.dragging) tip.hidden = true; });

  function updateTime() {
    if (ui.mode === 'idle') return;
    setClass();
    const t = video.currentTime;
    let frac = 0, buf = 0;
    if (ui.mode === 'vod' && video.duration > 0 && Number.isFinite(video.duration)) {
      frac = t / video.duration;
      $id('pc-time').textContent = `${fmt(t)} / ${fmt(video.duration)}`;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= t + 1 && video.buffered.end(i) >= t) buf = video.buffered.end(i) / video.duration;
      }
    } else if (ui.mode === 'vod') {
      $id('pc-time').textContent = fmt(t);
    } else {
      const w = seekWindow();
      // Live normally plays a few segments behind the newest one (the live edge).
      const edge = ui.hls && Number.isFinite(ui.hls.liveSyncPosition) ? ui.hls.liveSyncPosition : w ? w.end - 3 : 0;
      const behind = w ? edge - t : 0;
      pc.classList.toggle('is-behind', behind > 6);
      $id('pc-golive').hidden = !(w && behind > 6 && liveRewindable());
      if (w) {
        frac = (t - w.start) / (w.end - w.start);
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= t + 1 && video.buffered.end(i) >= t) buf = (video.buffered.end(i) - w.start) / (w.end - w.start);
        }
      }
    }
    if (!ui.dragging) {
      range.value = Math.round(Math.max(0, Math.min(1, frac)) * 1000);
      $id('pc-played').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
    }
    $id('pc-buf').style.width = Math.max(0, Math.min(1, buf)) * 100 + '%';
  }
  ['timeupdate', 'durationchange', 'progress', 'loadedmetadata', 'seeked'].forEach((ev) => video.addEventListener(ev, updateTime));
  ['play', 'pause', 'playing', 'ended', 'volumechange'].forEach((ev) => video.addEventListener(ev, () => { setClass(); if (video.paused) show(true); else show(); }));
  video.addEventListener('loadedmetadata', () => {
    if (ui.mode === 'vod') video.playbackRate = prefs().speed || 1;
  });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => { setClass(); show(); }));

  /* ---------------------------------------------------- volume & speed */
  const volRange = $id('pc-volume');
  volRange.addEventListener('input', () => {
    video.volume = Number(volRange.value);
    video.muted = video.volume === 0;
    prefs().volume = video.volume; prefs().muted = video.muted; saveStore();
    show();
  });
  video.addEventListener('volumechange', () => { volRange.value = video.muted ? 0 : video.volume; });

  /* ------------------------------------------------------- subtitles */
  function subTracks() {
    const out = [];
    for (const t of video.textTracks) {
      if (ui.dead.has(t) || (t.kind !== 'subtitles' && t.kind !== 'captions')) continue;
      out.push(t);
    }
    return out;
  }
  const trackName = (t) => t.label || (t.language ? t.language.toUpperCase() : t.kind === 'captions' ? 'Captions' : 'Subtitles');

  // Keeps only the chosen track loading cues, hidden so SevakTV draws it
  // (shown by the system only in iPhone fullscreen).
  function enforceModes() {
    for (const t of subTracks()) {
      const want = t === ui.selected ? (ui.nativeFs ? 'showing' : 'hidden') : 'disabled';
      if (t.mode !== want) t.mode = want;
    }
  }
  function selectSub(track, byUser) {
    ui.selected = track || null;
    if (byUser) { ui.userPicked = true; prefs().subLang = track ? (track.language || null) : null; saveStore(); }
    const hls = ui.hls;
    if (hls && hls.subtitleTracks) {
      const idx = track ? hls.subtitleTracks.findIndex((s) => (s.name || s.lang) === track.label) : -1;
      if (idx >= 0 && hls.subtitleTrack !== idx) hls.subtitleTrack = idx;
      if (idx < 0 && hls.subtitleTrack !== -1) hls.subtitleTrack = -1;
    }
    enforceModes();
    setTimeout(enforceModes, 0);
    $id('pc-cc').classList.toggle('is-on', !!track);
    ui.lastSubHTML = '';
    if (track && !ui.raf) ui.raf = requestAnimationFrame(renderSubs);
    if (!track) subsBox.hidden = true;
    if (ui.menuPage) renderMenu(ui.menuPage);
  }
  video.textTracks.addEventListener('change', () => enforceModes());
  video.textTracks.addEventListener('addtrack', () => {
    autoPickSub();
    if (ui.menuPage) renderMenu(ui.menuPage);
  });
  function autoPickSub() {
    const lang = prefs().subLang;
    if (ui.userPicked || ui.selected || !lang) return;
    const t = subTracks().find((x) => (x.language || '').toLowerCase().startsWith(lang.toLowerCase()));
    if (t) selectSub(t, false);
  }

  const cache = { track: null, len: -1, arr: [] };
  function cueHTML(text) {
    return esc(text)
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
      .replace(/&lt;\/?[^&]*?&gt;/g, '')
      .replace(/\n/g, '<br>');
  }
  function renderSubs() {
    const t = ui.selected;
    if (!t) { ui.raf = 0; subsBox.hidden = true; return; }
    const cues = t.cues;
    let html = '';
    if (cues && cues.length && !ui.nativeFs) {
      if (cache.track !== t || cache.len !== cues.length) {
        cache.track = t; cache.len = cues.length;
        cache.arr = Array.from(cues).sort((a, b) => a.startTime - b.startTime);
      }
      const now = video.currentTime - ui.offset;
      const arr = cache.arr;
      let lo = 0, hi = arr.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].startTime <= now) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      const active = [];
      for (let i = idx; i >= 0 && i > idx - 8; i--) if (arr[i].endTime > now) active.unshift(arr[i]);
      html = active.map((c) => `<span>${cueHTML(c.text)}</span>`).join('<br>');
    }
    if (html !== ui.lastSubHTML) {
      ui.lastSubHTML = html;
      subsBox.innerHTML = html;
      subsBox.hidden = !html;
    }
    subsBox.dataset.size = prefs().subSize || 'm';
    ui.raf = requestAnimationFrame(renderSubs);
  }

  // iPhone fullscreen uses Apple's player, which draws subtitles itself.
  video.addEventListener('webkitbeginfullscreen', () => { ui.nativeFs = true; enforceModes(); });
  video.addEventListener('webkitendfullscreen', () => { ui.nativeFs = false; enforceModes(); });

  function parseSubtitles(text) {
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const re = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
    const sec = (h, m, s, ms) => (Number(h) || 0) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0')) / 1000;
    const cues = [];
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => re.test(l));
      if (i < 0) continue;
      const m = lines[i].match(re);
      const body = lines.slice(i + 1).join('\n').trim();
      if (body) cues.push({ start: sec(m[1], m[2], m[3], m[4]), end: sec(m[5], m[6], m[7], m[8]), text: body });
    }
    return cues;
  }
  function addSubtitleTrack(text, label, lang) {
    const cues = parseSubtitles(text);
    if (!cues.length) throw new Error('No subtitles found in that file. SevakTV reads .srt and .vtt files.');
    const t = video.addTextTrack('subtitles', label, lang || '');
    t.mode = 'hidden';
    for (const c of cues) { try { t.addCue(new VTTCue(c.start, c.end, c.text)); } catch {} }
    selectSub(t, true);
    return cues.length;
  }
  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
  }
  $id('pc-subfile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const n = addSubtitleTrack(await decodeFile(f), f.name.replace(/\.(srt|vtt)$/i, ''), '');
      toast(`Loaded ${n} subtitle line${n === 1 ? '' : 's'} from ${f.name}`);
    } catch (err) { toast(err.message); }
  });

  function toggleCaptions() {
    if (ui.selected) { selectSub(null, true); toast('Subtitles off'); return; }
    const lang = prefs().subLang;
    const list = subTracks();
    const t = list.find((x) => lang && (x.language || '').startsWith(lang)) || list[0];
    if (t) { selectSub(t, true); toast('Subtitles: ' + trackName(t)); }
    else openMenu('subs');
  }

  /* ---------------------------------------------- audio / quality info */
  function audioOptions() {
    const hls = ui.hls;
    if (hls && hls.audioTracks && hls.audioTracks.length > 1) {
      return hls.audioTracks.map((a, i) => ({ label: a.name || a.lang || 'Track ' + (i + 1), on: hls.audioTrack === i, pick: () => { hls.audioTrack = i; } }));
    }
    const at = video.audioTracks;
    if (at && at.length > 1) {
      return Array.from(at).map((a, i) => ({ label: a.label || a.language || 'Track ' + (i + 1), on: a.enabled, pick: () => { for (let j = 0; j < at.length; j++) at[j].enabled = j === i; } }));
    }
    return [];
  }
  function qualityOptions() {
    const hls = ui.hls;
    if (!hls || !hls.levels || hls.levels.length < 2) return [];
    const cur = hls.levels[hls.currentLevel];
    const opts = [{ label: 'Auto' + (hls.autoLevelEnabled && cur ? ` (${cur.height ? cur.height + 'p' : Math.round(cur.bitrate / 1000) + ' kbps'})` : ''), on: hls.autoLevelEnabled, pick: () => { hls.currentLevel = -1; } }];
    hls.levels
      .map((l, i) => ({ l, i }))
      .sort((a, b) => (b.l.height || 0) - (a.l.height || 0) || b.l.bitrate - a.l.bitrate)
      .forEach(({ l, i }) => opts.push({ label: l.height ? l.height + 'p' : Math.round(l.bitrate / 1000) + ' kbps', on: !hls.autoLevelEnabled && hls.currentLevel === i, pick: () => { hls.currentLevel = i; } }));
    return opts;
  }

  /* ------------------------------------------------------------- menu */
  let menuActions = {};
  function item(label, value, act, on) {
    const id = 'a' + Object.keys(menuActions).length;
    menuActions[id] = act;
    return `<button class="pm-item${on ? ' is-on' : ''}" data-a="${id}"><span>${esc(label)}</span>${value != null ? `<span class="v">${esc(value)}</span>` : ''}</button>`;
  }
  const head = (title, back = 'main') => `<div class="pm-head">${back ? `<button data-back="${back}" aria-label="Back">‹</button>` : ''}<span>${esc(title)}</span></div>`;

  function renderMenu(page) {
    ui.menuPage = page;
    menuActions = {};
    let h = '';
    const subLabel = ui.selected ? trackName(ui.selected) : 'Off';
    const sizes = { s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large' };
    if (page === 'main') {
      h += head('Player options', null);
      h += item('Subtitles', subLabel, () => renderMenu('subs'));
      if (ui.selected) h += item('Subtitle timing', (ui.offset > 0 ? '+' : '') + ui.offset.toFixed(1) + 's', () => renderMenu('sync'));
      h += item('Subtitle size', sizes[prefs().subSize || 'm'], () => renderMenu('size'));
      const aud = audioOptions();
      if (aud.length) h += item('Audio', (aud.find((a) => a.on) || aud[0]).label, () => renderMenu('audio'));
      const q = qualityOptions();
      if (q.length) h += item('Quality', (q.find((x) => x.on) || q[0]).label, () => renderMenu('quality'));
      if (ui.mode === 'vod') h += item('Speed', (video.playbackRate === 1 ? 'Normal' : video.playbackRate + '×'), () => renderMenu('speed'));
    } else if (page === 'subs') {
      h += head('Subtitles');
      h += item('Off', null, () => selectSub(null, true), !ui.selected);
      for (const t of subTracks()) h += item(trackName(t), t.kind === 'captions' ? 'CC' : null, () => selectSub(t, true), t === ui.selected);
      h += '<div class="pm-sep"></div>';
      h += item('Load a subtitle file…', '.srt / .vtt', () => $id('pc-subfile').click());
      h += item('Search online…', 'OpenSubtitles', () => renderMenu('search'));
    } else if (page === 'sync') {
      h += head('Subtitle timing');
      h += `<p class="pm-note">Subtitles show too early? Press +. Too late? Press −.</p>`;
      h += `<div class="pm-sync">${item('−0.5s', null, () => { ui.offset -= 0.5; renderMenu('sync'); })}<output>${(ui.offset > 0 ? '+' : '') + ui.offset.toFixed(1)}s</output>${item('+0.5s', null, () => { ui.offset += 0.5; renderMenu('sync'); })}</div>`;
      h += item('Reset', null, () => { ui.offset = 0; renderMenu('sync'); });
    } else if (page === 'size') {
      h += head('Subtitle size');
      for (const [k, v] of Object.entries(sizes)) h += item(v, null, () => { prefs().subSize = k; saveStore(); renderMenu('size'); }, (prefs().subSize || 'm') === k);
    } else if (page === 'audio') {
      h += head('Audio');
      for (const a of audioOptions()) h += item(a.label, null, () => { a.pick(); setTimeout(() => renderMenu('audio'), 50); }, a.on);
    } else if (page === 'quality') {
      h += head('Quality');
      for (const q of qualityOptions()) h += item(q.label, null, () => { q.pick(); setTimeout(() => renderMenu('quality'), 50); }, q.on);
    } else if (page === 'speed') {
      h += head('Speed');
      for (const r of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
        h += item(r === 1 ? 'Normal' : r + '×', null, () => { video.playbackRate = r; prefs().speed = r; saveStore(); renderMenu('speed'); }, video.playbackRate === r);
      }
    } else if (page === 'search') {
      h += searchPage();
    }
    // On a small player (phones), the menu opens as a panel from the bottom
    // of the screen; in fullscreen or on a big player it stays inside the video.
    const asSheet = pEl.clientWidth < 520 && !(document.fullscreenElement || document.webkitFullscreenElement);
    if (asSheet && menu.parentElement !== document.body) document.body.appendChild(menu);
    if (!asSheet && menu.parentElement !== pc) pc.appendChild(menu);
    menu.classList.toggle('as-sheet', asSheet);
    menu.innerHTML = h;
    menu.hidden = false;
    show(true);
    if (page === 'search') bindSearch();
  }
  function openMenu(page) {
    if (ui.mode === 'idle') return;
    if (ui.menuPage === page) { closeMenu(); return; }
    renderMenu(page);
    const first = menu.querySelector('button, input');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu() {
    ui.menuPage = null;
    menu.hidden = true;
    if (menu.parentElement !== pc) pc.appendChild(menu);
    show();
  }
  menu.addEventListener('click', (e) => {
    const back = e.target.closest('[data-back]');
    if (back) { renderMenu(back.dataset.back); return; }
    const b = e.target.closest('[data-a]');
    if (b && menuActions[b.dataset.a]) menuActions[b.dataset.a]();
    const r = e.target.closest('[data-file]');
    if (r) downloadSub(Number(r.dataset.file), r.dataset.lang);
  });
  // Tapping outside the menu closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!ui.menuPage || menu.contains(e.target) || e.target.closest('#pc-gear, #pc-cc, #pc-subfile')) return;
    if (pc.contains(e.target) && e.target.closest('.pc-gesture')) return; // handled by the gesture layer
    closeMenu();
  }, true);
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } });

  /* ------------------------------------------------- online subtitles */
  function cleanTitle(name) {
    return String(name || '')
      .replace(/\[[^\]]*\]|\|[^|]*\|/g, ' ')
      .replace(/\((19|20)\d{2}\)/g, ' ')
      .replace(/^\s*[A-Z]{2,3}\s*[-:|•]\s*/, '')
      .replace(/\b(4K|UHD|FHD|HD|SD|1080p|720p|480p|HEVC|H\.?26[45]|x26[45]|VOSTFR|SUB|DUB|HDR|WEB-?DL|BluRay)\b/gi, ' ')
      .replace(/[_.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function searchDefaults() {
    const m = ui.meta.search || {};
    const yr = m.year || (String(m.title || '').match(/\b(19|20)\d{2}\b/) || [])[0] || '';
    return {
      query: cleanTitle(m.title || ui.meta.title || ''),
      year: String(yr).slice(0, 4),
      season: m.season != null ? String(m.season) : '',
      episode: m.episode != null ? String(m.episode) : '',
    };
  }
  function searchPage() {
    const s = ui.search || (ui.search = { ...searchDefaults(), langs: '', results: null, msg: '', busy: false });
    let h = head('Search subtitles online', 'subs');
    if (ui.osConfig && !ui.osConfig.configured) {
      h += `<p class="pm-note err">Online subtitles aren’t set up yet. Add a free OpenSubtitles API key in Settings → Online subtitles.</p>`;
      h += item('Open Settings', null, () => { closeMenu(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); openSettings(); const box = $id('os-box'); if (box) box.open = true; });
      return h;
    }
    h += `<form class="pm-form" id="pm-search">
      <input id="pm-q" value="${esc(s.query)}" placeholder="Title" aria-label="Title">
      <div class="row3">
        <input id="pm-year" value="${esc(s.year)}" placeholder="Year" inputmode="numeric" aria-label="Year">
        <input id="pm-season" value="${esc(s.season)}" placeholder="Season" inputmode="numeric" aria-label="Season">
        <input id="pm-ep" value="${esc(s.episode)}" placeholder="Episode" inputmode="numeric" aria-label="Episode">
      </div>
      <input id="pm-langs" value="${esc(s.langs || ui.osConfig?.languages || 'en')}" placeholder="Languages, e.g. en,hi" aria-label="Languages">
      <button class="btn btn-primary btn-sm" type="submit"${s.busy ? ' disabled' : ''}>${s.busy ? 'Searching…' : 'Search'}</button>
    </form>`;
    if (s.msg) h += `<p class="pm-note${s.err ? ' err' : ''}">${esc(s.msg)}</p>`;
    if (s.results) {
      if (!s.results.length) h += '<p class="pm-note">No subtitles found. Try a shorter title, or remove the year.</p>';
      for (const r of s.results) {
        const tags = [r.language?.toUpperCase(), r.downloads ? r.downloads.toLocaleString() + ' downloads' : '', r.hearingImpaired ? 'Hearing impaired' : '', r.machine ? 'Machine translated' : ''].filter(Boolean).join(' · ');
        h += `<button class="pm-res" data-file="${r.fileId}" data-lang="${esc(r.language || '')}"><b>${esc(r.release || r.title || 'Subtitle')}</b><small>${esc(tags)}</small></button>`;
      }
    }
    return h;
  }
  function bindSearch() {
    const f = $id('pm-search');
    if (!f) return;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const s = ui.search;
      s.query = $id('pm-q').value.trim(); s.year = $id('pm-year').value.trim();
      s.season = $id('pm-season').value.trim(); s.episode = $id('pm-ep').value.trim(); s.langs = $id('pm-langs').value.trim();
      s.busy = true; s.msg = ''; s.err = false;
      renderMenu('search');
      try {
        const q = new URLSearchParams({ query: s.query, languages: s.langs });
        if (s.year) q.set('year', s.year);
        if (s.season) q.set('season', s.season);
        if (s.episode) q.set('episode', s.episode);
        const d = await deviceApi('/api/subs/search?' + q.toString());
        s.results = d.results;
      } catch (err) { s.msg = err.message; s.err = true; s.results = null; }
      s.busy = false;
      if (ui.menuPage === 'search') renderMenu('search');
    });
  }
  async function downloadSub(fileId, lang) {
    const s = ui.search;
    s.msg = 'Downloading…'; s.err = false;
    renderMenu('search');
    try {
      const d = await deviceApi('/api/subs/download', { method: 'POST', body: { fileId } });
      const r = (s.results || []).find((x) => x.fileId === fileId);
      const n = addSubtitleTrack(d.text, `${(lang || '').toUpperCase() || 'Online'} · ${(r?.release || 'OpenSubtitles').slice(0, 40)}`, lang);
      s.msg = `Loaded ${n} subtitle line${n === 1 ? '' : 's'}.` + (d.remaining != null ? ` Downloads left today: ${d.remaining}.` : '');
      closeMenu();
      toast(s.msg);
    } catch (err) {
      s.msg = err.message; s.err = true;
      if (ui.menuPage === 'search') renderMenu('search');
    }
  }
  async function loadOsConfig() {
    try { ui.osConfig = await deviceApi('/api/subs/config'); } catch { ui.osConfig = { configured: false }; }
    return ui.osConfig;
  }

  /* ------------------------------------------------------- up next */
  function showUpNext() {
    const next = ui.meta.next;
    if (!next || ui.mode !== 'vod') return;
    let n = 10;
    $id('upnext-title').textContent = ui.meta.nextTitle || 'Next episode';
    $id('upnext-count').textContent = n;
    $id('pc-upnext').hidden = false;
    show(true);
    clearInterval(ui.nextTimer);
    ui.nextTimer = setInterval(() => {
      n--;
      $id('upnext-count').textContent = n;
      if (n <= 0) { hideUpNext(); next(); }
    }, 1000);
  }
  function hideUpNext() {
    clearInterval(ui.nextTimer);
    ui.nextTimer = 0;
    $id('pc-upnext').hidden = true;
  }
  video.addEventListener('ended', () => { if (ui.mode === 'vod') showUpNext(); });
  $id('upnext-play').onclick = () => { const n = ui.meta.next; hideUpNext(); n && n(); };
  $id('upnext-cancel').onclick = () => hideUpNext();

  /* ------------------------------------------------------- buttons */
  $id('pc-play').onclick = togglePlay;
  $id('pc-back').onclick = () => seekBy(-SKIP);
  $id('pc-fwd').onclick = () => seekBy(SKIP);
  $id('pc-chup').onclick = () => zap(-1);
  $id('pc-chdown').onclick = () => zap(1);
  $id('pc-mute').onclick = toggleMute;
  $id('pc-golive').onclick = goLive;
  $id('pc-next').onclick = () => { hideUpNext(); ui.meta.next && ui.meta.next(); };
  $id('pc-cc').onclick = () => openMenu('subs');
  $id('pc-gear').onclick = () => openMenu('main');
  $id('pc-pip').onclick = togglePip;
  $id('pc-fs').onclick = toggleFullscreen;

  /* ------------------------------------------- hooks used by app.js */
  return {
    onStart(req) {
      ui.mode = req.live ? 'live' : 'vod';
      ui.meta = req.meta || {};
      ui.hls = null;
      ui.search = null;
      // Subtitles from the previous video are retired.
      for (const t of video.textTracks) { ui.dead.add(t); try { t.mode = 'disabled'; } catch {} }
      ui.selected = null; ui.userPicked = false; ui.offset = 0; ui.lastSubHTML = '';
      subsBox.hidden = true;
      $id('pc-cc').classList.remove('is-on');
      $id('pc-title').textContent = ui.meta.title || '';
      $id('pc-sub').textContent = ui.meta.sub || '';
      $id('pc-next').hidden = !ui.meta.next;
      $id('pc-golive').hidden = true;
      $id('pc-time').textContent = '';
      range.value = 0;
      $id('pc-played').style.width = '0%';
      $id('pc-buf').style.width = '0%';
      const p = prefs();
      video.muted = !!p.muted;
      if (canSetVolume) video.volume = p.volume ?? 1;
      video.defaultPlaybackRate = ui.mode === 'vod' ? p.speed || 1 : 1;
      video.playbackRate = video.defaultPlaybackRate;
      hideUpNext();
      closeMenu();
      setClass();
      show();
      if (!ui.osConfig && state.proxyAvailable) loadOsConfig();
    },
    attachHls(hls) {
      ui.hls = hls;
      const refresh = () => { autoPickSub(); if (ui.menuPage) renderMenu(ui.menuPage); };
      try { hls.subtitleDisplay = false; } catch {}
      [Hls.Events.MANIFEST_PARSED, Hls.Events.AUDIO_TRACKS_UPDATED, Hls.Events.AUDIO_TRACK_SWITCHED,
        Hls.Events.SUBTITLE_TRACKS_UPDATED, Hls.Events.LEVEL_SWITCHED].forEach((ev) => hls.on(ev, refresh));
    },
    onIdle() {
      ui.mode = 'idle';
      ui.meta = {};
      hideUpNext();
      closeMenu();
      ui.selected = null;
      subsBox.hidden = true;
      if (document.fullscreenElement === pEl) document.exitFullscreen().catch(() => {});
      setClass();
    },
    // Returns true when the key was used by the player.
    handleKey(e) {
      if (ui.mode === 'idle' || e.ctrlKey || e.metaKey || e.altKey) return false;
      const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
      switch (e.key) {
        case ' ': case 'k': case 'K': if (onButton && e.key === ' ') return false; togglePlay(); break;
        case 'ArrowLeft': case 'j': case 'J': if (!canSeek()) return false; seekBy(-SKIP); break;
        case 'ArrowRight': case 'l': case 'L': if (!canSeek()) return false; seekBy(SKIP); break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'm': case 'M': toggleMute(); toast(video.muted ? 'Muted' : 'Sound on'); break;
        case 'c': case 'C': toggleCaptions(); break;
        case 'p': case 'P': if (!pipSupported) return false; togglePip(); break;
        case 'n': case 'N': if (!ui.meta.next) return false; hideUpNext(); ui.meta.next(); break;
        case 'Escape': if (!ui.menuPage) return false; closeMenu(); break;
        default: return false;
      }
      e.preventDefault();
      return true;
    },
    loadOsConfig,
    get menuOpen() { return !!ui.menuPage; },
    _ui: ui, // for debugging
  };
})();
window.PUI = PUI;
