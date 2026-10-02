/* Souffleur site: OS-aware download links, and parallax on the hero rig. */

const REPO = 'https://github.com/akshatgg/souffleur-releases';
const LATEST = `${REPO}/releases/latest`;

/* ------------------------------ downloads ------------------------------- */

/**
 * macOS installs through Homebrew, Windows downloads a file.
 *
 * The macOS disk image is deliberately not offered here. It is not notarised,
 * so opening it means approving the app by hand in System Settings, and a
 * download button that leads to a security dialog is a worse first experience
 * than a command that just works. The DMG is still on the releases page for
 * anyone who wants it.
 */
async function wireDownloads() {
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const isMac = /Mac/i.test(platform) || /Mac OS X/i.test(ua);
  const isWin = /Win/i.test(platform) || /Windows/i.test(ua);

  const label = document.querySelector('[data-os-label]');
  if (label) {
    label.textContent = isWin ? 'Download for Windows'
      : isMac ? 'Install on macOS'
      : 'Download';
  }
  if (isWin) document.getElementById('dl-win')?.classList.add('is-yours');
  if (isMac) document.querySelector('.dl-mac')?.classList.add('is-yours');

  // Copy any command block rather than making people select it by hand.
  for (const btn of document.querySelectorAll('[data-cmd]')) {
    const flag = btn.querySelector('.cmd-copy');
    btn.addEventListener('click', async () => {
      const text = btn.querySelector('code').textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
        flag.textContent = 'Copied';
      } catch {
        // Clipboard access can be refused; selecting the text still helps.
        const r = document.createRange();
        r.selectNodeContents(btn.querySelector('code'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        flag.textContent = 'Select and copy';
      }
      setTimeout(() => { flag.textContent = 'Copy'; }, 1800);
    });
  }

  // Keep the Windows link pointing at the newest installer.
  try {
    const res = await fetch('https://api.github.com/repos/akshatgg/souffleur-releases/releases/latest');
    if (!res.ok) return;
    const rel = await res.json();
    const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
    if (exe) document.getElementById('dl-win')?.setAttribute('href', exe.browser_download_url);
    document.querySelectorAll('[data-version]').forEach((el) => {
      el.textContent = rel.tag_name || el.textContent;
    });
  } catch {
    /* offline or rate limited: the baked-in link still resolves */
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
