import { describe, expect, it, vi } from "vitest";
import {
  nearbyFrames,
  parseStoryManifest,
  STORY_BEATS,
  STORY_TRAVEL,
  StoryFrameCache,
  storyPosition,
} from "@/ui/scroll-story-timeline";

const manifest = {
  version: 1,
  width: 720,
  height: 1280,
  frameCount: 3,
  frames: [0, 1, 2].map((index) => `/media/aelune/story/frame-${index}.webp`),
  poster: "/media/aelune/drop-poster.webp",
};

describe("cinematic story native timeline", () => {
  it("counts 7.4 viewport heights of active travel separately from the stage", () => {
    expect(STORY_TRAVEL).toBeCloseTo(7.4);
    expect(STORY_BEATS.reduce((sum, beat) => sum + beat.travel, 0)).toBe(
      STORY_TRAVEL,
    );
  });

  it("holds the opening and resolution instead of pretending they are sustained motion", () => {
    expect(storyPosition(0.4 / STORY_TRAVEL, 541)).toMatchObject({
      frame: 0,
      chapter: 0,
    });
    expect(storyPosition(7 / STORY_TRAVEL, 541)).toMatchObject({
      frame: 540,
      chapter: 2,
    });
  });

  it("gives the ripple its own isolated 1.4 viewport-height beat without HTML chapter copy", () => {
    for (const travel of [1.81, 2.5, 3.19]) {
      expect(storyPosition(travel / STORY_TRAVEL, 541)).toMatchObject({
        chapter: null,
        beat: "inside-the-ripple",
      });
    }
    expect(storyPosition(3.21 / STORY_TRAVEL, 541).chapter).toBe(1);
    // The actual film's impact/dive occupies 5–10 seconds, frames 90–180 at 18fps.
    expect(storyPosition(1.8 / STORY_TRAVEL, 541).frame).toBe(90);
    expect(storyPosition(3.2 / STORY_TRAVEL, 541).frame).toBe(180);
    // Keep the face reveal in the closer-look beat before serum begins at 24s.
    expect(storyPosition(4.9 / STORY_TRAVEL, 541).frame).toBe(432);
  });

  it("keeps adjacent frame intervals continuous in both directions", () => {
    let travel = 0;
    for (const beat of STORY_BEATS.slice(0, -1)) {
      travel += beat.travel;
      const before = storyPosition((travel - 0.00001) / STORY_TRAVEL, 541);
      const after = storyPosition((travel + 0.00001) / STORY_TRAVEL, 541);
      expect(Math.abs(before.frame - after.frame)).toBeLessThanOrEqual(1);
    }
    const forward = Array.from(
      { length: 101 },
      (_, index) => storyPosition(index / 100, 541).frame,
    );
    expect([...forward].sort((a, b) => a - b)).toEqual(forward);
    expect(
      Array.from(
        { length: 101 },
        (_, index) => storyPosition((100 - index) / 100, 541).frame,
      ),
    ).toEqual([...forward].reverse());
  });

  it.each([-100, -0.1, 0, 1, 100, Number.NaN, Number.POSITIVE_INFINITY])(
    "always clamps %s to a valid frame",
    (progress) => {
      const { frame } = storyPosition(progress, 541);
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThanOrEqual(540);
    },
  );

  it("rejects corrupt, oversized and external frame manifests", () => {
    expect(parseStoryManifest(manifest)).toEqual(manifest);
    for (const change of [
      { version: 2 },
      { width: 0 },
      { width: 10000 },
      { height: null },
      { frameCount: 1201 },
      { frameCount: 1 },
      { frameCount: 4 },
      {
        frames: ["https://example.com/frame.webp", ...manifest.frames.slice(1)],
      },
      {
        frames: [
          "/media/aelune/story/../private.webp",
          ...manifest.frames.slice(1),
        ],
      },
      { poster: "//example.com/poster.webp" },
    ])
      expect(parseStoryManifest({ ...manifest, ...change })).toBeNull();
    expect(parseStoryManifest(null)).toBeNull();
  });

  it("prioritizes the requested frame and favors the direction of travel", () => {
    expect(nearbyFrames(5, 20, 1, 2)).toEqual([5, 6, 4, 7, 3]);
    expect(nearbyFrames(5, 20, -1, 2)).toEqual([5, 4, 6, 3, 7]);
    expect(nearbyFrames(0, 3)).toEqual([0, 1, 2]);
    expect(nearbyFrames(2, 3)).toEqual([2, 1, 0]);
  });
});

