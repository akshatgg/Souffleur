/* Pure shaping for the admin report and platform detection.
 *
 * Kept apart from auth.js because that file can only run in a browser — it
 * imports the Firebase SDK straight from gstatic. The arithmetic behind the
 * report is the part worth testing, so it lives here where `node --test` can
 * reach it, and auth.js imports it as a plain module.
 */

/**
 * Which desktop the visitor is on. The site offers a Homebrew command to Macs
 * and an .exe to Windows, so those are the only two that change what is shown;
 * everything else is 'other' and gets the plain download link.
 */
export function detectOs(ua = '', platform = '') {
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return 'mac';
  return 'other';
}

/**
 * Roll a list of user records into the numbers the report shows.
 *
 * Two different questions get confused easily, so both are answered:
 * `signups` counts people by the machine they signed in from, `downloads`
 * counts install actions, and one person can do several. A Mac user who takes
 * the Windows installer for another machine is counted honestly in both.
 */
export function summarise(users = []) {
  const out = {
    total: users.length,
    downloaders: 0,
    signups: { mac: 0, windows: 0, other: 0 },
    downloads: { mac: 0, windows: 0, total: 0 },
  };

  for (const u of users) {
    const mac = Number(u.mac) || 0;
    const windows = Number(u.windows) || 0;

    out.signups[u.os in out.signups ? u.os : 'other'] += 1;
    out.downloads.mac += mac;
    out.downloads.windows += windows;
    if (mac + windows > 0) out.downloaders += 1;
  }

  out.downloads.total = out.downloads.mac + out.downloads.windows;
  return out;
}
