/**
 * OCR viewer HTML generator
 */

import fs from "fs-extra";
import { join } from "path";
import type { RoboflowPrediction } from "./roboflow.js";

export interface OCRPrediction extends RoboflowPrediction {
  index: number;
  ocr_text: string;
  cropPath?: string;
}

/**
 * Create HTML viewer for OCR crops and text
 */
export async function createOCRViewer(
  pageName: string,
  predictions: OCRPrediction[],
  ocrCropsDir: string,
): Promise<string> {
  // Convert absolute paths to relative paths for HTML
  const relativeCropPath = (p: OCRPrediction) => {
    if (!p.cropPath) return "";
    const fileName = p.cropPath.split("/").pop() ?? "";
    return `./${fileName}`;
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OCR Results - ${pageName}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 {
      color: #333;
      border-bottom: 3px solid #4CAF50;
      padding-bottom: 10px;
    }
    .prediction {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      display: grid;
      grid-template-columns: 300px 1fr;
      gap: 20px;
      align-items: start;
    }
    .prediction img {
      width: 100%;
      height: auto;
      border: 2px solid #ddd;
      border-radius: 4px;
      background: #fafafa;
    }
    .prediction-info {
      display: flex;
      flex-direction: column;
    }
    .prediction-header {
      font-weight: bold;
      color: #666;
      font-size: 14px;
      margin-bottom: 10px;
    }
    .ocr-text {
      background: #f9f9f9;
      border-left: 4px solid #4CAF50;
      padding: 15px;
      margin: 10px 0;
      font-family: 'Courier New', monospace;
      white-space: pre-wrap;
      word-wrap: break-word;
      border-radius: 4px;
    }
    .coordinates {
      font-size: 12px;
      color: #999;
      margin-top: 10px;
    }
    .empty {
      color: #999;
      font-style: italic;
    }
  </style>
</head>
<body>
  <h1>OCR Results - ${pageName}</h1>
  <p>Total predictions: ${predictions.length}</p>
  
  ${predictions
    .map(
      (p, idx) => `
  <div class="prediction">
    <div>
      <img src="${relativeCropPath(p)}" 
           alt="Crop ${idx + 1}" 
           onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'300\\' height=\\'200\\'%3E%3Ctext x=\\'50%25\\' y=\\'50%25\\' text-anchor=\\'middle\\'%3EImage not found%3C/text%3E%3C/svg%3E'">
    </div>
    <div class="prediction-info">
      <div class="prediction-header">Prediction #${idx + 1}</div>
      <div class="coordinates">
        Position: x=${Math.floor(p.x)}, y=${Math.floor(p.y)}, 
        w=${Math.floor(p.width)}, h=${Math.floor(p.height)}
      </div>
      <div class="ocr-text">${(p.ocr_text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "<span class='empty'>No text detected</span>"}</div>
    </div>
  </div>
  `,
    )
    .join("\n")}
</body>
</html>`;

  const htmlPath = join(ocrCropsDir, pageName, "viewer.html");
  await fs.writeFile(htmlPath, html);
  return htmlPath;
}
