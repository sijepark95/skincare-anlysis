import { assessFaceCapture, type FaceCaptureAssessment } from "./face-capture";

export interface FaceScanState {
  readySince: number | null;
  lastNow: number | null;
  captured: boolean;
}

export interface FaceScanProgress {
  state: FaceScanState;
  phase: "guiding" | "countdown" | "capture";
  countdown: number | null;
}

export function initialFaceScanState(): FaceScanState {
  return { readySince: null, lastNow: null, captured: false };
}

const time = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value < 1e12;

/** Local framing assistance: 650ms stable, then a cancellable 3-second count. */
export function advanceFaceScan(
  previous: FaceScanState,
  input: {
    assessment: FaceCaptureAssessment;
    now: number;
    frameFresh: boolean;
  },
): FaceScanProgress {
  const { assessment, now, frameFresh } = input;
  const validState =
    previous !== null &&
    typeof previous === "object" &&
    typeof previous.captured === "boolean" &&
    (previous.readySince === null || time(previous.readySince)) &&
    (previous.lastNow === null || time(previous.lastNow)) &&
    (previous.readySince === null ||
      (previous.lastNow !== null && previous.readySince <= previous.lastNow));
  const reset = (): FaceScanProgress => ({
    state: {
      readySince: null,
      lastNow: time(now) ? now : null,
      captured: validState && previous.captured,
    },
    phase: "guiding",
    countdown: null,
  });
  if (
    !validState ||
    !time(now) ||
    (previous.lastNow !== null && now <= previous.lastNow) ||
    frameFresh !== true ||
    assessment?.status !== "ready" ||
    assessFaceCapture({ faces: [assessment.face] }).status !== "ready" ||
    previous.captured
  )
    return reset();
  // A background tab, paused camera or blocked UI must re-establish alignment.
  const uninterrupted =
    previous.lastNow === null || now - previous.lastNow <= 1000;
  const readySince =
    uninterrupted && previous.readySince !== null ? previous.readySince : now;
  const elapsed = now - readySince;
  const state: FaceScanState = { readySince, lastNow: now, captured: false };
  if (elapsed < 650) return { state, phase: "guiding", countdown: null };
  if (elapsed < 3650)
    return {
      state,
      phase: "countdown",
      countdown: Math.ceil((3650 - elapsed) / 1000),
    };
  return {
    state: { ...state, captured: true },
    phase: "capture",
    countdown: null,
  };
}
