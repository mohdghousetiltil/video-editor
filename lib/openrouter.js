// fetch() for OpenRouter with retries: a rate limit (429) or a passing server error (5xx, network drop) is tried
// again twice with a short pause instead of failing the whole job.
// `safe: false` is for calls that start paid work (e.g. submitting a video): those are only retried on 429 or when
// the request never reached the server, so a 5xx after the work was accepted can't charge you twice.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 520, 522, 524]);

async function orFetch(url, opts = {}, { retries = 2, safe = true, wait = [1500, 4000] } = {}) {
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(url, opts);
    } catch (e) {
      // the request didn't complete; for non-safe calls only retry when it clearly never got there
      const neverSent = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(String(e.cause?.code || e.message));
      if (i < retries && (safe || neverSent)) { await sleep(wait[i] ?? 4000); continue; }
      throw e;
    }
    const again = r.status === 429 || (safe && RETRY_STATUS.has(r.status));
    if (!again || i >= retries) return r;
    const ra = Number(r.headers.get("retry-after"));
    await r.body?.cancel().catch(() => {});
    await sleep(ra > 0 && ra < 30 ? ra * 1000 : wait[i] ?? 4000);
  }
}

module.exports = { orFetch, RETRY_STATUS };
