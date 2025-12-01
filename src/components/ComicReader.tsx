"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";

interface Box2D {
  x: number;
  y: number;
  width: number;
  height: number;
  index?: number;
}

interface Bubble {
  id: string;
  box_2d: Box2D;
  ocr_text: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  emotion: string;
  textWithCues?: string;
  ignored?: boolean;
}

interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface AudioTimestamps {
  alignment: CharacterAlignment | null;
  normalized_alignment: CharacterAlignment | null;
}

interface ComicReaderProps {
  pageImage: string;
  bubbles: Bubble[];
  timestamps: Record<string, AudioTimestamps>;
  bookId: string;
  issueId: string;
}

export default function ComicReader({
  pageImage,
  bubbles,
  timestamps,
  bookId,
  issueId,
}: ComicReaderProps) {
  const [imageSize, setImageSize] = useState<{
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [activeBubble, setActiveBubble] = useState<string | null>(null);
  const [highlightedRange, setHighlightedRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const imageRef = useRef<HTMLDivElement>(null);

  // Function to update image size and position
  const updateImageSize = useCallback(() => {
    if (imageRef.current) {
      // Find the actual img element (Next.js Image wraps it)
      const imgElement = imageRef.current.querySelector("img");
      if (!imgElement) return;

      const container = imageRef.current;
      const containerRect = container.getBoundingClientRect();
      const imgRect = imgElement.getBoundingClientRect();

      // Calculate expected size based on object-contain behavior
      // object-contain scales the image to fit while maintaining aspect ratio
      const naturalAspect = imgElement.naturalWidth / imgElement.naturalHeight;
      const containerAspect = containerRect.width / containerRect.height;

      let expectedWidth: number;
      let expectedHeight: number;

      if (naturalAspect > containerAspect) {
        // Image is wider - fit to width
        expectedWidth = containerRect.width;
        expectedHeight = containerRect.width / naturalAspect;
      } else {
        // Image is taller - fit to height
        expectedHeight = containerRect.height;
        expectedWidth = containerRect.height * naturalAspect;
      }

      // Calculate offset: where the image should be positioned (object-contain centers it)
      const offsetX = (containerRect.width - expectedWidth) / 2;
      const offsetY = (containerRect.height - expectedHeight) / 2;

      // Use the expected dimensions for calculations (not the actual rendered size)
      const actualRenderedWidth = expectedWidth;
      const actualRenderedHeight = expectedHeight;

      console.log("📐 Image Size Update:", {
        natural: {
          width: imgElement.naturalWidth,
          height: imgElement.naturalHeight,
          aspect: naturalAspect,
        },
        container: {
          width: containerRect.width,
          height: containerRect.height,
          aspect: containerAspect,
        },
        rendered: {
          width: imgRect.width,
          height: imgRect.height,
        },
        expected: {
          width: expectedWidth,
          height: expectedHeight,
          offsetX,
          offsetY,
        },
        scale: {
          x: actualRenderedWidth / imgElement.naturalWidth,
          y: actualRenderedHeight / imgElement.naturalHeight,
        },
      });

      setImageSize({
        width: actualRenderedWidth,
        height: actualRenderedHeight,
        naturalWidth: imgElement.naturalWidth,
        naturalHeight: imgElement.naturalHeight,
        offsetX,
        offsetY,
      });
    }
  }, []);

  // Filter out ignored bubbles and non-speech bubbles
  const visibleBubbles = bubbles.filter(
    (b) =>
      !b.ignored &&
      (b.type === "SPEECH" || b.type === "NARRATION" || b.type === "CAPTION"),
  );

  // Calculate scale factor between displayed image and natural image size
  const scaleX = imageSize ? imageSize.width / imageSize.naturalWidth : 1;
  const scaleY = imageSize ? imageSize.height / imageSize.naturalHeight : 1;

  // Handle image load to get actual dimensions
  const handleImageLoad = () => {
    // Use multiple timeouts to ensure the image is fully rendered and positioned
    setTimeout(updateImageSize, 0);
    setTimeout(updateImageSize, 50);
    setTimeout(updateImageSize, 200);
  };

  // Recalculate on window resize and layout changes
  useEffect(() => {
    if (!imageRef.current) return;

    const handleResize = () => {
      updateImageSize();
    };

    window.addEventListener("resize", handleResize);

    // Use ResizeObserver to detect when container or image size changes
    const resizeObserver = new ResizeObserver(() => {
      updateImageSize();
    });

    resizeObserver.observe(imageRef.current);

    // Also observe the img element if it exists
    const imgElement = imageRef.current.querySelector("img");
    if (imgElement) {
      resizeObserver.observe(imgElement);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
    };
  }, [updateImageSize]);

  // Handle bubble click
  const handleBubbleClick = (bubble: Bubble) => {
    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    setActiveBubble(bubble.id);
    setIsPlaying(true);
    setHighlightedRange(null);

    // Load and play audio
    const audioUrl = `/comics/${bookId}/${issueId}/audio/${bubble.id}.mp3`;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    // Get timestamps for this bubble
    const bubbleTimestamps = timestamps[bubble.id] as
      | {
          alignment?: CharacterAlignment;
          normalized_alignment?: CharacterAlignment;
        }
      | undefined;
    const alignment =
      bubbleTimestamps?.normalized_alignment || bubbleTimestamps?.alignment;

    if (
      alignment &&
      alignment.character_start_times_seconds &&
      alignment.character_end_times_seconds
    ) {
      // Set up highlighting based on timestamps
      let intervalId: NodeJS.Timeout | null = null;

      const updateHighlight = () => {
        if (audio.paused || audio.ended) {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
          return;
        }

        const currentTime = audio.currentTime;
        const starts = alignment.character_start_times_seconds;
        const ends = alignment.character_end_times_seconds;

        // Find which character range should be highlighted
        for (let i = 0; i < starts.length; i++) {
          const startTime = starts[i] ?? 0;
          const endTime = ends[i] ?? 0;

          if (currentTime >= startTime && currentTime <= endTime) {
            setHighlightedRange({ start: i, end: i });
            break;
          }
        }
      };

      // Update highlight during playback
      intervalId = setInterval(updateHighlight, 50); // Update every 50ms

      const handleEnded = () => {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        setIsPlaying(false);
        setActiveBubble(null);
        setHighlightedRange(null);
      };

      const handlePause = () => {
        setIsPlaying(false);
      };

      const handlePlay = () => {
        setIsPlaying(true);
      };

      audio.addEventListener("ended", handleEnded);
      audio.addEventListener("pause", handlePause);
      audio.addEventListener("play", handlePlay);
    } else {
      // No timestamps available, just play audio without highlighting
      audio.addEventListener("ended", () => {
        setIsPlaying(false);
        setActiveBubble(null);
      });

      audio.addEventListener("pause", () => {
        setIsPlaying(false);
      });

      audio.addEventListener("play", () => {
        setIsPlaying(true);
      });
    }

    audio.play().catch((error) => {
      console.error("Error playing audio:", error);
      setIsPlaying(false);
      setActiveBubble(null);
    });
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  // Render text with highlighting
  const renderTextWithHighlight = (bubble: Bubble) => {
    const bubbleTimestamps = timestamps[bubble.id];
    const alignment =
      bubbleTimestamps?.normalized_alignment || bubbleTimestamps?.alignment;
    const text = bubble.textWithCues || bubble.ocr_text;

    if (!alignment || activeBubble !== bubble.id || !highlightedRange) {
      return <span>{text}</span>;
    }

    // Build highlighted text
    const chars = alignment.characters;
    const result: React.ReactNode[] = [];
    let textIndex = 0;

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i] ?? "";
      const isHighlighted =
        i >= highlightedRange.start && i <= highlightedRange.end;

      // Try to match character from alignment to text
      if (textIndex < text.length) {
        if (text[textIndex] === char || char === " ") {
          result.push(
            <span
              key={i}
              className={isHighlighted ? "bg-yellow-400 text-black" : ""}
            >
              {text[textIndex]}
            </span>,
          );
          textIndex++;
        } else {
          // Character mismatch, just show the alignment char
          result.push(
            <span
              key={i}
              className={isHighlighted ? "bg-yellow-400 text-black" : ""}
            >
              {char}
            </span>,
          );
        }
      } else {
        result.push(
          <span
            key={i}
            className={isHighlighted ? "bg-yellow-400 text-black" : ""}
          >
            {char}
          </span>,
        );
      }
    }

    return <>{result}</>;
  };

  return (
    <div className="relative flex justify-center">
      <div ref={imageRef} className="relative aspect-[2/3] w-full max-w-2xl">
        {/* Comic Page Image */}
        <Image
          src={pageImage}
          alt="Comic page"
          fill
          className="object-contain"
          priority
          sizes="(max-width: 768px) 100vw, 768px"
          onLoad={handleImageLoad}
        />

        {/* Bubble Overlays */}
        {imageSize &&
          imageRef.current &&
          visibleBubbles.map((bubble) => {
            const box = bubble.box_2d;
            const isActive = activeBubble === bubble.id;
            const container = imageRef.current;
            if (!container) return null;

            // Get container dimensions
            const containerRect = container.getBoundingClientRect();

            // Convert bubble coordinates from natural image pixels to displayed image pixels
            // Bubble coords are in the original image's pixel space
            // Use uniform scale to maintain aspect ratio (object-contain behavior)
            const scaleX = imageSize.width / imageSize.naturalWidth;
            const scaleY = imageSize.height / imageSize.naturalHeight;
            // Use the smaller scale to ensure we don't stretch
            const uniformScale = Math.min(scaleX, scaleY);

            // Convert to displayed image coordinates using uniform scale
            const displayedX = box.x * uniformScale;
            const displayedY = box.y * uniformScale;
            const displayedWidth = box.width * uniformScale;
            const displayedHeight = box.height * uniformScale;

            // Calculate position as percentage of container
            // The image is positioned at offsetX, offsetY within the container
            const left =
              ((displayedX + imageSize.offsetX) / containerRect.width) * 100;
            const top =
              ((displayedY + imageSize.offsetY) / containerRect.height) * 100;
            const width = (displayedWidth / containerRect.width) * 100;
            const height = (displayedHeight / containerRect.height) * 100;

            // Log first bubble for debugging
            if (bubble.id === visibleBubbles[0]?.id) {
              console.log("🎈 Bubble Position Calculation:", {
                bubbleId: bubble.id,
                original: {
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                },
                scale: {
                  x: scaleX,
                  y: scaleY,
                  uniform: uniformScale,
                },
                displayed: {
                  x: displayedX,
                  y: displayedY,
                  width: displayedWidth,
                  height: displayedHeight,
                },
                offset: {
                  x: imageSize.offsetX,
                  y: imageSize.offsetY,
                },
                container: {
                  width: containerRect.width,
                  height: containerRect.height,
                },
                final: {
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                },
              });
            }

            return (
              <div
                key={bubble.id}
                className="absolute cursor-pointer transition-all"
                style={{
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                }}
                onClick={() => handleBubbleClick(bubble)}
              >
                {/* Blank overlay - white rectangle to cover the bubble */}
                <div
                  className={`h-full w-full rounded border-2 transition-all ${
                    isActive
                      ? "border-yellow-400 bg-yellow-400/20"
                      : "border-transparent bg-white/90 hover:bg-white/80"
                  }`}
                />

                {/* Text display when active */}
                {isActive && (
                  <div className="absolute inset-0 flex items-center justify-center p-2">
                    <div className="rounded bg-black/90 p-2 text-xs text-white">
                      <div className="font-semibold">
                        {bubble.speaker || "Narrator"}
                      </div>
                      <div className="mt-1">
                        {renderTextWithHighlight(bubble)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
