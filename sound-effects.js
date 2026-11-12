(() => {
  'use strict';

  const SOURCES = {
    play: 'sounds/play.wav',
    pause: 'sounds/pause.wav',
    switch: 'sounds/switch.wav',
    eject: 'sounds/eject.wav',
    insert: 'sounds/insert.wav',
    close: 'sounds/close.wav',
    hiss: 'sounds/hiss.wav'
  };
  const STORAGE_KEY = 'muzvecher-mechanical-sounds';

  window.createMechanicalSounds = function createMechanicalSounds() {
    let settings = { enabled: true, volume: 0.45 };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (typeof saved?.enabled === 'boolean') settings.enabled = saved.enabled;
      if (Number.isFinite(saved?.volume)) settings.volume = Math.max(0, Math.min(1, saved.volume));
    } catch { /* Storage can be disabled in a local browser session. */ }

    let context = null;
    let master = null;
    let running = false;
    let visible = true;
    const buffers = new Map();
    const fallback = new Map();
    const voices = new Map();
    const Context = window.AudioContext || window.webkitAudioContext;
    try {
      if (Context && window.location.protocol !== 'file:') {
        context = new Context({ latencyHint: 'interactive' });
        master = context.createGain();
        master.gain.value = settings.enabled ? settings.volume : 0;
        master.connect(context.destination);
      }
    } catch { context = null; }

    // Preload before interaction. A sound which is not ready is never queued late.
    for (const [name, url] of Object.entries(SOURCES)) {
      const element = new Audio(url);
      element.preload = 'auto';
      element.loop = name === 'hiss';
      fallback.set(name, element);
      element.load();
      if (context) {
        fetch(url).then(response => {
          if (!response.ok) throw new Error('Sound unavailable');
          return response.arrayBuffer();
        }).then(bytes => context.decodeAudioData(bytes)).then(buffer => {
          buffers.set(name, buffer);
        }).catch(() => {});
      }
    }

    function save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Optional persistence. */ }
    }

    function unlock() {
      if (context?.state === 'suspended') context.resume().catch(() => {});
    }

    function stop(channel, fade = 0.015) {
      const voice = voices.get(channel);
      if (!voice) return;
      voices.delete(channel);
      if (voice.element) {
        voice.element.pause();
        voice.element.currentTime = 0;
      } else {
        const now = context.currentTime;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + fade);
        voice.source.stop(now + fade);
      }
    }

    function play(name) {
      if (!settings.enabled || settings.volume === 0 || !visible) return;
      unlock();
      const channel = name === 'hiss' ? 'hiss' : ['play', 'pause', 'switch'].includes(name) ? 'button' : 'mechanism';
      stop(channel);
      const level = name === 'hiss' ? 0.14 : 1;
      const buffer = buffers.get(name);
      if (buffer && context) {
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.loop = name === 'hiss';
        gain.gain.setValueAtTime(0, context.currentTime);
        gain.gain.linearRampToValueAtTime(level, context.currentTime + (name === 'hiss' ? 0.18 : 0.003));
        source.connect(gain);
        gain.connect(master);
        const voice = { source, gain };
        voices.set(channel, voice);
        source.onended = () => {
          source.disconnect();
          gain.disconnect();
          if (voices.get(channel) === voice) voices.delete(channel);
        };
        source.start();
      } else {
        const element = fallback.get(name);
        if (!element || element.readyState < 2) return;
        element.volume = settings.volume * level;
        element.currentTime = 0;
        const voice = { element };
        voices.set(channel, voice);
        element.play().then(() => {
          if (voices.get(channel) !== voice && voices.get(channel)?.element !== element) element.pause();
        }).catch(() => {
          if (voices.get(channel) === voice) voices.delete(channel);
        });
      }
    }

    function syncHiss() {
      if (running && visible && settings.enabled && settings.volume > 0) {
        if (!voices.has('hiss')) play('hiss');
      } else {
        stop('hiss', 0.07);
      }
    }

    function updateSettings() {
      if (master) master.gain.setTargetAtTime(settings.enabled ? settings.volume : 0, context.currentTime, 0.02);
      for (const [channel, voice] of voices) {
        if (!settings.enabled || settings.volume === 0) stop(channel);
        else if (voice.element) voice.element.volume = settings.volume * (channel === 'hiss' ? 0.14 : 1);
      }
      syncHiss();
      save();
    }

    return {
      play,
      unlock,
      stopMechanism() { stop('mechanism'); },
      setRunning(value) { running = value; syncHiss(); },
      setVisible(value) {
        visible = value;
        if (!visible) for (const channel of [...voices.keys()]) stop(channel);
        syncHiss();
      },
      setEnabled(value) { settings.enabled = Boolean(value); updateSettings(); },
      setVolume(value) {
        if (!Number.isFinite(value)) return;
        settings.volume = Math.max(0, Math.min(1, value));
        updateSettings();
      },
      getSettings() { return { ...settings }; }
    };
  };
})();
