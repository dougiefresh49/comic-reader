// Apple Vision word boxes for comic pages (#61). Free and local, macOS only.
//
// Usage: swift scripts/vision/ocr-page.swift <image> [<image> ...]
//
// Prints one JSON array to stdout, one entry per image in argument order:
//   { "engine": "apple-vision@<macOS version>",
//     "image": { "w": 1988, "h": 3057, "sha": "<sha256 of the file bytes>" },
//     "lines": [{ "box": [x,y,w,h], "words": [{ "t": "GREATER", "box": [x,y,w,h], "conf": 1 }] }] }
// Boxes are page-normalized with a top-left origin, rounded to 4 decimals.
// Word conf is the line candidate's confidence. ImageIO reads WebP directly.

import CryptoKit
import Foundation
import ImageIO
import Vision

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("ocr-page.swift: \(message)\n".utf8))
  exit(1)
}

func r4(_ value: CGFloat) -> Double {
  (Double(value) * 10000).rounded() / 10000
}

// Vision rects have a bottom-left origin; flip to top-left.
func topLeftBox(_ rect: CGRect) -> [Double] {
  [r4(rect.minX), r4(1 - rect.maxY), r4(rect.width), r4(rect.height)]
}

let paths = Array(CommandLine.arguments.dropFirst())
if paths.isEmpty { fail("usage: swift scripts/vision/ocr-page.swift <image> [<image> ...]") }

let os = ProcessInfo.processInfo.operatingSystemVersion
let engine = "apple-vision@\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"

var pages: [[String: Any]] = []
for path in paths {
  guard let data = FileManager.default.contents(atPath: path) else { fail("cannot read \(path)") }
  guard
    let source = CGImageSourceCreateWithData(data as CFData, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { fail("cannot decode \(path)") }
  let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  } catch {
    fail("Vision failed on \(path): \(error.localizedDescription)")
  }

  var lines: [[String: Any]] = []
  for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let text = candidate.string
    let conf = r4(CGFloat(candidate.confidence))
    var words: [[String: Any]] = []
    text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) {
      word, range, _, _ in
      guard let word, let box = try? candidate.boundingBox(for: range)?.boundingBox else { return }
      words.append(["t": word, "box": topLeftBox(box), "conf": conf])
    }
    lines.append(["box": topLeftBox(observation.boundingBox), "words": words])
  }

  pages.append([
    "engine": engine,
    "image": ["w": image.width, "h": image.height, "sha": sha],
    "lines": lines,
  ])
}

do {
  let json = try JSONSerialization.data(withJSONObject: pages, options: [.sortedKeys, .withoutEscapingSlashes])
  FileHandle.standardOutput.write(json)
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
  fail("cannot encode JSON: \(error.localizedDescription)")
}
