'use strict';
/*
 * 桌宠提示音：默认用 Web Audio 现场合成几个短音，不带音频文件。
 * done 任务做完：往上走的三个音，像小铃铛；ask 在问你：一低一高，像「嗯？」；waiting 可能在等你：同一个音轻轻两下；
 * error 出错停下：往下走的两个音；empty 额度用完：往下走的三个音。每个都在半秒左右。
 * 每种都可以换成用户自己选的音频（setCustom 交来文件的字节，在这里解码）：最多放 5 秒，太长的最后淡出截掉。
 * 桌宠窗口（desk-pet.js）按设置播放；「桌宠」设置页试听。
 */
(root => {
  /** [频率 Hz, 从第几秒开始, 响多久（秒）] */
  const TUNES = {
    done: [[1046.5, 0, 0.16], [1318.5, 0.09, 0.16], [1568, 0.18, 0.34]],
    ask: [[784, 0, 0.14], [1174.7, 0.13, 0.32]],
    waiting: [[880, 0, 0.18], [880, 0.22, 0.26]],
    error: [[659.3, 0, 0.2], [523.3, 0.16, 0.36]],
    empty: [[587.3, 0, 0.16], [493.9, 0.14, 0.16], [392, 0.28, 0.4]],
  };
  /** 低沉的两种用三角波，听起来更「提醒」；做完、在问你、等你用正弦波加一点高八度，像铃铛。 */
  const SOFT = new Set(['done', 'ask', 'waiting']);
  const CUSTOM_MAX_S = 5, FADE_S = 0.3, IDLE_CLOSE_MS = 8000;
  let audio = null, pendingPlay = null, idleCloseTimer = null;
  /** 自己选的音频：种类 → 解码好的 AudioBuffer（空闲关闭 AudioContext 后释放）与原始字节（按需再解码）。 */
  const custom = {}, customBytes = {}, tokens = {};

  function cancelIdleClose() {
    if (idleCloseTimer != null) {
      if (typeof clearTimeout === 'function') clearTimeout(idleCloseTimer);
      idleCloseTimer = null;
    }
  }

  /** 提示音播完空闲一段时间后关闭 AudioContext，让 Chromium 回收 ~100 MB 的 AudioService 进程。 */
  function closeIdleContext() {
    if (!audio || pendingPlay) return;
    const ctx = audio;
    audio = null;
    for (const k of Object.keys(custom)) delete custom[k];
    try {
      const p = ctx.close?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* ignore */ }
  }

  function scheduleIdleClose(extraMs = 0) {
    cancelIdleClose();
    if (!audio || audio.state === 'closed' || typeof setTimeout !== 'function') return;
    idleCloseTimer = setTimeout(() => {
      idleCloseTimer = null;
      closeIdleContext();
    }, IDLE_CLOSE_MS + Math.max(0, extraMs));
    if (idleCloseTimer && typeof idleCloseTimer.unref === 'function') idleCloseTimer.unref();
  }

  function context() {
    const Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return null;
    if (!audio || audio.state === 'closed') audio = new Ctx();
    return audio;
  }

  function note(ctx, out, freq, start, length, type, level) {
    const osc = ctx.createOscillator(), env = ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(level, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(env); env.connect(out);
    osc.start(start); osc.stop(start + length + 0.03);
  }

  function playCustom(ctx, buffer, level) {
    const source = ctx.createBufferSource(), out = ctx.createGain(), start = ctx.currentTime + 0.02;
    const length = Math.min(buffer.duration, CUSTOM_MAX_S);
    source.buffer = buffer;
    out.gain.setValueAtTime(level, start);
    // 截掉的才淡出；本来就短的原样放完
    if (buffer.duration > CUSTOM_MAX_S) { out.gain.setValueAtTime(level, start + length - FADE_S); out.gain.linearRampToValueAtTime(0.0001, start + length); }
    source.connect(out); out.connect(ctx.destination);
    source.start(start); source.stop(start + length);
    return length * 1000 + 200;
  }

  function scheduleTune(ctx, kind, tune, level) {
    const out = ctx.createGain(), start = ctx.currentTime + 0.02;
    out.gain.value = 0.3 * level;
    out.connect(ctx.destination);
    let endS = 0.6;
    for (const [freq, at, length] of tune) {
      if (at + length > endS) endS = at + length;
      if (SOFT.has(kind)) {
        note(ctx, out, freq, start + at, length, 'sine', 1);
        note(ctx, out, freq * 2, start + at, length * 0.6, 'sine', 0.25);
      } else note(ctx, out, freq, start + at, length, 'triangle', 0.9);
    }
    return endS * 1000 + 200;
  }

  function schedule(ctx, kind, tune, level) {
    if (custom[kind]) {
      scheduleIdleClose(playCustom(ctx, custom[kind], level));
      return;
    }
    if (customBytes[kind] && typeof ctx.decodeAudioData === 'function') {
      const token = tokens[kind] || 0;
      const raw = customBytes[kind];
      cancelIdleClose();
      Promise.resolve()
        .then(() => ctx.decodeAudioData(raw.slice().buffer))
        .then(buffer => {
          if (tokens[kind] !== token || !customBytes[kind]) return;
          custom[kind] = buffer;
          if (audio === ctx && ctx.state !== 'closed') {
            scheduleIdleClose(playCustom(ctx, buffer, level));
          }
        })
        .catch(() => {
          if (audio === ctx && ctx.state !== 'closed') {
            scheduleIdleClose(scheduleTune(ctx, kind, tune, level));
          }
        });
      return;
    }
    scheduleIdleClose(scheduleTune(ctx, kind, tune, level));
  }

  /** 播一种提示音；volume 0～1。换过音频的放自己的。放不出来（没有声卡之类）返回 false，不抛错。 */
  function play(kind, volume = 0.7) {
    const tune = TUNES[kind];
    if (!tune) return false;
    try {
      cancelIdleClose();
      const ctx = context();
      if (!ctx) return false;
      const numeric = Number(volume);
      const level = Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 0.7));
      if (ctx.state === 'suspended') {
        const hadPending = !!pendingPlay;
        pendingPlay = { kind, tune, level };
        if (!hadPending) {
          ctx.resume().then(() => {
            const next = pendingPlay;
            pendingPlay = null;
            if (next && ctx.state === 'running') {
              try { schedule(ctx, next.kind, next.tune, next.level); } catch { /* ignore */ }
            } else {
              scheduleIdleClose();
            }
          }).catch(() => { pendingPlay = null; scheduleIdleClose(); });
        }
        return true;
      }
      schedule(ctx, kind, tune, level);
      return true;
    } catch { return false; }
  }

  /** 换成自己的音频（bytes 是文件内容），null 恢复默认。解码失败（文件坏了、格式不支持）返回 false，仍用默认的。 */
  async function setCustom(kind, bytes) {
    if (!TUNES[kind]) return false;
    delete custom[kind];
    delete customBytes[kind];
    // 前后脚换了两次：只认最后一次
    const token = (tokens[kind] = (tokens[kind] || 0) + 1);
    if (!bytes) { scheduleIdleClose(); return true; }
    try {
      const ctx = context();
      if (!ctx) return false;
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const copy = view.slice();
      // decodeAudioData 会占用（detach）传进去的缓冲区：给它一份副本
      const buffer = await ctx.decodeAudioData(copy.slice().buffer);
      if (tokens[kind] === token) {
        custom[kind] = buffer;
        customBytes[kind] = copy;
      }
      scheduleIdleClose();
      return true;
    } catch {
      scheduleIdleClose();
      return false;
    }
  }

  root.PulsePetSound = {
    play,
    setCustom,
    hasCustom: kind => Boolean(custom[kind] || customBytes[kind]),
    closeIdle: closeIdleContext,
    KINDS: Object.keys(TUNES),
    CUSTOM_MAX_S,
  };
})(typeof window !== 'undefined' ? window : globalThis);
