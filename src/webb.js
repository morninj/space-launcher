// A Webb photograph behind the list, a different one each time, with a line
// saying what it is in the corner. The photos and their catalog are fetched
// into webb/ by scripts/fetch-webb.py; until that has been run there is no
// WEBB, and the page grows its generative background instead.
(() => {
  const catalog = typeof WEBB === "undefined" ? [] : WEBB;

  if (!catalog.length) {
    const art = document.createElement("script");
    art.src = "background-art.js";
    document.body.append(art);
    return;
  }

  // Never the same photo twice running. Remembered per browser only, and
  // anything going wrong with storage just means no memory.
  let last = null;
  try {
    last = localStorage.getItem("webb-last");
  } catch {}
  const pool = catalog.length > 1 ? catalog.filter((p) => p.id !== last) : catalog;
  const photo = pool[Math.floor(Math.random() * pool.length)];
  try {
    localStorage.setItem("webb-last", photo.id);
  } catch {}

  unlessReplaced(() => {
    const img = document.getElementById("photo");
    img.onload = () => img.classList.add("shown");
    img.src = `webb/${photo.id}.jpg`;
    img.alt = photo.title;

    const caption = document.getElementById("caption");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = photo.title;
    const blurb = document.createElement("span");
    blurb.className = "blurb";
    blurb.textContent = photo.blurb;
    const credit = document.createElement("span");
    credit.className = "credit";
    credit.textContent = [photo.credit, photo.date].filter(Boolean).join(" · ");
    // Out of the tab order: the keyboard belongs to the list.
    const more = document.createElement("a");
    more.href = photo.url;
    more.textContent = "more";
    more.tabIndex = -1;
    credit.append(" · ", more);
    caption.append(title, blurb, credit);
  });
})();
