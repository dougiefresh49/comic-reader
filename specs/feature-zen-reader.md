# **Feature Spec: Immersive "Zen" Reader Layout**

## **1\. Design Philosophy**

"Content First."  
The interface should mimic the Kindle or generic e-reader experience. The UI chrome (headers, sidebars, debug logs) must be removed or hidden, leaving only the comic page visible. Controls are consolidated into a unobtrusive, docked "Heads-Up Display" (HUD) at the bottom.

## **2\. Visual Layout**

### **A. The Stage (Viewport)**

* **Background:** Deep Black (\#000000) or very dark gray (\#121212) to blend with comic borders.  
* **Image Sizing:** The comic page should fit within the viewport (max-height: 100vh, max-width: 100vw) while maintaining aspect ratio.  
* **Centering:** Flexbox or Grid centering to ensure the page is always in the middle.

### **B. The Active Bubble Highlight**

* **Visual:** A distinct, high-contrast outline around the currently speaking bubble.  
* **Implementation:** An absolute-positioned \<div\> or SVG overlay on top of the image.  
* **Style:** \* border: 3px solid \#00E5FF (Cyan) or \#FFD700 (Gold) for visibility.  
  * box-shadow: 0 0 10px rgba(0, 229, 255, 0.5) (Glow effect).  
  * transition: all 0.3s ease (Smooth movement between bubbles).

### **C. The Bottom Control Bar (The Dock)**

A floating or fixed bar at the bottom of the screen (position: fixed; bottom: 0;).

**Elements (Left to Right):**

1. **Exit/Home:** returns to the Library/Collection view.  
2. **Grid/Pages:** Opens the page selector overlay.  
3. **Active Text Display (The "Subtitle" Box):** \* A central container displaying the text of the currently playing audio.  
   * *Why:* Helps accessibility and clarity if the bubble text is small.  
4. **Auto-Play Toggle:** \* A toggle switch or icon indicating if the app will automatically proceed to the next bubble after the current one finishes.  
5. **Navigation (Optional):** Small Next/Prev arrows (if swipe isn't implemented yet).

## **3\. Interaction Logic**

### **Bubble Playback State**

* **Manual Mode:** User taps a specific bubble \-\> Audio plays \-\> Highlight moves to that bubble \-\> Stops when done.  
* **Auto Mode:** User taps first bubble \-\> Audio plays \-\> Highlight moves \-\> Audio finishes \-\> **System waits x seconds** \-\> System triggers next bubble automatically.

### **Page Navigation**

* **Tap Left/Right Edges:** Go to Prev/Next page (Kindle style).  
* **Grid Button:**  
  * Triggers a full-screen modal with thumbnails of all pages.  
  * Clicking a thumbnail jumps to that page.

## **4\. Technical Requirements (Frontend)**

* **Z-Index Management:**  
  * Level 1: Comic Image.  
  * Level 2: Bubble Highlight Overlay.  
  * Level 3: Bottom Control Bar.  
  * Level 4: Page Grid Modal.  
* **State Management:**  
  * isPlaying (bool)  
  * autoPlayEnabled (bool)  
  * currentBubbleIndex (number)  
  * isControlBarVisible (bool) \- *Optional: Allow hiding the bar on tap.*