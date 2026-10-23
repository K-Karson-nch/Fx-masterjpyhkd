"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const MC_PAGE = "https://www.mastercard.com/global/en/personal/get-support/currency-exchange-rate-converter.html";
const MC_API_PATH = "/marketingservices/public/mccom-services/currency-conversions/conversion-rates";
const OUTPUT = path.join(__dirname, "..", "rates.json");
const PAIRS = [
  ["JPY", "HKD", "JPY_HKD"],
  ["HKD", "JPY", "HKD_JPY"]
];

function browserCandidates() {
  const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  return [
    process.env.CHROME_PATH,
    path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
    localAppData ? path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe") : "",
    path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
}

function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (error) {}
  }
  return null;
}

async function openMastercardPage(page) {
  let response;
  try {
    response = await page.goto(MC_PAGE, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (error) {
    response = await page.goto(MC_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  if (!response || response.status() !== 200) {
    throw new Error("Mastercard page returned HTTP " + (response ? response.status() : "no response"));
  }

  const title = await page.title();
  if (/access denied/i.test(title)) {
    throw new Error("Mastercard blocked the automated browser");
  }

  let apiPath = MC_API_PATH;
  try {
    await page.waitForSelector("#currencyConversionUrl", { timeout: 15000 });
    const discovered = await page.evaluate(function () {
      const el = document.querySelector("#currencyConversionUrl");
      return el ? el.getAttribute("data-cmp-url") : null;
    });
    if (discovered && discovered.charAt(0) === "/") apiPath = discovered;
  } catch (error) {}

  await new Promise(function (resolve) { setTimeout(resolve, 2500); });
  return apiPath;
}

async function pageFetch(page, apiPath, query) {
  return page.evaluate(async function (target, search) {
    try {
      const response = await fetch(target + "?" + search, {
        headers: { Accept: "application/json, text/plain, */*" },
        cache: "no-store",
        credentials: "same-origin"
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { status: 0, body: String(error) };
    }
  }, apiPath, query);
}

async function fetchRate(page, apiPath, from, to) {
  const query = new URLSearchParams({
    exchange_date: "0000-00-00",
    transaction_currency: from,
    cardholder_billing_currency: to,
    bank_fee: "0",
    transaction_amount: "1"
  }).toString();

  let result = await pageFetch(page, apiPath, query);

  if (result.status === 0 || result.status === 403 || result.status === 429) {
    apiPath = await openMastercardPage(page);
    result = await pageFetch(page, apiPath, query);
  }

  if (result.status !== 200) {
    throw new Error("Mastercard API returned HTTP " + result.status + " for " + from + " to " + to);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch (error) {
    throw new Error("Mastercard API returned invalid JSON for " + from + " to " + to);
  }

  const data = parsed && parsed.data ? parsed.data : null;
  if (!data) throw new Error("Mastercard API returned no data for " + from + " to " + to);
  if (data.errorCode) throw new Error(data.errorMessage || "Mastercard API error " + data.errorCode);
  if (data.transCurr && data.transCurr !== from) throw new Error("Unexpected transaction currency");
  if (data.crdhldBillCurr && data.crdhldBillCurr !== to) throw new Error("Unexpected billing currency");

  const rate = Number(data.conversionRate);
  if (!isFinite(rate) || rate <= 0) throw new Error("Mastercard API returned no usable rate");

  return { rate: rate, date: data.fxDate || null };
}

function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
  } catch (error) {
    return null;
  }
}

function sameRates(a, b) {
  if (!a || !b) return false;
  return PAIRS.every(function (pair) {
    const left = a.rates && a.rates[pair[2]];
    const right = b.rates && b.rates[pair[2]];
    return left && right &&
      Number(left.rate) === Number(right.rate) &&
      (left.date || null) === (right.date || null);
  });
}

async function main() {
  const executablePath = findBrowser();
  if (!executablePath) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH if needed.");
  }

  console.log("Browser: " + executablePath);
  const browser = await puppeteer.launch({
    executablePath: executablePath,
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 90000,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
      "--mute-audio",
      "--lang=en-US"
    ]
  });

  try {
    const version = await browser.version();
    const match = version.match(/(\d+)/);
    const major = match ? match[1] : "131";
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Safari/537.36";

    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    const apiPath = await openMastercardPage(page);
    const rates = {};

    for (const pair of PAIRS) {
      const result = await fetchRate(page, apiPath, pair[0], pair[1]);
      rates[pair[2]] = result;
      console.log(pair[0] + " -> " + pair[1] + ": " + result.rate + " (" + (result.date || "date unavailable") + ")");
    }

    const next = {
      updatedAt: new Date().toISOString(),
      source: "mastercard",
      page: MC_PAGE,
      rates: rates
    };

    const existing = readExisting();
    if (sameRates(existing, next)) {
      console.log("Rates are unchanged. Leaving rates.json untouched.");
      return;
    }

    fs.writeFileSync(OUTPUT, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log("Wrote " + OUTPUT);
  } finally {
    await browser.close();
  }
}

main().catch(function (error) {
  console.error("Failed to update rates: " + error.message);
  process.exitCode = 1;
});