const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

describe("bounded cinematic frame cache", () => {
  it("loads only the local neighborhood, retaining at most 15 decoded images", async () => {
    const load = vi.fn(async (index: number) => ({ index, close: vi.fn() }));
    const cache = new StoryFrameCache(541, load, () => {});
    cache.request(250);
    await settle();
    expect(load).toHaveBeenCalledTimes(15);
    expect(load.mock.calls.map(([index]) => index)).toEqual(
      nearbyFrames(250, 541),
    );
    expect(cache.get(250)).toMatchObject({ index: 250 });
    expect(cache.get(300)).toBeUndefined();
    cache.dispose();
  });

  it("bounds in-flight work, aborts stale jumps and never installs their late bitmap", async () => {
    const pending: {
      index: number;
      signal: AbortSignal;
      resolve: (frame: { close: () => void }) => void;
    }[] = [];
    const ready = vi.fn();
    const cache = new StoryFrameCache(
      541,
      (index, signal) =>
        new Promise<{ close: () => void }>((resolve) =>
          pending.push({ index, signal, resolve }),
        ),
      ready,
    );
    cache.request(50);
    expect(pending).toHaveLength(3);
    cache.request(400);
    expect(pending).toHaveLength(3);
    expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
    const stale = pending.slice(0, 3).map(() => ({ close: vi.fn() }));
    pending
      .slice(0, 3)
      .forEach((request, index) => request.resolve(stale[index]));
    await settle();
    expect(pending).toHaveLength(6);
    expect(pending[3].index).toBe(400);
    expect(ready).not.toHaveBeenCalled();
    for (const frame of stale) expect(frame.close).toHaveBeenCalledOnce();
    cache.dispose();
    const final = pending.slice(3).map(() => ({ close: vi.fn() }));
    pending.slice(3).forEach((request, index) => request.resolve(final[index]));
    await settle();
    for (const frame of final) expect(frame.close).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(6);
  });

  it("releases all evicted images when reversing or jumping and all retained images on teardown", async () => {
    const images = new Map<number, { close: ReturnType<typeof vi.fn> }>();
    const cache = new StoryFrameCache(
      541,
      async (index) => {
        const image = { close: vi.fn() };
        images.set(index, image);
        return image;
      },
      () => {},
    );
    cache.request(250);
    await settle();
    const initial = [...images.values()];
    cache.request(20);
    await settle();
    for (const image of initial) expect(image.close).toHaveBeenCalledOnce();
    expect(cache.get(250)).toBeUndefined();
    expect(cache.get(20)).toBeDefined();
    cache.dispose();
    for (const image of images.values())
      expect(image.close).toHaveBeenCalledOnce();
  });

  it("retries missing frames only twice and does not spin when requested again", async () => {
    const load = vi.fn(async () => {
      throw new Error("404");
    });
    const failed = vi.fn();
    const cache = new StoryFrameCache(3, load, () => {}, failed);
    cache.request(0);
    await settle();
    cache.request(0);
    await settle();
    expect(load).toHaveBeenCalledTimes(6);
    expect(failed).toHaveBeenCalledTimes(3);
    cache.dispose();
  });

  it("respects a smaller configured capacity without evict/reload loops", async () => {
    const load = vi.fn(async () => ({ close: vi.fn() }));
    const cache = new StoryFrameCache(541, load, () => {}, undefined, 4);
    cache.request(250);
    await settle();
    expect(load).toHaveBeenCalledTimes(4);
    cache.request(250);
    await settle();
    expect(load).toHaveBeenCalledTimes(4);
    cache.dispose();
  });
});
