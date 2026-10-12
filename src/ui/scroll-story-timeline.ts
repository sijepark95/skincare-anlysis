export type StoryBeat = {
  name: string;
  travel: number;
  from: number;
  to: number;
  chapter: number | null;
};

/** Active travel is separate from the single viewport occupied by the stage. */
export const STORY_BEATS: readonly StoryBeat[] = [
  { name: "opening-hold", travel: 0.8, from: 0, to: 0, chapter: 0 },
  { name: "the-drop", travel: 1, from: 0, to: 1 / 6, chapter: 0 },
  {
    name: "inside-the-ripple",
    travel: 1.4,
    from: 1 / 6,
    to: 1 / 3,
    chapter: null,
  },
  { name: "a-closer-look", travel: 1.7, from: 1 / 3, to: 0.8, chapter: 1 },
  { name: "your-next-step", travel: 1.5, from: 0.8, to: 1, chapter: 2 },
  { name: "resolution-hold", travel: 1, from: 1, to: 1, chapter: 2 },
];

export const STORY_TRAVEL = STORY_BEATS.reduce(
  (sum, beat) => sum + beat.travel,
  0,
);

export function storyPosition(progress: number, frameCount: number) {
  const clamped = Number.isFinite(progress)
    ? Math.min(1, Math.max(0, progress))
    : 0;
  const travel = clamped * STORY_TRAVEL;
  let start = 0;
  let beat = STORY_BEATS[STORY_BEATS.length - 1];
  let local = 1;
  for (const candidate of STORY_BEATS) {
    if (travel < start + candidate.travel) {
      beat = candidate;
      local = Math.max(0, (travel - start) / candidate.travel);
      break;
    }
    start += candidate.travel;
  }
  const fraction = beat.from + (beat.to - beat.from) * local;
  return {
    frame: Math.round(
      fraction *
        Math.max(
          0,
          (Number.isFinite(frameCount) ? Math.floor(frameCount) : 1) - 1,
        ),
    ),
    chapter: beat.chapter,
    beat: beat.name,
    progress: clamped,
  };
}

export type StoryManifest = {
  version: 1;
  width: number;
  height: number;
  frameCount: number;
  frames: string[];
  poster: string;
  durationSeconds?: number;
};

export function parseStoryManifest(value: unknown): StoryManifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Partial<StoryManifest>;
  if (
    manifest.version !== 1 ||
    !Number.isInteger(manifest.width) ||
    !Number.isInteger(manifest.height) ||
    manifest.width! < 1 ||
    manifest.height! < 1 ||
    manifest.width! > 4096 ||
    manifest.height! > 4096 ||
    !Number.isInteger(manifest.frameCount) ||
    manifest.frameCount! < 2 ||
    manifest.frameCount! > 1200 ||
    !Array.isArray(manifest.frames) ||
    manifest.frames.length !== manifest.frameCount ||
    manifest.frames.some(
      (frame) =>
        typeof frame !== "string" ||
        !/^\/media\/aelune\/story\/[a-zA-Z0-9_-]+\.webp$/.test(frame),
    ) ||
    typeof manifest.poster !== "string" ||
    !/^\/media\/aelune\/[a-zA-Z0-9_/-]+\.webp$/.test(manifest.poster)
  )
    return null;
  return manifest as StoryManifest;
}

export function nearbyFrames(
  target: number,
  count: number,
  direction = 1,
  radius = 7,
) {
  const frames = [target];
  for (let distance = 1; distance <= radius; distance++) {
    for (const offset of [distance * direction, -distance * direction]) {
      const index = target + offset;
      if (index >= 0 && index < count) frames.push(index);
    }
  }
  return frames;
}

/** A small decoded cache, not a preload of the entire film. */
export class StoryFrameCache<T extends { close?: () => void }> {
  private readonly frames = new Map<number, T>();
  private readonly requests = new Map<number, AbortController>();
  private readonly failures = new Map<number, number>();
  private priority: number[] = [];
  private target = -1;
  private disposed = false;

  constructor(
    private readonly count: number,
    private readonly load: (index: number, signal: AbortSignal) => Promise<T>,
    private readonly onReady: (index: number) => void,
    private readonly onFailure: (index: number) => void = () => {},
    private readonly capacity = 16,
    private readonly concurrency = 3,
  ) {}

  get(index: number): T | undefined {
    return this.frames.get(index);
  }

  request(target: number) {
    if (
      this.disposed ||
      !Number.isInteger(target) ||
      target < 0 ||
      target >= this.count
    )
      return;
    const direction = target < this.target ? -1 : 1;
    this.target = target;
    this.priority = nearbyFrames(target, this.count, direction).slice(
      0,
      this.capacity,
    );
    for (const [index, controller] of this.requests) {
      if (!this.priority.includes(index)) controller.abort();
    }
    for (const [index, frame] of this.frames) {
      if (!this.priority.includes(index)) {
        frame.close?.();
        this.frames.delete(index);
      }
    }
    this.pump();
  }

  dispose() {
    this.disposed = true;
    for (const request of this.requests.values()) request.abort();
    for (const frame of this.frames.values()) frame.close?.();
    this.frames.clear();
    this.priority = [];
  }

  private pump() {
    if (this.disposed) return;
    for (const index of this.priority) {
      if (this.requests.size >= this.concurrency) break;
      if (
        this.frames.has(index) ||
        this.requests.has(index) ||
        (this.failures.get(index) ?? 0) >= 2
      )
        continue;
      const controller = new AbortController();
      this.requests.set(index, controller);
      void this.load(index, controller.signal)
        .then((frame) => {
          if (
            this.disposed ||
            controller.signal.aborted ||
            !this.priority.includes(index)
          ) {
            frame.close?.();
            return;
          }
          this.frames.set(index, frame);
          while (this.frames.size > this.capacity) {
            const victim = [...this.frames.keys()].sort(
              (a, b) => this.priority.indexOf(b) - this.priority.indexOf(a),
            )[0];
            this.frames.get(victim)?.close?.();
            this.frames.delete(victim);
          }
          this.onReady(index);
        })
        .catch(() => {
          if (this.disposed || controller.signal.aborted) return;
          const attempts = (this.failures.get(index) ?? 0) + 1;
          this.failures.set(index, attempts);
          if (attempts >= 2) this.onFailure(index);
        })
        .finally(() => {
          this.requests.delete(index);
          this.pump();
        });
    }
  }
}
