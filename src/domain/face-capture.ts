/** Transient geometry only: presence/alignment, never identity or skin scores. */
export interface FaceObservation {
  box: { x: number; y: number; width: number; height: number };
  keypoints: { x: number; y: number }[];
  confidence: number;
}

export interface FaceSnapshot {
  faces: FaceObservation[];
}

export type FaceCaptureStatus =
  | "no-face"
  | "multiple-faces"
  | "too-far"
  | "too-close"
  | "off-center"
  | "ready"
  | "invalid";

export interface FaceCaptureAssessment {
  status: FaceCaptureStatus;
  face: FaceObservation | null;
}

const unit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

function isFace(value: unknown): value is FaceObservation {
  if (typeof value !== "object" || value === null) return false;
  const face = value as Partial<FaceObservation>;
  const box = face.box;
  return (
    unit(face.confidence) &&
    typeof box === "object" &&
    box !== null &&
    unit(box.x) &&
    unit(box.y) &&
    unit(box.width) &&
    box.width > 0 &&
    unit(box.height) &&
    box.height > 0 &&
    box.x + box.width <= 1.000001 &&
    box.y + box.height <= 1.000001 &&
    Array.isArray(face.keypoints) &&
    face.keypoints.length <= 6 &&
    Array.from(face.keypoints).every(
      (point) =>
        typeof point === "object" &&
        point !== null &&
        unit(point.x) &&
        unit(point.y),
    )
  );
}

/** Capture assistance thresholds are UX heuristics, not validated image quality. */
export function assessFaceCapture(snapshot: unknown): FaceCaptureAssessment {
  if (typeof snapshot !== "object" || snapshot === null)
    return { status: "invalid", face: null };
  const faces = (snapshot as Partial<FaceSnapshot>).faces;
  if (
    !Array.isArray(faces) ||
    faces.length > 20 ||
    !Array.from(faces).every(isFace)
  )
    return { status: "invalid", face: null };
  // The adapter uses the same threshold. Validate again at the domain boundary.
  const visible = faces.filter((face) => face.confidence >= 0.7);
  if (visible.length === 0) return { status: "no-face", face: null };
  if (visible.length !== 1) return { status: "multiple-faces", face: null };
  const face = visible[0];
  const { x, y, width, height } = face.box;
  if (width < 0.24 || height < 0.28) return { status: "too-far", face };
  if (width > 0.8 || height > 0.84) return { status: "too-close", face };
  if (
    Math.abs(x + width / 2 - 0.5) > 0.13 ||
    Math.abs(y + height / 2 - 0.46) > 0.16 ||
    x < 0.03 ||
    y < 0.03 ||
    x + width > 0.97 ||
    y + height > 0.97
  )
    return { status: "off-center", face };
  return { status: "ready", face };
}
