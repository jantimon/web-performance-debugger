import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBotWall, botWallRefusalMessage } from "../../dist/record/bot-wall.js";

// The classifier runs over SYNTHETIC signal structs -- no browser, no live site. It is deliberately
// conservative: it keys on the RENDERED interstitial, never on the mere presence of a captcha script,
// so a normal shop embedding reCAPTCHA/hCaptcha in a form must not trip it.

const base = () => ({
  mainDocumentUrl: "https://shop.example/",
  title: "Shop — best deals",
  dominantIframeSrcs: [],
  iframeSrcs: [],
  interactiveElementCount: 120,
  bodyTextLength: 8000,
  metaRefreshUrl: null,
});

test("Cloudflare 'Just a moment' (challenge iframe + title) is detected via two weak signals", () => {
  const verdict = classifyBotWall({
    ...base(),
    title: "Just a moment...",
    interactiveElementCount: 1,
    bodyTextLength: 40,
    iframeSrcs: ["https://challenges.cloudflare.com/turnstile/v0/g/abc/api.js"],
  });
  assert.equal(verdict.detected, true);
  assert.ok(verdict.vendors.some((entry) => entry.includes("Cloudflare Turnstile")));
  assert.ok(verdict.firedSignals.some((signal) => /Just a moment/i.test(signal)));
});

test("DataDome interstitial (dominant challenge iframe) is detected via one strong signal", () => {
  const src = "https://geo.captcha-delivery.com/interstitial/?cid=abc";
  const verdict = classifyBotWall({
    ...base(),
    title: "",
    interactiveElementCount: 0,
    bodyTextLength: 0,
    iframeSrcs: [src],
    dominantIframeSrcs: [src],
  });
  assert.equal(verdict.detected, true);
  assert.ok(verdict.firedSignals.some((signal) => /dominant full-viewport iframe/.test(signal)));
  assert.ok(verdict.vendors.some((entry) => entry.includes("DataDome")));
});

test("main document on a Cloudflare challenge URL is a strong signal", () => {
  const verdict = classifyBotWall({
    ...base(),
    mainDocumentUrl: "https://www.ricardo.ch/?__cf_chl_rt_tk=abc-123",
    title: "",
    interactiveElementCount: 0,
    bodyTextLength: 0,
  });
  assert.equal(verdict.detected, true);
  assert.ok(verdict.firedSignals.some((signal) => /challenge marker/.test(signal)));
});

test("FALSE POSITIVE GUARD: a full shop page embedding reCAPTCHA does NOT trip", () => {
  const verdict = classifyBotWall({
    ...base(),
    iframeSrcs: ["https://www.google.com/recaptcha/api2/anchor?k=abc"],
    dominantIframeSrcs: [],
  });
  assert.equal(verdict.detected, false, "reCAPTCHA is not in the challenge-host list at all");
  assert.deepEqual(verdict.firedSignals, []);
});

test("FALSE POSITIVE GUARD: a full DOM with one non-dominant hCaptcha (one weak signal) does NOT trip", () => {
  const verdict = classifyBotWall({
    ...base(),
    title: "Login — Shop",
    interactiveElementCount: 30,
    bodyTextLength: 4000,
    iframeSrcs: ["https://newassets.hcaptcha.com/captcha/v1/frame"],
  });
  assert.equal(verdict.detected, false, "one weak signal (a non-dominant challenge iframe) is below the 2-weak threshold");
});

test("FALSE POSITIVE GUARD: a plain near-empty page with no challenge widget does NOT trip", () => {
  const verdict = classifyBotWall({
    ...base(),
    title: "",
    interactiveElementCount: 0,
    bodyTextLength: 10,
  });
  assert.equal(verdict.detected, false);
});

test("refusal message lists the signals, the screenshot path, and the skip flag; never suggests bypassing", () => {
  const verdict = {
    detected: true,
    firedSignals: ["dominant full-viewport iframe from challenges.cloudflare.com (Cloudflare Turnstile)"],
    vendors: ["challenges.cloudflare.com (Cloudflare Turnstile)"],
  };
  const message = botWallRefusalMessage(verdict, "/tmp/out.wall.png");
  assert.ok(message.includes("challenges.cloudflare.com"), "names the origin");
  assert.ok(message.includes("/tmp/out.wall.png"), "names the screenshot path");
  assert.ok(message.includes("--allow-bot-wall"), "points at the skip flag");
  assert.ok(/does not bypass|refuses/i.test(message), "states refusal, never a bypass");
  const noShot = botWallRefusalMessage(verdict, null);
  assert.ok(/could not be captured/i.test(noShot), "honest when no screenshot was saved");
});
