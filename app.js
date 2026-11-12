(() => {
  'use strict';

  // CSV parser supports quoted commas, escaped quotes, CRLF and multiline cells.
  function parseCSV(input) {
    const text = input.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (character === '"') {
        if (quoted && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (quoted || cell.length === 0) {
          quoted = !quoted;
        } else {
          cell += character;
        }
      } else if (character === ',' && !quoted) {
        row.push(cell);
        cell = '';
      } else if ((character === '\n' || character === '\r') && !quoted) {
        row.push(cell);
        if (row.some(value => value.trim())) rows.push(row);
        row = [];
        cell = '';
        if (character === '\r' && text[i + 1] === '\n') i++;
      } else {
        cell += character;
      }
    }
    if (quoted) throw new Error('В CSV не закрыты кавычки.');
    row.push(cell);
    if (row.some(value => value.trim())) rows.push(row);
    return rows;
  }

  function normalizeData(rows, columns) {
    if (rows.length < 2) throw new Error('Таблица не содержит выступлений.');
    const key = value => String(value).trim().toLocaleLowerCase('ru');
    const headers = rows[0].map(key);
    const indices = {};
    for (const field of ['id', 'songTitle', 'groupName', 'artist', 'order']) {
      const aliases = (columns[field] || []).map(key);
      indices[field] = headers.findIndex(header => aliases.includes(header));
    }
    if (indices.songTitle < 0 || indices.groupName < 0) {
      throw new Error('Проверьте заголовки песни и коллектива в настройке columns.');
    }
    const performances = [];
    let skippedRows = 0;
    for (const row of rows.slice(1)) {
      const read = field => (row[indices[field]] || '').trim();
      const songTitle = read('songTitle');
      const groupName = read('groupName');
      if (!songTitle || !groupName) {
        skippedRows++;
        continue;
      }
      performances.push({ id: read('id'), songTitle, groupName, artist: read('artist'), order: read('order') || performances.length + 1 });
    }
    if (!performances.length) throw new Error('Нет строк с названием песни и коллективом.');
    return { performances, skippedRows };
  }

  async function loadPerformances(config, fallback) {
    if (config.source === 'local' || !config.csvUrl.trim()) return { performances: fallback, source: 'local', message: '' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const url = new URL(config.csvUrl);
      if (url.protocol !== 'https:') throw new Error('Для CSV укажите HTTPS-ссылку.');
      const response = await fetch(url.href, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Ошибка загрузки таблицы (${response.status}).`);
      const csv = await response.text();
      if (/^\s*</.test(csv)) throw new Error('Ссылка вернула страницу вместо CSV.');
      const result = normalizeData(parseCSV(csv), config.columns);
      return { ...result, source: 'sheets', message: result.skippedRows ? `Пропущено строк без песни или коллектива — ${result.skippedRows}.` : '' };
    } catch (error) {
      const reason = error.name === 'AbortError' ? 'Истекло время ожидания таблицы.' : error.message;
      return { performances: fallback, source: 'fallback', message: `Используется демонстрационная коллекция. ${reason}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  window.MixtapeData = { parseCSV, normalizeData, loadPerformances };
  const $ = id => document.getElementById(id);
  const player = $('player');
  const cassette = $('cassette');
  const status = $('status');
  const list = $('tape-list');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const effects = window.createMechanicalSounds();
  const accents = ['#d97970', '#6f9b92', '#d7a258', '#849aa3', '#bf8b96', '#739b8d', '#cbab6d', '#b88165'];
  let performances = window.DEMO_PERFORMANCES;
  let currentIndex = 0;
  let requestedIndex = 0;
  let playing = false;
  let switching = false;
  let loading = false;
  let audio = null;
  let audioAttempt = 0;
  let exchangeController = null;
  let musicVolume = 1;
  let volumeDrag = null;
  const volumeInput = $('music-volume');
  const volumeKnob = $('volume-knob');
  try {
    const saved = localStorage.getItem('muzvecher-music-volume');
    if (saved !== null && saved.trim() !== '' && Number.isFinite(Number(saved))) {
      musicVolume = Math.max(0, Math.min(1, Number(saved)));
    }
  } catch { /* The volume control also works when storage is unavailable. */ }

  function setMusicVolume(value) {
    if (!Number.isFinite(value)) return;
    musicVolume = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    if (audio) audio.volume = musicVolume;
    const percent = Math.round(musicVolume * 100);
    volumeInput.value = percent;
    volumeInput.setAttribute('aria-valuetext', `${percent}%`);
    volumeInput.title = `Громкость музыки — ${percent}%`;
    volumeKnob.style.setProperty('--volume-angle', `${-135 + musicVolume * 270}deg`);
    try { localStorage.setItem('muzvecher-music-volume', String(musicVolume)); } catch { /* Optional persistence. */ }
  }

  function pointerAngle(event) {
    const bounds = volumeKnob.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    if (Math.hypot(x, y) < 8) return null;
    return Math.atan2(x, -y) * 180 / Math.PI;
  }

  volumeInput.addEventListener('input', () => setMusicVolume(Number(volumeInput.value) / 100));
  volumeInput.addEventListener('pointerdown', event => {
    if (event.button !== 0 || volumeDrag) return;
    event.preventDefault();
    volumeInput.focus({ preventScroll: true });
    volumeInput.setPointerCapture(event.pointerId);
    volumeDrag = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      volume: musicVolume, angle: pointerAngle(event)
    };
    volumeKnob.classList.add('is-turning');
  });
  volumeInput.addEventListener('pointermove', event => {
    if (!volumeDrag || event.pointerId !== volumeDrag.pointerId) return;
    if (volumeDrag.angle === null) {
      setMusicVolume(volumeDrag.volume + (volumeDrag.y - event.clientY + event.clientX - volumeDrag.x) / 180);
      return;
    }
    const angle = pointerAngle(event);
    if (angle === null) return;
    // Normalize the wrap at ±180° so crossing it never jumps to full volume.
    const delta = (angle - volumeDrag.angle + 540) % 360 - 180;
    volumeDrag.volume = Math.max(0, Math.min(1, volumeDrag.volume + delta / 270));
    setMusicVolume(volumeDrag.volume);
    volumeDrag.angle = angle;
  });
  function endVolumeDrag(event) {
    if (!volumeDrag || event.pointerId !== volumeDrag.pointerId) return;
    volumeDrag = null;
    volumeKnob.classList.remove('is-turning');
    if (volumeInput.hasPointerCapture(event.pointerId)) volumeInput.releasePointerCapture(event.pointerId);
  }
  volumeInput.addEventListener('pointerup', endVolumeDrag);
  volumeInput.addEventListener('pointercancel', endVolumeDrag);
  volumeInput.addEventListener('lostpointercapture', endVolumeDrag);
  volumeInput.addEventListener('wheel', event => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    setMusicVolume(musicVolume - Math.sign(event.deltaY) * 0.05);
  }, { passive: false });
  setMusicVolume(musicVolume);

  function prepareLocalAudio() {
    audioAttempt++;
    $('audio-note').textContent = 'кассета без аудиофрагмента';
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio = null;
    }
    const track = performances[currentIndex];
    const clip = (window.MIXTAPE_AUDIO || {})[track.id];
    const uniqueId = track.id && performances.filter(item => item.id === track.id).length === 1;
    // A changed song under the same ID must never play an older recording.
    if (!uniqueId || !clip || clip.songTitle !== track.songTitle || clip.artist !== track.artist) return;
    if (!/^audio\/[a-zA-Z0-9_-]+\.mp3$/.test(clip.file)) return;
    const localAudio = new Audio();
    localAudio.volume = musicVolume;
    localAudio.preload = 'none';
    localAudio.src = clip.file;
    localAudio.addEventListener('error', () => {
      if (audio === localAudio) {
        localAudio.pause();
        audio = null;
        $('audio-note').textContent = `Ошибка аудио ${localAudio.error?.code || ''} · ${localAudio.error?.message || 'файл не загружен'}`;
      }
    });
    audio = localAudio;
    $('audio-note').textContent = 'локальный аудиофрагмент';
  }

  function syncLocalAudio() {
    const attempt = ++audioAttempt;
    const currentAudio = audio;
    if (!currentAudio) return;
    if (!playing || switching) {
      currentAudio.pause();
      return;
    }
    if (currentAudio.ended) currentAudio.currentTime = 0;
    currentAudio.play().then(() => {
      if (audio !== currentAudio || !playing || switching) currentAudio.pause();
    }).catch(error => {
      // Autoplay restrictions and missing files leave the mechanism usable.
      if (attempt === audioAttempt && audio === currentAudio && error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
        currentAudio.pause();
        audio = null;
        $('audio-note').textContent = 'кассета без аудиофрагмента';
      }
    });
  }

  const displayOrder = value => String(value).padStart(2, '0');

  function updatePlayback() {
    player.classList.toggle('is-playing', playing && !switching);
    $('play-pause').setAttribute('aria-pressed', String(playing));
    $('play-pause').setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
    $('play-icon').setAttribute('href', playing ? '#pause' : '#play');
    $('lcd-mode').textContent = switching ? 'CHANGING' : playing ? 'PLAY ▸' : 'STAND BY';
    syncLocalAudio();
    effects.setRunning(playing && !switching);
  }

  function updateNavigation() {
    $('previous').disabled = loading || requestedIndex === 0;
    $('next').disabled = loading || requestedIndex === performances.length - 1;
    $('play-pause').disabled = loading;
    for (const button of list.children) {
      button.setAttribute('aria-current', String(Number(button.dataset.index) === currentIndex));
      button.disabled = loading;
    }
  }

  function renderCassette() {
    const track = performances[currentIndex];
    $('song-title').textContent = track.songTitle;
    $('song-title').title = track.songTitle;
    $('group-name').textContent = track.groupName;
    $('group-name').title = track.groupName;
    $('artist-name').textContent = track.artist ? `Оригинал — ${track.artist}` : '';
    $('tape-order').textContent = displayOrder(track.order);
    cassette.setAttribute('aria-label', `Выступление ${track.order}. ${track.songTitle}. ${track.groupName}.`);
    cassette.style.setProperty('--accent', accents[currentIndex % accents.length]);
    const number = document.createTextNode(displayOrder(currentIndex + 1));
    const total = document.createElement('span');
    total.textContent = `/ ${displayOrder(performances.length)}`;
    $('lcd-number').replaceChildren(number, total);
    updateNavigation();
  }

  function renderCollection() {
    list.replaceChildren();
    performances.forEach((track, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tape-spine';
      button.dataset.index = index;
      button.style.setProperty('--tape-color', accents[index % accents.length]);
      const number = document.createElement('span');
      number.className = 'spine-number';
      number.textContent = displayOrder(track.order);
      const info = document.createElement('span');
      info.className = 'spine-info';
      const title = document.createElement('span');
      title.className = 'spine-title';
      title.textContent = track.songTitle;
      const group = document.createElement('span');
      group.className = 'spine-group';
      group.textContent = track.groupName;
      info.append(title, group);
      const side = document.createElement('span');
      side.className = 'spine-side';
      side.textContent = 'A';
      button.append(number, info, side);
      button.setAttribute('aria-label', `${track.order}. ${track.songTitle} — ${track.groupName}`);
      button.addEventListener('click', () => requestTrack(index));
      list.append(button);
    });
    $('collection-count').textContent = displayOrder(performances.length);
    updateNavigation();
  }

  // Each sound starts at an animation phase, never from a detached timer.
  async function animateCassette(keyframes, duration, easing, signal) {
    if (signal.aborted) throw new DOMException('Exchange interrupted', 'AbortError');
    if (reducedMotion.matches) return;
    const animation = cassette.animate(keyframes, { duration, easing, fill: 'forwards' });
    const commitPosition = () => {
      try { animation.commitStyles?.(); } catch { /* Detached effects have no position to commit. */ }
    };
    const cancel = () => {
      commitPosition();
      animation.cancel();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await animation.finished;
    } finally {
      signal.removeEventListener('abort', cancel);
      // Preserve the physical position when a new request interrupts a phase.
      if (!signal.aborted) commitPosition();
      animation.cancel();
    }
  }

  async function exchange() {
    if (switching) return;
    switching = true;
    player.classList.add('is-exchanging');
    updatePlayback();
    try {
      while (true) {
        exchangeController = new AbortController();
        const signal = exchangeController.signal;
        try {
          status.textContent = 'Меняем кассету…';
          cassette.style.pointerEvents = 'none';
          effects.play('eject');
          await animateCassette([
            {},
            { transform: 'translateY(-9px) translateZ(26px) rotateX(-9deg)', opacity: 1, offset: .25 },
            { transform: 'translateY(-85px) translateZ(65px) rotate(-4deg)', opacity: 0 }
          ], 450, 'cubic-bezier(.45,0,.75,.45)', signal);
          if (signal.aborted) continue;
          currentIndex = requestedIndex;
          renderCassette();
          prepareLocalAudio();
          effects.play('insert');
          await animateCassette([
            { transform: 'translateY(-85px) translateZ(65px) rotate(4deg)', opacity: 0 },
            { transform: 'translateY(-9px) translateZ(20px) rotateX(-6deg)', opacity: 1 }
          ], 400, 'cubic-bezier(.16,.65,.3,1)', signal);
          if (signal.aborted) continue;
          effects.play('close');
          await animateCassette([
            { transform: 'translateY(-9px) translateZ(20px) rotateX(-6deg)', opacity: 1 },
            { transform: 'translateY(2px)', opacity: 1, offset: .8 },
            { transform: 'translateY(0)', opacity: 1 }
          ], 160, 'ease-out', signal);
          if (!signal.aborted && currentIndex === requestedIndex) break;
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    } finally {
      exchangeController = null;
      cassette.style.transform = '';
      cassette.style.opacity = '';
      switching = false;
      cassette.style.pointerEvents = '';
      player.classList.remove('is-exchanging');
      updatePlayback();
      announceTrack();
    }
  }

  function announceTrack() {
    const track = performances[currentIndex];
    status.textContent = `${displayOrder(track.order)} · ${track.songTitle} — ${track.groupName}`;
  }

  function requestTrack(index) {
    if (loading) return;
    const destination = Math.max(0, Math.min(performances.length - 1, index));
    if (destination === requestedIndex) return;
    requestedIndex = destination;
    effects.unlock();
    effects.stopMechanism();
    effects.play('switch');
    exchangeController?.abort();
    updateNavigation();
    void exchange();
  }

  function togglePlayback() {
    if (loading) return;
    playing = !playing;
    effects.play(playing ? 'play' : 'pause');
    updatePlayback();
    if (!switching) status.textContent = playing ? 'Плёнка крутится. Лето продолжается.' : 'Пауза. Поймаем этот момент.';
  }

  $('previous').addEventListener('click', () => requestTrack(requestedIndex - 1));
  $('next').addEventListener('click', () => requestTrack(requestedIndex + 1));
  $('play-pause').addEventListener('click', togglePlayback);
  document.addEventListener('visibilitychange', () => effects.setVisible(!document.hidden));
  window.addEventListener('pagehide', () => effects.setVisible(false));
  window.addEventListener('pageshow', () => effects.setVisible(!document.hidden));
  effects.setVisible(!document.hidden);
  $('collection-toggle').addEventListener('click', () => {
    const open = $('collection-toggle').getAttribute('aria-expanded') !== 'true';
    $('collection-toggle').setAttribute('aria-expanded', String(open));
    $('collection-content').hidden = !open;
  });
  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,[contenteditable=true]')) return;
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      event.preventDefault();
      requestTrack(requestedIndex + (event.code === 'ArrowRight' ? 1 : -1));
    }
    if (event.code === 'Space' && !event.target.closest('button,a')) {
      event.preventDefault();
      if (!event.repeat) togglePlayback();
    }
    if (event.code === 'Escape' && !$('collection-content').hidden) {
      $('collection-content').hidden = true;
      $('collection-toggle').setAttribute('aria-expanded', 'false');
      $('collection-toggle').focus();
    }
  });

  async function initialize() {
    loading = window.MIXTAPE_CONFIG.source !== 'local' && Boolean(window.MIXTAPE_CONFIG.csvUrl.trim());
    renderCollection();
    renderCassette();
    if (loading) status.textContent = 'Загружаем программу вечера…';
    const result = await loadPerformances(window.MIXTAPE_CONFIG, window.DEMO_PERFORMANCES);
    performances = result.performances;
    loading = false;
    renderCollection();
    renderCassette();
    prepareLocalAudio();
    $('source-label').textContent = result.source === 'sheets' ? 'GOOGLE SHEETS · CSV' : "МУЗВЕЧЕР '26";
    $('data-message').textContent = result.message;
    status.textContent = result.source === 'fallback' ? 'Таблица недоступна. Загружены демо-кассеты.' : 'Кассета готова. Нажмите Play.';
  }
  void initialize();
})();
