# Getting found

Everything on this page is either already done in `web/`, or a thing only you
can do because it needs an account.

---

## What is in the repository

| File | Does |
|---|---|
| `web/robots.txt` | Lets every crawler in, and names the sitemap. Search assistants (GPTBot, ClaudeBot, PerplexityBot and friends) are allowed by name rather than by default |
| `web/sitemap.xml` | The three pages, with `lastmod` refreshed on every release by `npm run site:update` |
| `web/site.webmanifest` | Name, icons and theme colour for installed/pinned use |
| `web/og.png` | The 1200×630 link preview card, rebuilt with `npm run site:og` |
| `<link rel="canonical">` | On all three pages. Five hostnames serve this site; this is what tells Google which one is real |
| JSON-LD | `SoftwareApplication` + `WebSite` + `Person` on the home page, `FAQPage` on the home and comparison pages, `TechArticle` + `BreadcrumbList` on the docs |

The canonical host is **`https://getsouffleur.vercel.app`**. It appears in
`robots.txt`, `sitemap.xml`, every canonical tag, every `og:url`, and every
`@id` in the structured data. Changing it means changing all of those — see
*Moving to a real domain* below.

### Why the alias redirects exist

`vercel alias ls` showed five hostnames all serving the same deployment:

    getsouffleur.vercel.app            <- canonical
    souffleur-ai.vercel.app
    souffleur-theta.vercel.app
    souffleur-akshat-guptas-projects-….vercel.app
    souffleur-git-master-akshat-guptas-projects-….vercel.app

Five copies of one site is duplicate content, and it splits whatever ranking
signal the site earns across hostnames that nobody links to on purpose.
`web/vercel.json` now sends the other four to the canonical host with a 301.

If you add a custom domain later, **remove or repoint those redirect rules
first** — they match on hostname, and a rule that catches your new domain would
bounce it straight back to `getsouffleur.vercel.app`.

---

## What you have to do

### 1. Google Search Console — 10 minutes, matters most

Nothing gets indexed reliably until Google is told the site exists.

1. Open [search.google.com/search-console](https://search.google.com/search-console)
   and add a **URL prefix** property for `https://getsouffleur.vercel.app`.
2. Choose **HTML tag** verification. It gives you a line like
   `<meta name="google-site-verification" content="…">`.
3. Paste it into `web/index.html` directly under the `<meta name="author">`
   line, push, wait for the deploy, then press Verify.
4. **Sitemaps → add** `sitemap.xml`.
5. **URL Inspection →** paste each of the three URLs → **Request indexing**.

Step 5 is the one people skip. It moves first indexing from weeks to days.

### 2. Bing Webmaster Tools — 5 minutes

[bing.com/webmasters](https://www.bing.com/webmasters) imports the Search
Console property in one click. Worth doing: Bing's index is what ChatGPT search
and Copilot read from.

### 3. Get the first links

Rankings for anything competitive need links, and a new site has none. The
honest, non-spammy ones for a project like this:

- **GitHub.** Put the site URL in the repository's *Website* field and at the
  top of `README.md`. It is a real link from a high-authority domain and takes
  ten seconds.
- **The `cluely-alternative` and `open-source-cluely` GitHub topics.** Add them
  to the repository. That is how people already browsing for this find it.
- **Show HN / r/SideProject / r/macapps.** Lead with the verification data, not
  the app — "I tested whether these overlays are actually invisible, with a
  control window" is a post people read. "I made an app" is not.
- **AlternativeTo, Product Hunt, awesome-* lists.** Slow, but they are the
  pages that already rank for "cluely alternative".

No amount of on-page work substitutes for this part.

---

## Moving to a real domain

`getsouffleur.vercel.app` can rank — `vercel.app` is on the Public Suffix List,
so Google treats each subdomain as its own site rather than as a slice of
Vercel. But a `.vercel.app` address reads as a hobby deployment to a person
deciding whether to install something that watches their screen, and that
matters more here than on most sites.

A domain is roughly 10–15 USD a year. If you buy one:

1. Add it in the Vercel project → **Settings → Domains**, and make it the
   production domain.
2. Delete the four alias redirect rules in `web/vercel.json`, or change them so
   the *old* `.vercel.app` hosts redirect to the new domain.
3. Replace `getsouffleur.vercel.app` everywhere:

       grep -rl 'getsouffleur.vercel.app' web/ packaging/ docs/ \
         | xargs sed -i '' 's|getsouffleur\.vercel\.app|yourdomain.com|g'

4. In Search Console, add the new property, submit the sitemap again, and use
   the **Change of Address** tool so the old host's history follows you.

---

## What the pages are aimed at

| Page | The search it is written for |
|---|---|
| `/` | *invisible ai assistant screen share*, *hide window from screen share*, *undetectable ai interview assistant*, and the brand itself |
| `/vs-cluely` | *cluely alternative*, *free cluely alternative*, *open source cluely*, *cluely pricing* |
| `/docs` | *souffleur install*, *how to hide an app from a screen share on mac*, and the long tail of setup questions |

`/vs-cluely` is the one with real headroom. "Cluely alternative" is searched by
people who already want this exact thing and have just seen the price, and the
pages ranking for it today are listicles rather than products. The comparison is
deliberately fair — it says plainly where Cluely is the better buy — because a
page that only attacks the competitor gets read as marketing and does not hold a
ranking.

The genuine differentiator, and the thing worth repeating anywhere the project
is written about, is that **the invisibility claim was measured against an
unprotected control window and the numbers are published**. Nobody else in the
category does that.

---

## A note on FAQ rich results

The `FAQPage` structured data will probably not draw the expandable FAQ block in
Google results: since 2023 those are restricted to government and health sites.
It is still worth having. Bing uses it, and the assistants that now answer
"what's a free alternative to Cluely" parse exactly this markup to decide what
the page says.

---

## Checking your work

    curl -s https://getsouffleur.vercel.app/robots.txt
    curl -s https://getsouffleur.vercel.app/sitemap.xml
    curl -sI https://souffleur-ai.vercel.app/ | grep -i '^location'   # expect the 301

- [Rich Results Test](https://search.google.com/test/rich-results) — paste each URL
- [Schema validator](https://validator.schema.org/)
- [OpenGraph preview](https://www.opengraph.xyz/) — check the card renders
- PageSpeed Insights, or Lighthouse in Chrome DevTools

Re-run these after any change to the `<head>` of a page.
