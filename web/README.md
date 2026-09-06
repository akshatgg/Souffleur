# Site

The landing page and docs for Souffleur, deployed to Vercel.

Static HTML, CSS and one small script. No framework, no build step.

## Deploying

The Vercel project is linked to this GitHub repo with **Root Directory set to
`web`**. Without that, a push builds the repository root — which has no
`index.html` — and every domain starts returning 404 while the CLI deploys that
came from this folder are silently replaced.

    vercel deploy --prod        # from the repo root

## Files

    index.html   landing page; the hero is two CSS-3D panels showing the same
                 screen as you see it and as a screen share sees it
    docs.html    install, providers, shortcuts, listening, interview mode
    site.js      resolves download links to the latest release assets and
                 highlights the one matching the visitor's platform
    style.css    shared by both pages
