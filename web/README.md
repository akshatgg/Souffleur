# Site

The landing page, comparison page and docs for Souffleur, deployed to Vercel.

Static HTML, CSS and one small script. No framework, no build step.

## Deploying

The Vercel project is linked to this GitHub repo with **Root Directory set to
`web`**. Without that, a push builds the repository root — which has no
`index.html` — and every domain starts returning 404 while the CLI deploys that
came from this folder are silently replaced.

    vercel deploy --prod        # from the repo root

## Files

    index.html        landing page; the hero is two CSS-3D panels showing the same
                      screen as you see it and as a screen share sees it, and the
                      page ends in the FAQ that the FAQPage structured data mirrors
    vs-cluely.html    the comparison page — the one written to be found by people
                      searching for a cheaper way to do this
    docs.html         install, providers, shortcuts, listening, interview mode
    site.js           resolves download links to the latest release assets and
                      highlights the one matching the visitor's platform
    style.css         shared by all three pages
    robots.txt        crawl policy; names the sitemap
    sitemap.xml       the three URLs; lastmod refreshed by `npm run site:update`
    site.webmanifest  name, icons, theme colour
    og.png            1200x630 link preview card, built by `npm run site:og`
                      from packaging/og-image.html
    vercel.json       clean URLs, security headers, and 301s from the four extra
                      .vercel.app hostnames to the canonical one

## Keeping it current

    npm run site:update    # version label, Windows installer link, schema version,
                           # sitemap lastmod — run by CI after every release
    npm run site:og        # rebuild og.png after editing packaging/og-image.html

The canonical host is `https://getsouffleur.vercel.app`, hard-coded in the
canonical tags, `og:url`s, structured data, `robots.txt` and `sitemap.xml`.
[docs/SEO.md](../docs/SEO.md) covers how to change it, and what has to be done
in Search Console that no file in this repo can do for you.
