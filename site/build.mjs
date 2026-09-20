// Builds opifer.dev into site/dist: the home page, the stylesheet, the assets and the
// documentation pages rendered from the Markdown files in docs/.
//   node site/build.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(here, "dist");

const pages = [
  {
    slug: "quickstart",
    source: "docs/quickstart.md",
    title: "Opifer in ten minutes",
    description: "Install Opifer, connect a model, hire the first agent and give the first task.",
  },
  { slug: "security", source: "docs/security.md", title: "Security review", description: "What Opifer protects, how, and what it does not do yet." },
];

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const shell = ({ title, description, slug, body, source }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)} — Opifer</title>
    <meta name="description" content="${escape(description)}" />
    <link rel="canonical" href="https://opifer.dev/docs/${slug}/" />
    <meta property="og:title" content="${escape(title)} — Opifer" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:image" content="https://opifer.dev/assets/og.png" />
    <meta name="theme-color" content="#0a0a0f" />
    <link rel="icon" href="/assets/favicon.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    <header class="top">
      <div class="wrap">
        <a class="brand" href="/"><span class="mark">O</span><span class="word">Opifer</span></a>
        <nav class="nav" aria-label="Main">
          <a href="/#how">How it works</a>
          <a href="/#rules">Guarantees</a>
          <a href="/#faq">FAQ</a>
          <a class="docs-link" href="/docs/quickstart/">Docs</a>
          <a class="gh" href="https://github.com/NextEpochs/opifer" rel="noopener">GitHub</a>
        </nav>
      </div>
    </header>
    <main id="main" class="wrap doc">
      <aside aria-label="Documentation">
        <div class="grp">Guides</div>
        ${pages.map((p) => `<a href="/docs/${p.slug}/"${p.slug === slug ? ' class="on" aria-current="page"' : ""}>${escape(p.title)}</a>`).join("\n        ")}
        <div class="grp">On GitHub</div>
        <a href="https://github.com/NextEpochs/opifer/blob/main/README.md" rel="noopener">README</a>
        <a href="https://github.com/NextEpochs/opifer/blob/main/CHANGELOG.md" rel="noopener">Changelog</a>
        <a href="https://github.com/NextEpochs/opifer/blob/main/AGENTS.md" rel="noopener">Rules of the repository</a>
        <a href="https://github.com/NextEpochs/opifer/blob/main/CONTRIBUTING.md" rel="noopener">Contributing</a>
        <a href="https://github.com/NextEpochs/opifer/blob/main/SECURITY.md" rel="noopener">Reporting a vulnerability</a>
      </aside>
      <article>
${body}
        <p class="src">This page is rendered from <a href="https://github.com/NextEpochs/opifer/blob/main/${source}" rel="noopener"><code>${source}</code></a> in the repository. Fix it there.</p>
      </article>
    </main>
    <footer>
      <div class="wrap">
        <span>Opifer is a <a href="https://nextepochs.com" rel="noopener">NextEpochs</a> product.</span>
        <a href="https://github.com/NextEpochs/opifer/blob/main/LICENSE" rel="noopener">AGPL-3.0 core, MIT SDK and plugins</a>
        <span class="r">Version 0.1.0</span>
      </div>
    </footer>
  </body>
</html>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "docs"), { recursive: true });
cpSync(path.join(here, "index.html"), path.join(out, "index.html"));
cpSync(path.join(here, "style.css"), path.join(out, "style.css"));
cpSync(path.join(here, "assets"), path.join(out, "assets"), { recursive: true });
writeFileSync(path.join(out, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://opifer.dev/sitemap.xml\n");
writeFileSync(
  path.join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    ["https://opifer.dev/", ...pages.map((p) => `https://opifer.dev/docs/${p.slug}/`)].map((u) => `  <url><loc>${u}</loc></url>`).join("\n") +
    `\n</urlset>\n`,
);

for (const page of pages) {
  const markdown = readFileSync(path.join(root, page.source), "utf8")
    // Links to sibling docs and to repository files point at the site or at GitHub.
    .replace(/\]\(docs\/(quickstart|security)\.md\)/g, "](/docs/$1/)")
    .replace(/\]\(((?:README|CHANGELOG|AGENTS|CONTRIBUTING|SECURITY)\.md)\)/g, "](https://github.com/NextEpochs/opifer/blob/main/$1)");
  const body = marked.parse(markdown, { gfm: true });
  mkdirSync(path.join(out, "docs", page.slug), { recursive: true });
  writeFileSync(path.join(out, "docs", page.slug, "index.html"), shell({ ...page, body }));
}
console.log(`site built in ${path.relative(root, out)}: home, ${pages.length} docs pages`);
