// Runs in the page: reads the paper's details from the citation meta tags publishers use
// (Google Scholar's citation_*, Dublin Core, PRISM, JSON-LD), with sensible fallbacks.
(() => {
  const metas = (names) => {
    const out = [];
    for (const n of names) for (const m of document.querySelectorAll(`meta[name="${n}" i], meta[property="${n}" i]`)) { const c = (m.getAttribute("content") || "").trim(); if (c) out.push(c); }
    return out;
  };
  const one = (...names) => metas(names)[0] || "";
  const r = { url: location.href, isPdf: document.contentType === "application/pdf" };
  r.title = one("citation_title", "dc.title", "DC.title", "prism.title", "og:title", "twitter:title") || document.title;
  let authors = metas(["citation_author", "dc.creator", "DC.creator", "author"]);
  r.doi = (one("citation_doi", "dc.identifier", "DC.identifier", "prism.doi", "bepress_citation_doi") || "").replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, "");
  if (!/^10\./.test(r.doi)) r.doi = "";
  r.year = (one("citation_publication_date", "citation_date", "citation_online_date", "dc.date", "DC.date", "prism.publicationDate", "article:published_time").match(/\d{4}/) || [""])[0];
  r.venue = one("citation_journal_title", "citation_conference_title", "citation_book_title", "prism.publicationName", "citation_publisher", "og:site_name");
  r.volume = one("citation_volume", "prism.volume");
  r.issue = one("citation_issue", "prism.number");
  const fp = one("citation_firstpage", "prism.startingPage"), lp = one("citation_lastpage", "prism.endingPage");
  r.pages = fp && lp ? `${fp}-${lp}` : fp;
  r.publisher = one("citation_publisher", "dc.publisher", "DC.publisher");
  r.abstract = one("citation_abstract", "dc.description", "DC.description", "description", "og:description");
  r.arxiv = one("citation_arxiv_id");
  r.pdfUrl = one("citation_pdf_url", "bepress_citation_pdf_url", "eprints.document_url");
  const conf = one("citation_conference_title");
  r.type = conf ? "inproceedings" : one("citation_book_title") ? "incollection" : "article";
  // JSON-LD (ScholarlyArticle and friends)
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const items = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const it of items) {
        if (!/Article|Paper|Chapter|Book|Thesis|Report/i.test(String(it["@type"] || ""))) continue;
        if (!r.title && it.headline) r.title = it.headline;
        if (!authors.length && it.author) authors = [].concat(it.author).map((a) => (typeof a === "string" ? a : a.name)).filter(Boolean);
        if (!r.year && it.datePublished) r.year = String(it.datePublished).slice(0, 4);
        if (!r.doi && it.identifier) { const m = JSON.stringify(it.identifier).match(/10\.\d{4,9}\/[^"\s]+/); if (m) r.doi = m[0]; }
      }
    } catch {}
  }
  // a DOI link on the page
  if (!r.doi) {
    const a = [...document.querySelectorAll('a[href*="doi.org/10."]')][0];
    const m = a && a.href.match(/doi\.org\/(10\.\d{4,9}\/[^?#\s]+)/);
    if (m) r.doi = decodeURIComponent(m[1]);
  }
  // arXiv abstract pages
  const ax = location.href.match(/arxiv\.org\/(?:abs|pdf)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?$/);
  if (ax) { r.arxiv = ax[1]; if (!r.pdfUrl) r.pdfUrl = `https://arxiv.org/pdf/${ax[1]}`; }
  // a PDF link on the page, if nothing better
  if (!r.pdfUrl && !r.isPdf) {
    const a = [...document.querySelectorAll("a[href]")].find((x) => /\.pdf(\?|#|$)/i.test(x.href) && /pdf|download|full.?text/i.test(x.textContent + x.title + x.className));
    if (a) r.pdfUrl = a.href;
  }
  r.authors = authors.map((a) => a.trim()).filter(Boolean).slice(0, 200);
  return r;
})();
