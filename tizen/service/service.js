// @ts-nocheck -- TV-only ES5 for the Tizen service runtime (Node), which reads the globals `tizen` and `webapis`.
// Smart Hub Preview test (#980 Part 1): one hardcoded section, so a missing
// tile on the home bar means the TV shows no previews, not that a fetch
// failed. The tile titles carry the result of one fetch to the reader's
// host, because Part 2 needs the service to reach it.
// Samsung's guide: HTTP from a service must go through Node, not XHR.
var https = require("https");

var PROBE_URL = "https://comic-reader-eta.vercel.app/logo.png";
var TIMEOUT_MS = 10000;
var ACTION_DATA = JSON.stringify({ path: "/book/tmnt-mmpr-iii/issue-1/4" });
// tmnt-mmpr-iii issue-1 page 1, scaled to the tiles' fixed 250 px height.
// The guide shows only https image URLs, and Supabase Storage here has no
// resizing, so one tile uses a proxy that returns a 250 px JPG.
var HTTPS_COVER =
  "https://wsrv.nl/?url=sinmmbxrsbpjneccykwd.supabase.co/storage/v1/object/public/comic-pages/tmnt-mmpr-iii/issue-1/page-01.webp&h=250&output=jpg";
// The same image packaged in the .wgt. The guide doesn't say whether a
// local image_url works; this tile answers that.
var LOCAL_COVER =
  typeof __dirname === "string" ? "file://" + __dirname + "/cover.jpg" : "";

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
  var title = "Fetch: " + result;
  var httpsTile = tile(title, "https cover, by " + caller, HTTPS_COVER);
  var tiles = [httpsTile];
  if (LOCAL_COVER) tiles.push(tile(title, "packaged cover", LOCAL_COVER));
  console.log("setPreviewData: " + result + ", caller " + caller);
  // Exit after the last callback either way: a service that doesn't exit is
  // killed after 5 minutes, and Samsung wants 10 minutes between calls.
  send(tiles, function (err) {
    if (!err) {
      console.log("setPreviewData ok, " + tiles.length + " tiles");
      return exit();
    }
    console.log("setPreviewData failed: " + err);
    if (tiles.length === 1) return exit();
    // If the local image_url is what got the data refused, one retry without
    // it keeps the test from reading as "this TV shows no previews".
    httpsTile.subtitle = "local tile refused: " + err;
    send([httpsTile], function (retryErr) {
      console.log("retry: " + (retryErr || "ok"));
      exit();
    });
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
