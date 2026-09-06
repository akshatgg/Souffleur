/* Souffleur site: OS-aware download links, and parallax on the hero rig. */

const REPO = 'https://github.com/akshatgg/Souffleur';
const LATEST = `${REPO}/releases/latest`;

/* ------------------------------ downloads ------------------------------- */

/**
 * Point each card at a real asset in the newest release, and highlight the one
 * matching the visitor's machine. If the API is unreachable or no release
 * exists yet, the cards keep their /releases/latest hrefs, which always works.
 */
async function wireDownloads() {
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const isMac = /Mac/i.test(platform) || /Mac OS X/i.test(ua);
  const isWin = /Win/i.test(platform) || /Windows/i.test(ua);

  // Apple Silicon cannot be read directly; the WebGL renderer string is the
  // usual tell, and guessing wrong only mislabels a highlight.
  let appleSilicon = false;
  if (isMac) {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
      appleSilicon = /Apple/i.test(renderer) && !/Intel/i.test(renderer);
    } catch { /* leave it false */ }
    if (navigator.userAgentData?.platform === 'macOS' && navigator.maxTouchPoints > 1) {
      appleSilicon = true;
    }
  }

  const mine = isWin ? 'dl-win' : isMac ? (appleSilicon ? 'dl-mac-arm' : 'dl-mac-intel') : null;
  if (mine) document.getElementById(mine)?.classList.add('is-yours');

  // The hero button downloads the right file rather than scrolling to a list.
  // Anyone who lands here and clicks the big button wants the app, not a menu.
  const label = document.querySelector('[data-os-label]');
  if (label) {
    label.textContent = isWin ? 'Download for Windows'
      : isMac ? (appleSilicon ? 'Download for Mac (Apple Silicon)' : 'Download for Mac (Intel)')
      : 'Download';
    const target = mine && document.getElementById(mine);
    if (target) {
      label.href = target.href;
      label.setAttribute('download', '');
    }
  }

  try {
    const res = await fetch('https://api.github.com/repos/akshatgg/Souffleur/releases/latest');
    if (!res.ok) return;
    const rel = await res.json();
    const find = (re) => (rel.assets || []).find((a) => re.test(a.name))?.browser_download_url;

    const map = {
      'dl-mac-arm': find(/arm64.*\.dmg$/i),
      'dl-mac-intel': find(/^(?!.*arm64).*\.dmg$/i),
      'dl-win': find(/\.exe$/i),
    };
    // Only ever replace a baked-in URL with a newer one. If the API is rate
    // limited or the shape changes, the hrefs already in the HTML still point
    // at real files, so a click always downloads something that works.
    for (const [id, url] of Object.entries(map)) {
      if (!url) continue;
      document.getElementById(id)?.setAttribute('href', url);
      if (id === mine && label) label.href = url;
    }
    const v = document.querySelectorAll('[data-version]');
    v.forEach((el) => { el.textContent = rel.tag_name || ''; });
  } catch {
    /* offline or rate limited: the /releases/latest links still resolve */
  }
}

/* ------------------------------- parallax -------------------------------- */

/**
 * Tilt the two screens toward the pointer. Small angles on purpose: the rig is
 * meant to read as two physical panels catching the light, not as a carousel.
 */
function wireParallax() {
  const stage = document.getElementById('stage');
  const rig = document.getElementById('rig');
  if (!stage || !rig) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia('(pointer: coarse)').matches) return;

  let raf = 0;
  let target = { x: 0, y: 0 };

  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    target = {
      x: ((e.clientX - r.left) / r.width - 0.5) * 2,
      y: ((e.clientY - r.top) / r.height - 0.5) * 2,
    };
    if (!raf) raf = requestAnimationFrame(apply);
  });

  stage.addEventListener('pointerleave', () => {
    target = { x: 0, y: 0 };
    if (!raf) raf = requestAnimationFrame(apply);
  });

  function apply() {
    raf = 0;
    rig.style.transform =
      `rotateY(${(target.x * 5).toFixed(2)}deg) rotateX(${(-target.y * 3.5).toFixed(2)}deg)`;
  }
}

wireDownloads();
wireParallax();
