# **Technical Spec: Script 1 (npm run get-context)**

## **1. Overview**

This script performs the "Discovery Pass" on a comic book issue. It uses a local Node.js environment to orchestrate a multi-model AI pipeline. Its primary goal is to identify every text region on a page, deduplicate overlapping detections, transcribe the text, and determine the semantic context (speaker, emotion, or if it should be ignored).

**Architecture Pattern:** "Detector (Roboflow) + Deduplicator + Classifier (Gemini)"

## **2. Inputs & Prerequisites**

### **Filesystem**

- **Input Directory:** comics/tmnt-mmpr-iii/issue-1/pages (Contains page-01.jpg, page-02.jpg, etc.)
- **Output File:** scripts/context-cache.json (JSON Map of page data)

### **Environment Variables (.env)**

- ROBOFLOW_API_KEY: Your private API key.
- ROBOFLOW_WORKFLOW_URL: https://serverless.roboflow.com/fresh-space/workflows/comic-text-finder
- GEMINI_API_KEY: Your Google AI Studio API key.

## **3. Core Libraries (Tech Stack)**

- **File System:** fs-extra (for robust file operations)
- **Image Processing:** sharp (High-performance Node.js image library for cropping/resizing)
- **OCR:** gemini-2.5-flash
- **Context AI:** @google/genai (Google GenAI SDK v3)
- **Utilities:** @t3-oss/env-nextjs (env vars, use ~/src/env.mjs), glob (pattern matching files)
- **HTTP Client:** Native fetch (Node.js 18+)

## **4. Execution Logic (Step-by-Step)**

### **Step 1: Initialization**

1. Load environment variables.
2. Initialize the Gemini client.
3. Get list of all .jpg files in the input directory.
4. Load existing context-cache.json (if any) to support resuming.

### **Step 2: The Page Loop**

For each pagePath in the list:

1. **Read Image:** Load the full page into a Buffer.
2. **Roboflow API (Detector):**
   - Convert image buffer to Base64 string.
   - **POST** request to ROBOFLOW_WORKFLOW_URL.
   - **Headers:** Content-Type: application/json
   - **Body:**  
     {  
      "api_key": env.ROBOFLOW_API_KEY,  
      "inputs": {  
      "image": {  
      "type": "base64",  
      "value": base64String  
      }  
      }  
     }

   - **Result:** Extract the predictions array from the JSON response.

### **Step 3: Deduplication & Filtering (New)**

Before processing, clean up the raw predictions from Roboflow.

1. **Spatial Deduplication:**
   - Loop through predictions. If two boxes are nearly identical (e.g., x, y, width, height match within a 5% tolerance), discard the one with lower confidence.
2. **Initial OCR Pass:**
   - Run OCR through Gemini 2.5 Flash on all remaining boxes.
   - Store the ocr_text on the object.
3. **Text Deduplication:**
   - If two overlapping boxes have the exact same (or substring) ocr_text (e.g., "HELP" and "HELP!"), discard the smaller/less confident box.
4. **Empty Filter:**
   - Discard any box where ocr_text is empty, whitespace, or a single character (unless it's "I" or "A").

### **Step 4: Context Analysis (Gemini API)**

For each remaining unique bubble:

1. **Input Payload:**
   - image: The **Full Page** buffer (base64).
   - target_text: The ocr_text from Step 3.
   - target_location: The coordinates [x, y, w, h].
2. **Prompt (The "Classifier"):**"I am providing a comic book page. Focus on the text region containing: '{target_text}' located at {target_location}.
   1. **Classify the Type:**
      - `SPEECH`: Character dialogue.
      - `NARRATION`: Storytelling boxes.
      - `CAPTION`: Floating structural text (e.g., "The End", "New York City").
      - `SFX`: Sound effects (BOOM, POW).
      - `BACKGROUND`: Text in the art that is NOT meant to be read aloud (e.g., a sign on a building, a license plate, a newspaper headline, graffiti).

   2. **Identify the Speaker:**
      - If SPEECH: Identify the character.
      - If NARRATION/CAPTION: Return 'Narrator'.
      - If SFX or BACKGROUND: Return null.

   3. **Determine Emotion:** (e.g., 'angry', 'neutral', 'shouting').

Return JSON only: { 'type': '...', 'speaker': '...', 'emotion': '...' }"

### **Step 5: Aggregation & Saving**

1. **Filter:** If Gemini returns type: 'BACKGROUND' or type: 'SFX', **do not** add this bubble to the final list (or mark it as ignored: true).
2. Push valid objects to the page's array in the cache.
3. **Save:** Write context-cache.json to disk.

## **5. Data Structure Example (Output)**

{  
 "page-03.jpg": [
 {
 "id": "p03_b01",
 "box_2d": { "x": 450, "y": 300, "width": 200, "height": 100 },
 "ocr_text": "Cowabunga!",
 "type": "SPEECH",
 "speaker": "Michelangelo",
 "emotion": "excited"
 }
 // Note: SFX and Background signs are excluded from this list
 ]  
}
