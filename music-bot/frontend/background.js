export function initBackground(canvas, onProgress) {
  const context = canvas.getContext('2d');
  const image = document.getElementById('wallpaper-image');
  let enabled = true, last = 0, elapsed = 0;
  const petals = Array.from({ length: 17 }, (_, i) => ({ x: ((i * 67) % 101) / 100, y: ((i * 37) % 103) / 100, size: 3 + i % 5, speed: 0.018 + (i % 4) * 0.006, phase: i * 1.7 }));
  const ready = () => { canvas.dataset.ready = 'true'; onProgress?.(1); };
  image.addEventListener('load', ready); image.addEventListener('error', () => onProgress?.(-1));
  if (image.complete && image.naturalWidth) ready();
  function resize() { const ratio = Math.min(devicePixelRatio, 1.5); canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio; context.setTransform(ratio, 0, 0, ratio, 0, 0); }
  window.addEventListener('resize', resize); resize();
  window.addEventListener('pointermove', (event) => {
    if (!enabled) return;
    image.style.setProperty('--look-x', `${(event.clientX / innerWidth - 0.5) * 6}px`);
    image.style.setProperty('--look-y', `${(event.clientY / innerHeight - 0.5) * 4}px`);
  });
  function frame(time) {
    requestAnimationFrame(frame);
    if (document.hidden || time - last < 34) return;
    const dt = Math.min((time - last) / 1000, 0.06); last = time;
    if (enabled) elapsed += dt;
    context.clearRect(0, 0, innerWidth, innerHeight);
    if (enabled) for (const petal of petals) {
      const y = ((petal.y + elapsed * petal.speed) % 1.2 - 0.1) * innerHeight;
      const x = petal.x * innerWidth + Math.sin(elapsed * 0.35 + petal.phase) * 40;
      context.save(); context.translate(x, y); context.rotate(elapsed * 0.45 + petal.phase);
      context.fillStyle = `rgba(221,237,224,${0.18 + (petal.size - 3) * 0.045})`;
      context.beginPath(); context.ellipse(0, 0, petal.size, petal.size * 0.45, 0, 0, Math.PI * 2); context.fill(); context.restore();
    }
    canvas.dataset.frames = String(Number(canvas.dataset.frames || 0) + 1);
  }
  requestAnimationFrame(frame);
  return { setEnabled(value) { enabled = value; image.style.setProperty('--look-x', '0px'); image.style.setProperty('--look-y', '0px'); }, setImmersive() {} };
}
