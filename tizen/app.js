// @ts-nocheck -- TV-only ES5 that reads the global `tizen`, which has no types here.
// The only setting: where the TV goes. Plain ES5 on purpose, so this page
// runs on any Tizen engine. It lives in its own file because the TV's default
// CSP (script-src 'self') refuses inline scripts.
var READER_URL = "https://comic-reader-eta.vercel.app/";
var DELAY_MS = 5000;

// The TV has no console, so this block is the only on-screen diagnostics.
// The 5 s pause is there so it can be read or photographed.
var ua = navigator.userAgent || "";
// Tizen 9 drops the "Chrome/" token: "(KHTML, like Gecko) 120.0.6099.5/9.0 TV".
var chrome =
  ua.match(/(?:Chrome|Chromium)\/([0-9.]+)/) ||
  ua.match(/Gecko\) ([0-9]+\.[0-9.]+)\//);
var tizenType = "error";
var hasInput = "error";
try {
  tizenType = typeof tizen;
  hasInput =
    typeof tizen !== "undefined" && !!tizen.tvinputdevice ? "yes" : "no";
} catch (e) {
  tizenType = "error: " + e;
}

var debug = document.getElementById("debug");
if (debug)
  debug.textContent =
    "userAgent: " +
    ua +
    "\nChrome: " +
    (chrome ? chrome[1] : "not found") +
    "\ntypeof tizen: " +
    tizenType +
    "\ntizen.tvinputdevice: " +
    hasInput +
    "\ntarget: " +
    READER_URL +
    "\n\nOpening in 5 s. Press Enter to go now.";

var gone = false;
function go() {
  if (gone) return;
  gone = true;
  location.replace(READER_URL);
}
setTimeout(go, DELAY_MS);
document.addEventListener("keydown", function (e) {
  if (e.keyCode === 13) go();
});
