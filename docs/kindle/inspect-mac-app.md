The screenshot you’ve shared (@docs/kindle/kindle-app--package-contents.png) confirms this is a **native macOS app** (likely written in Objective-C or Swift using AppKit/Cocoa), which is a completely different beast from the React-based or legacy Windows versions.

Since you’re building your own AI-driven comic reader, here is the technical breakdown of how Amazon handles Guided View compared to your approach:

### 1. The Tech Stack: "Classic" Native

The file extensions in your `Resources` folder tell the story:

- **`.momd` (Managed Object Model Directory):** These are compiled **Core Data** models. The app uses Apple's native database framework to manage your library. `BookData.momd` likely handles the metadata for every book you've downloaded, while `AnnotationModel.momd` tracks your highlights and reading progress.
- **`.nib` files:** These are compiled Interface Builder files. `BatchDownloadController.nib` is the actual UI layout for the download manager.
- **`Assets.car`:** A compiled asset catalog containing all the UI icons and buttons.

### 2. Guided View: Metadata vs. On-the-fly AI

You mentioned using Roboflow and AI for your reader. Interestingly, Kindle takes the opposite approach: **it is almost entirely metadata-driven, not AI-driven at the "edge" (the app).**

- **Pre-determined coordinates:** For almost all professional comics, the "zoom boxes" (panels) are defined **manually by the publisher** during the creation process using tools like _Kindle Create_.
- **Region Magnification:** The Kindle format (`.kfx` or `.azw3`) contains a layer of metadata called **Region Magnification**. It defines an array of $(x, y, w, h)$ coordinates for every panel on a page.
- **Transition Logic:** When you double-tap, the app simply queries the book file for the next set of coordinates and uses **Core Animation** to translate and scale the view to those exact bounds. There is no LLM or CV model running in the background to "find" the panels; the app is just following a "script" embedded in the book.

### 3. The "Virtual Panels" Fallback

If a comic _doesn't_ have publisher-provided metadata, Kindle uses a "Virtual Panels" feature. This isn't sophisticated AI either—it usually defaults to a **simple quadrant split** (splitting the page into 4 or 6 equal rectangles) based on the reading direction (Left-to-Right or Right-to-Left) specified in the book's metadata.

### How to peek deeper

Since you're a senior engineer, you might find these paths useful for your own project:

- **Sqlite Inspection:** Since they use Core Data, the actual database is likely a `.sqlite` file hiding in your `~/Library/Containers/com.amazon.Kindle/Data/Library/Application Support/` folder. You can open it with **DB Browser for SQLite** to see how they structure their `BookData`.
- **Hopper Disassembler:** If you want to see the actual math they use for the "pan and zoom" transitions, you can drag the binary (`MacOS/Kindle`) into Hopper. Look for methods inside a class likely named something like `KFXComicViewController` or `PanelViewModel`.
