// Injected into the moonlight-web stream page: on every animation frame, reads the stamp from the
// biggest <video>/<canvas> on the page and records Date.now() - stamp (frame age when displayed).
(() => {
  const B_BITS = 16;
  const work = document.createElement('canvas');
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const isRed = (d, i) => d[i] > 180 && d[i + 1] < 80 && d[i + 2] < 80;
  const isBlue = (d, i) => d[i + 2] > 180 && d[i] < 80 && d[i + 1] < 80;
  const st = (window.__lat = { ages: [], misses: 0, el: null, cal: null, last: -1 });

  const pick = () => {
    const els = [...document.querySelectorAll('video, canvas')].filter((e) => e !== work);
    const size = (e) => (e.videoWidth || e.width || 0) * (e.videoHeight || e.height || 0);
    return els.sort((a, b) => size(b) - size(a))[0] || null;
  };
  const dims = (e) => [e.videoWidth || e.width, e.videoHeight || e.height];

  function calibrate(el) {
    const [w, h] = dims(el);
    if (!w || !h) return null;
    work.width = w; work.height = h;
    ctx.drawImage(el, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x++) {
      if (!isRed(d, (y * w + x) * 4)) continue;
      let x2 = x; while (x2 < w && isRed(d, (y * w + x2) * 4)) x2++;
      const bw = x2 - x;
      if (bw >= 6 && isBlue(d, (y * w + Math.min(w - 1, Math.round(x + bw * 1.5))) * 4)) {
        let y0 = y; while (y0 > 0 && isRed(d, ((y0 - 1) * w + x) * 4)) y0--;
        return { x, y: y0, bw };
      }
      x = x2;
    }
    return null;
  }

  function read(el, cal) {
    const [w] = dims(el);
    const { x, y, bw } = cal;
    const sw = Math.min(w - x, Math.ceil(bw * (B_BITS + 2))), sh = Math.ceil(bw);
    work.width = sw; work.height = sh;
    ctx.drawImage(el, x, y, sw, sh, 0, 0, sw, sh);
    const d = ctx.getImageData(0, 0, sw, sh).data;
    const at = (i) => (Math.floor(sh / 2) * sw + Math.floor((i + 0.5) * bw)) * 4;
    if (!isRed(d, at(0)) || !isBlue(d, at(1))) return null;
    let code = 0;
    for (let i = 0; i < B_BITS; i++) {
      const p = at(i + 2);
      code = (code << 1) | (0.3 * d[p] + 0.59 * d[p + 1] + 0.11 * d[p + 2] > 128 ? 1 : 0);
    }
    return code;
  }

  (function loop() {
    const now = Date.now();
    if (!st.el || !st.el.isConnected) { st.el = pick(); st.cal = null; }
    if (st.el) {
      if (!st.cal) st.cal = calibrate(st.el);
      if (st.cal) {
        const code = read(st.el, st.cal);
        if (code === null) { st.cal = null; st.misses++; }
        else if (code !== st.last) { // only count new frames
          st.last = code;
          const age = ((now & 0xffff) - code + 0x10000) & 0xffff;
          if (age < 2000) { st.ages.push(age); if (st.ages.length > 2000) st.ages.shift(); }
        }
      }
    }
    requestAnimationFrame(loop);
  })();

  window.__latSummary = () => {
    const s = [...st.ages].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, med: q(0.5), p95: q(0.95), min: s[0], misses: st.misses, el: st.el && st.el.tagName, dims: st.el && dims(st.el) };
  };
})();
