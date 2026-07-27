// wpd launches Chrome's built-in headless (full Chrome, windowless) or a headed window, never
// chrome-headless-shell, so skip that binary's download on this repo's own installs (dev + CI).
//
// This file is NOT published (package.json "files" ships only dist/README/LICENSE): puppeteer reads
// its config from the project whose install is running, walking up from that project's cwd, so a
// config buried in a consumer's node_modules/@jantimon/web-performance-debugger never reaches their
// puppeteer install. A consumer who wants to skip the same download sets the env var (see README).
module.exports = {
  "chrome-headless-shell": { skipDownload: true },
};
