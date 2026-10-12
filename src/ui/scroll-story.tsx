"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { aelune, aeluneStoryChapters as chapters } from "@/content/aelune";
import {
  parseStoryManifest,
  STORY_TRAVEL,
  StoryFrameCache,
  storyPosition,
} from "./scroll-story-timeline";
import "./scroll-story.css";

const POSTER = aelune.media.drop;
const MANIFEST = aelune.media.storyManifest;

type DecodedFrame = { source: CanvasImageSource; close: () => void };
type NetworkPreferences = { saveData?: boolean; effectiveType?: string };

async function decodeFrame(
  url: string,
  signal: AbortSignal,
): Promise<DecodedFrame> {
  const response = await fetch(url, { signal, cache: "force-cache" });
  if (!response.ok) throw new Error("Story frame unavailable");
  const blob = await response.blob();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    if (signal.aborted) {
      bitmap.close();
      throw new DOMException("Aborted", "AbortError");
    }
    return { source: bitmap, close: () => bitmap.close() };
  }
  const image = new Image();
  const objectUrl = URL.createObjectURL(blob);
  try {
    image.src = objectUrl;
    await image.decode();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return {
      source: image,
      close: () => {
        image.src = "";
      },
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function ScrollStory() {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chapterRefs = useRef<(HTMLElement | null)[]>([]);
  const [cinematic, setCinematic] = useState(false);
  const [readWithoutMotion, setReadWithoutMotion] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const shortViewport = window.matchMedia("(max-height: 560px)");
    const connection = (
      navigator as Navigator & { connection?: NetworkPreferences }
    ).connection;
    const update = () => {
      setCinematic(
        !preference.matches &&
          !shortViewport.matches &&
          !connection?.saveData &&
          connection?.effectiveType !== "slow-2g" &&
          connection?.effectiveType !== "2g" &&
          !readWithoutMotion &&
          !mediaFailed,
      );
    };
    // The initial server render is the complete, ordinary reading experience.
    const initialUpdate = window.requestAnimationFrame(update);
    preference.addEventListener("change", update);
    shortViewport.addEventListener("change", update);
    return () => {
      window.cancelAnimationFrame(initialUpdate);
      preference.removeEventListener("change", update);
      shortViewport.removeEventListener("change", update);
    };
  }, [readWithoutMotion, mediaFailed]);

  useEffect(() => {
    if (cinematic || !readWithoutMotion) return;
    const restoreReadingPosition = window.requestAnimationFrame(() =>
      sectionRef.current?.scrollIntoView({
        block: "start",
        behavior: "instant",
      }),
    );
    return () => window.cancelAnimationFrame(restoreReadingPosition);
  }, [cinematic, readWithoutMotion]);

  useEffect(() => {
    if (!cinematic) return;
    const section = sectionRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const chapterNodes = chapterRefs.current;
    if (!section || !stage || !canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    let disposed = false;
    let frameRequest = 0;
    let target = 0;
    let lastTarget = -1;
    let painted = -1;
    let activeChapter: number | null = -1;
    let frameCount = 1;
    let mediaWidth = 9;
    let mediaHeight = 16;
    let cache: StoryFrameCache<DecodedFrame> | undefined;
    const request = new AbortController();

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(box.width * ratio));
      const height = Math.max(1, Math.round(box.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        painted = -1;
      }
    };

    const render = () => {
      frameRequest = 0;
      if (disposed || document.hidden) return;
      const box = section.getBoundingClientRect();
      const activeTravel = Math.max(
        1,
        section.offsetHeight - stage.offsetHeight,
      );
      const position = storyPosition(-box.top / activeTravel, frameCount);
      target = position.frame;
      stage.dataset.scrollProgress = position.progress.toFixed(4);
      stage.dataset.activeBeat = position.beat;
      stage.dataset.activeChapter =
        position.chapter === null ? "transition" : String(position.chapter);

      if (activeChapter !== position.chapter) {
        activeChapter = position.chapter;
        for (const [index, chapter] of chapterNodes.entries()) {
          if (!chapter) continue;
          const active = index === activeChapter;
          chapter.hidden = !active;
          chapter.inert = !active;
          chapter.setAttribute("aria-hidden", String(!active));
        }
      }
      // Frames are requested only close to the story, never across the full film.
      if (
        box.top < window.innerHeight * 2 &&
        box.bottom > -window.innerHeight
      ) {
        if (target !== lastTarget) {
          cache?.request(target);
          if (cache) lastTarget = target;
        }
        const decoded = cache?.get(target);
        if (decoded && target !== painted) {
          resize();
          context.fillStyle = "#e8f0f5";
          context.fillRect(0, 0, canvas.width, canvas.height);
          // Cover the full stage with the same focal crop as the poster.
          const scale = Math.max(
            canvas.width / mediaWidth,
            canvas.height / mediaHeight,
          );
          const width = mediaWidth * scale;
          const height = mediaHeight * scale;
          context.drawImage(
            decoded.source,
            (canvas.width - width) / 2,
            (canvas.height - height) * 0.44,
            width,
            height,
          );
          canvas.dataset.frameIndex = String(target);
          canvas.dataset.frameReady = "true";
          painted = target;
        }
      }
    };

    const schedule = () => {
      if (!disposed && !frameRequest)
        frameRequest = window.requestAnimationFrame(render);
    };
    const onResize = () => {
      resize();
      schedule();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(canvas);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    resize();
    schedule();

    void fetch(MANIFEST, { signal: request.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Story manifest unavailable");
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        if (disposed) return;
        const manifest = parseStoryManifest(value);
        if (!manifest) throw new Error("Story manifest invalid");
        frameCount = manifest.frameCount;
        mediaWidth = manifest.width;
        mediaHeight = manifest.height;
        cache = new StoryFrameCache(
          frameCount,
          (index, signal) => decodeFrame(manifest.frames[index], signal),
          (index) => {
            if (index === target) schedule();
          },
          (index) => {
            if (index === target && painted < 0 && !disposed)
              setMediaFailed(true);
          },
        );
        schedule();
      })
      .catch(() => {
        if (!disposed && !request.signal.aborted) setMediaFailed(true);
      });

    return () => {
      disposed = true;
      request.abort();
      cache?.dispose();
      window.cancelAnimationFrame(frameRequest);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", schedule);
      for (const chapter of chapterNodes) {
        if (!chapter) continue;
        chapter.hidden = false;
        chapter.inert = false;
        chapter.removeAttribute("aria-hidden");
      }
    };
  }, [cinematic]);

  return (
    <section
      id="experience"
      ref={sectionRef}
      className="aelune-story"
      aria-label="Inside the drop"
      data-story-mode={cinematic ? "cinematic" : "simple"}
      style={{ "--story-travel": STORY_TRAVEL } as CSSProperties}
    >
      <div className="aelune-story-stage" ref={stageRef}>
        <div className="aelune-story-topline">
          <p>
            INSIDE THE DROP <span>A visual journey</span>
          </p>
          <a href="#how-it-works">
            Skip the film <span aria-hidden="true">↘</span>
          </a>
        </div>
        <div className="aelune-story-media" aria-hidden="true">
          {/* The still remains beneath the transparent canvas until a decoded frame is ready. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={POSTER} width="720" height="1280" alt="" loading="lazy" />
          <canvas ref={canvasRef} />
        </div>
        <div className="aelune-story-chapters">
          {chapters.map((chapter, index) => (
            <article
              className="aelune-story-chapter"
              key={chapter.number}
              ref={(node) => {
                chapterRefs.current[index] = node;
              }}
            >
              <p className="aelune-story-eyebrow">{chapter.number}</p>
              <h2>{chapter.title}</h2>
              <p className="aelune-story-description">{chapter.body}</p>
              {chapter.action && chapter.href && (
                <a className="aelune-story-action" href={chapter.href}>
                  {chapter.action} <span aria-hidden="true">↗</span>
                </a>
              )}
            </article>
          ))}
        </div>
        <div className="aelune-story-caption">
          <p>
            Concept CGI film · A creative interpretation, not an analysis
            demonstration.
          </p>
          {cinematic && (
            <button type="button" onClick={() => setReadWithoutMotion(true)}>
              Read without motion
            </button>
          )}
        </div>
        {cinematic && (
          <div className="aelune-story-scroll" aria-hidden="true">
            <span />
            SCROLL TO EXPLORE
          </div>
        )}
      </div>
    </section>
  );
}
