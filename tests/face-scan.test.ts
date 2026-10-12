import { describe, expect, it } from "vitest";
import {
  assessFaceCapture,
  type FaceCaptureAssessment,
} from "@/domain/face-capture";
import { advanceFaceScan, initialFaceScanState } from "@/domain/face-scan";

const ready = assessFaceCapture({
  faces: [
    {
      box: { x: 0.3, y: 0.2, width: 0.4, height: 0.52 },
      keypoints: [],
      confidence: 0.9,
    },
  ],
});
const sample = (now: number, assessment = ready, frameFresh = true) => ({
  now,
  assessment,
  frameFresh,
});
const countdown = () => {
  let progress = advanceFaceScan(initialFaceScanState(), sample(0));
  for (const now of [200, 400, 650, 1000, 1650])
    progress = advanceFaceScan(progress.state, sample(now));
  return progress;
};

describe("automatic face scan timing", () => {
  it("waits for stable alignment, counts 3 to 1, then emits capture exactly once", () => {
    let progress = advanceFaceScan(initialFaceScanState(), sample(0));
    expect(progress.phase).toBe("guiding");
    for (const now of [200, 400, 649]) {
      progress = advanceFaceScan(progress.state, sample(now));
      expect(progress.phase).toBe("guiding");
    }
    progress = advanceFaceScan(progress.state, sample(650));
    expect(progress).toMatchObject({ phase: "countdown", countdown: 3 });
    for (const now of [1000, 1650])
      progress = advanceFaceScan(progress.state, sample(now));
    expect(progress).toMatchObject({ phase: "countdown", countdown: 2 });
    for (const now of [2000, 2650])
      progress = advanceFaceScan(progress.state, sample(now));
    expect(progress).toMatchObject({ phase: "countdown", countdown: 1 });
    for (const now of [3000, 3649])
      progress = advanceFaceScan(progress.state, sample(now));
    expect(progress.phase).toBe("countdown");
    progress = advanceFaceScan(progress.state, sample(3650));
    expect(progress).toMatchObject({
      phase: "capture",
      countdown: null,
      state: { captured: true },
    });
    progress = advanceFaceScan(progress.state, sample(3850));
    expect(progress.phase).toBe("guiding");
    expect(progress.state.captured).toBe(true);
  });

  it.each([
    "no-face",
    "multiple-faces",
    "off-center",
    "too-far",
    "too-close",
    "invalid",
  ] as const)("immediately cancels when alignment becomes %s", (status) => {
    const progress = advanceFaceScan(
      countdown().state,
      sample(1850, { status, face: null }),
    );
    expect(progress).toMatchObject({
      phase: "guiding",
      countdown: null,
      state: { readySince: null },
    });
    expect(advanceFaceScan(progress.state, sample(2050)).phase).toBe("guiding");
  });

  it("cancels a stalled frame, including during countdown", () => {
    const progress = advanceFaceScan(
      countdown().state,
      sample(1850, ready, false),
    );
    expect(progress.state.readySince).toBeNull();
    expect(progress.phase).toBe("guiding");
  });

  it("restarts stability after a long scheduling gap instead of immediately capturing", () => {
    const progress = advanceFaceScan(countdown().state, sample(5000));
    expect(progress).toMatchObject({
      phase: "guiding",
      state: { readySince: 5000 },
    });
  });

  it.each([NaN, Infinity, -1, 1e12, 1650, 1649])(
    "does not advance on an invalid or non-increasing clock %s",
    (now) => {
      expect(advanceFaceScan(countdown().state, sample(now)).phase).toBe(
        "guiding",
      );
    },
  );

  it("does not trust a ready flag without valid centered geometry", () => {
    expect(
      advanceFaceScan(
        countdown().state,
        sample(1850, { status: "ready", face: null }),
      ).phase,
    ).toBe("guiding");
    const claimed = {
      status: "ready",
      face: { ...ready.face!, confidence: NaN },
    } as FaceCaptureAssessment;
    expect(
      advanceFaceScan(countdown().state, sample(1850, claimed)).phase,
    ).toBe("guiding");
  });

  it("does not mutate earlier progress", () => {
    const previous = countdown();
    const serialized = JSON.stringify(previous);
    advanceFaceScan(previous.state, sample(1850));
    expect(JSON.stringify(previous)).toBe(serialized);
  });
});
