// @ts-nocheck -- TV-only ES5 for the Tizen service runtime (Node), which reads the globals `tizen` and `webapis`.
// Smart Hub Preview test (#980 Part 1): one hardcoded section, so a missing
// tile on the home bar means the TV shows no previews, not that a fetch
// failed. The tile title carries the result of one fetch to the reader's
// host, because Part 2 needs the service to reach it.
// Samsung's guide: HTTP from a service must go through Node, not XHR.
var https = require("https");

var PROBE_URL = "https://comic-reader-eta.vercel.app/logo.png";
var TIMEOUT_MS = 10000;
var ACTION_DATA = JSON.stringify({ path: "/book/tmnt-mmpr-iii/issue-1/4" });
// tmnt-mmpr-iii issue-1 page 1 at 167x250, the smallest size Samsung allows
// for a 2by3 tile (167x250 to 240x360). Supabase Storage here has no
// resizing and the covers are WebP, so the tile goes through an image proxy.
var COVER_URL =
  "https://wsrv.nl/?url=sinmmbxrsbpjneccykwd.supabase.co/storage/v1/object/public/comic-pages/tmnt-mmpr-iii/issue-1/page-01.webp&w=167&h=250&fit=cover&output=jpg";

var running = false;

// Who launched us: the launcher passes caller=ForegroundApp; the system's
// own relaunch (about every 10 minutes) passes nothing we know of.
function launchedBy() {
  try {
    var req = tizen.application
      .getCurrentApplication()
      .getRequestedAppControl();
    var data = (req && req.appControl && req.appControl.data) || [];
    for (var i = 0; i < data.length; i++) {
      if (data[i].key === "caller") return String(data[i].value[0]);
    }
  } catch (e) {
    return "error: " + e.message;
  }
  return "system";
}

// Calls back exactly once: with "HTTP <status>", the error text, or a timeout.
function probe(callback) {
  var finished = false;
  function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    callback(result);
  }
  var timer = setTimeout(function () {
    finish("timeout after " + TIMEOUT_MS / 1000 + " s");
  }, TIMEOUT_MS);
  try {
    var req = https.get(PROBE_URL, function (res) {
      // Only the status matters; drain the body so the socket closes.
      res.resume();
      finish("HTTP " + res.statusCode);
    });
    req.on("error", function (e) {
      finish("error: " + e.message);
    });
    req.setTimeout(TIMEOUT_MS, function () {
      req.abort();
    });
  } catch (e) {
    finish("error: " + e.message);
  }
}

function tile(title, subtitle, imageUrl) {
  return {
    title: title,
    subtitle: subtitle,
    image_ratio: "2by3",
    image_url: imageUrl,
    // A string holding JSON, as in Samsung's samples; the launcher reads it
    // back from the PAYLOAD app-control entry.
    action_data: ACTION_DATA,
    is_playable: false,
  };
}

function exit() {
  try {
    tizen.application.getCurrentApplication().exit();
  } catch (e) {
    console.log("exit failed: " + e.message);
  }
}

// Calls back with null on success, or the error text.
function send(tiles, callback) {
  var data = {
    sections: [{ title: "Comic Reader preview test", tiles: tiles }],
  };
  try {
    webapis.preview.setPreviewData(
      JSON.stringify(data),
      function () {
        callback(null);
      },
      function (e) {
        callback(e.message || String(e));
      },
    );
  } catch (e) {
    callback("threw: " + e.message);
  }
}

function setPreview(result, caller) {
  var tiles = [tile("Fetch: " + result, "launched by " + caller, COVER_URL)];
  console.log("setPreviewData: " + result + ", caller " + caller);
  // Exit after the callback either way: a service that doesn't exit is
  // killed after 5 minutes, and Samsung wants 10 minutes between calls.
  send(tiles, function (err) {
    console.log("setPreviewData " + (err ? "failed: " + err : "ok"));
    exit();
  });
}

module.exports.onStart = function () {
  console.log("service start");
};

module.exports.onRequest = function () {
  if (running) return;
  running = true;
  var caller = launchedBy();
  probe(function (result) {
    setPreview(result, caller);
  });
};

module.exports.onExit = function () {
  console.log("service exit");
};
