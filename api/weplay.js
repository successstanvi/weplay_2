const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const CACHE_TTL = 300 * 1000;
const cache = global.__weplayCache || (global.__weplayCache = new Map());

function cacheGet(uid) {
  const hit = cache.get(uid);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) {
    cache.delete(uid);
    return null;
  }
  return hit.data;
}

function cacheSet(uid, data) {
  cache.set(uid, { ts: Date.now(), data });
}

async function scrapeWePlay(uid) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 900 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    await page.goto("https://weplayapp.com/en-IN/recharge", {
      waitUntil: "domcontentloaded",
      timeout: 40000,
    });

    const inputSelector =
      "input.input, input[placeholder*='WePlay ID' i], input[type='text']";

    await page.waitForSelector(inputSelector, { timeout: 40000 });

    const input = await page.$(inputSelector);
    if (!input) throw new Error("input_not_found");

    await input.click({ clickCount: 3 });

    await page.evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, input);

    await input.type(uid, { delay: 30 });

    await page.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, key: "Enter" })
      );
    }, input);

    const clicked = await page.evaluate(() => {
      const xpaths = [
        "//button[contains(.,'Search')]",
        "//button[contains(.,'Lookup')]",
        "//button[contains(.,'Submit')]",
        "//button[contains(.,'Confirm')]",
        "//button[contains(.,'Check')]",
        "//div[contains(@class,'submit')]",
        "//div[contains(@class,'search')]",
        "//span[contains(@class,'submit')]",
        "//button[@type='submit']",
      ];

      for (const xp of xpaths) {
        const r = document.evaluate(
          xp,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        const el = r.singleNodeValue;
        if (el && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) {
      await input.press("Enter");
    }

    await page.waitForFunction(
      () => {
        const nick = document.querySelector(".nickname");
        const val = document.querySelector(".value");
        return (
          nick &&
          nick.textContent.trim().length > 0 &&
          val &&
          val.textContent.trim().length > 0
        );
      },
      { timeout: 40000 }
    );

    const result = await page.evaluate(() => {
      const out = {
        nickname: "",
        charm: "",
        profile_pic_url: "",
      };

      const nickEl = document.querySelector(".nickname");
      if (nickEl) out.nickname = nickEl.textContent.trim();

      const valEl = document.querySelector(".value");
      if (valEl) {
        const raw = valEl.textContent.trim();
        const m = raw.match(/Charm\s*:\s*([\d,]+)/i);
        out.charm = m
          ? m[1].replace(/,/g, "")
          : raw.replace(/^Charm\s*:\s*/i, "").trim();
      }

      const avatarImg = document.querySelector("img.avatar");
      if (avatarImg) {
        out.profile_pic_url = avatarImg.currentSrc || avatarImg.src || "";
      }

      if (!out.profile_pic_url) {
        for (const img of document.images) {
          const s = img.currentSrc || img.src || "";
          if (/^https?:\/\/picuser[^/]*\.weplayapp\.com\//i.test(s)) {
            out.profile_pic_url = s;
            break;
          }
        }
      }

      return out;
    });

    if (!result.nickname && !result.charm && !result.profile_pic_url) {
      throw new Error("result_not_found");
    }

    return result;
  } finally {
    await browser.close();
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const query = req.query || {};

  if (req.method === "GET" && !query.uid) {
    return res.status(200).json({
      ok: true,
      service: "WePlay UID Lookup",
    });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  let uid = "";

  if (req.method === "GET") {
    uid = String(query.uid || "").trim();
  } else {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};
    uid = String(body.uid || "").trim();
  }

  if (!/^\d{5,}$/.test(uid)) {
    return res.status(400).json({
      success: false,
      error: "Invalid UID",
    });
  }

  const t0 = Date.now();
  const cached = cacheGet(uid);

  if (cached) {
    return res.status(200).json({
      success: true,
      uid,
      nickname: cached.nickname,
      charm: cached.charm || "",
      profile_pic_url: cached.profile_pic_url || null,
      cached: true,
      took_ms: Date.now() - t0,
    });
  }

  try {
    const data = await scrapeWePlay(uid);
    cacheSet(uid, data);

    return res.status(200).json({
      success: true,
      uid,
      nickname: data.nickname,
      charm: data.charm || "",
      profile_pic_url: data.profile_pic_url || null,
      cached: false,
      took_ms: Date.now() - t0,
    });
  } catch (err) {
    const isTimeout =
      err &&
      (err.name === "TimeoutError" || /timeout/i.test(err.message || ""));

    return res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout ? "Timeout fetching UID" : "Failed to fetch UID",
      details: err && err.message ? err.message : String(err),
    });
  }
};