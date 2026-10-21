// @ts-nocheck -- TV-only ES5 that reads the global `tizen`, which has no types here.
// The only setting: where the TV goes. Plain ES5 on purpose, so this page
// runs on any Tizen engine. It lives in its own file because the TV's default
// CSP (script-src 'self') refuses inline scripts.
var READER_URL = "https://comic-reader-eta.vercel.app/";
var DELAY_MS = 5000;
// The Smart Hub Preview service (tizen/service/service.js, id in config.xml).
var SERVICE_ID = "CmcRdrTV01.ComicReaderService";
// How long to wait for launchAppControl's callbacks before going anyway.
var SERVICE_WAIT_MS = 3000;

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

// A preview tile's action_data arrives as the PAYLOAD entry. Samsung's
// guide wraps it: value[0] is '{"values":"<action_data>"}', so unwrap that
// when present and accept the bare action_data too.
var payloadPath = null;
var payloadNote = "none";
try {
  var req = tizen.application.getCurrentApplication().getRequestedAppControl();
  var data = (req && req.appControl && req.appControl.data) || [];
  for (var i = 0; i < data.length; i++) {
    if (data[i].key !== "PAYLOAD") continue;
    payloadNote = "unreadable: " + data[i].value[0];
    var parsed = JSON.parse(data[i].value[0]);
    if (parsed && typeof parsed.values === "string")
      parsed = JSON.parse(parsed.values);
    if (
      parsed &&
      typeof parsed.path === "string" &&
      parsed.path.charAt(0) === "/"
    ) {
      payloadPath = parsed.path;
      payloadNote = payloadPath;
    }
  }
} catch (e) {
  payloadNote += " (error: " + e.message + ")";
}
var target = payloadPath
  ? READER_URL + payloadPath.slice(1) // READER_URL already ends in "/"
  : READER_URL;

var serviceNote = "starting";
var debug = document.getElementById("debug");
function render() {
  if (!debug) return;
  debug.textContent =
    "userAgent: " +
    ua +
    "\nChrome: " +
    (chrome ? chrome[1] : "not found") +
    "\ntypeof tizen: " +
    tizenType +
    "\ntizen.tvinputdevice: " +
    hasInput +
    "\npayload path: " +
    payloadNote +
    "\npreview service: " +
    serviceNote +
    "\ntarget: " +
    target +
    (payloadPath
      ? "\n\nOpening now."
      : "\n\nOpening in 5 s. Press Enter to go now.");
}
render();

// Leave only once the pause is over (none with a payload) and the service
// launch has answered, so the page doesn't unload before the service starts.
var paused = !payloadPath;
var launched = false;
var gone = false;
function go() {
  if (gone || paused || !launched) return;
  gone = true;
  location.replace(target);
}
function serviceDone(note) {
  if (launched) return;
  launched = true;
  serviceNote = note;
  render();
  go();
}

try {
  tizen.application.launchAppControl(
    new tizen.ApplicationControl(
      "http://tizen.org/appcontrol/operation/pick",
      null,
      "image/jpeg",
      null,
      [new tizen.ApplicationControlData("caller", ["ForegroundApp"])],
    ),
    SERVICE_ID,
    function () {
      serviceDone("launched");
    },
    function (e) {
      serviceDone("failed: " + e.message);
    },
  );
} catch (e) {
  serviceDone("threw: " + e.message);
}
setTimeout(function () {
  serviceDone("no callback after " + SERVICE_WAIT_MS / 1000 + " s");
}, SERVICE_WAIT_MS);

function endPause() {
  paused = false;
  go();
}
if (paused) setTimeout(endPause, DELAY_MS);
document.addEventListener("keydown", function (e) {
  if (e.keyCode === 13) endPause();
});
