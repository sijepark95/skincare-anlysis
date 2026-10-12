export interface FaceRatioPoint {
  x: number;
  y: number;
  z?: number;
}
export type FaceRatioFailure =
  "unavailable" | "face_count" | "crop" | "pose" | "expression" | "quality";
export type FaceRatios =
  | {
      status: "measured";
      eyeHeightWidth: number;
      noseFaceWidth: number;
      lipMouthWidth: number;
    }
  | { status: "unavailable"; reason: FaceRatioFailure };

/** Image-plane landmark ratios, never population percentiles, attractiveness or confidence. */
export function calculateFaceRatios(
  faces: readonly (readonly FaceRatioPoint[])[],
  width: number,
  height: number,
  quality: {
    meanLuma: number;
    laplacianVariance: number;
    sideDifference: number;
  },
): FaceRatios {
  const fail = (reason: FaceRatioFailure): FaceRatios => ({
    status: "unavailable",
    reason,
  });
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 256 ||
    height < 256 ||
    width > 4096 ||
    height > 4096
  )
    return fail("quality");
  if (faces.length !== 1) return fail("face_count");
  const points = faces[0];
  const indices = [
    0, 1, 13, 14, 17, 33, 61, 98, 133, 145, 159, 234, 263, 291, 327, 362, 374,
    386, 454,
  ];
  if (
    points.length < 455 ||
    indices.some(
      (i) =>
        !points[i] ||
        !Number.isFinite(points[i].x) ||
        !Number.isFinite(points[i].y),
    )
  )
    return fail("unavailable");
  const distance = (a: number, b: number) =>
    Math.hypot(
      (points[a].x - points[b].x) * width,
      (points[a].y - points[b].y) * height,
    );
  const bounds = indices.map((i) => points[i]);
  if (
    bounds.some((p) => p.x < 0.04 || p.x > 0.96 || p.y < 0.04 || p.y > 0.96) ||
    distance(234, 454) < 160
  )
    return fail("crop");
  const midX = (points[234].x + points[454].x) / 2;
  const faceWidth = Math.abs(points[454].x - points[234].x);
  const roll = Math.abs(
    Math.atan2(
      (points[263].y - points[33].y) * height,
      Math.abs(points[263].x - points[33].x) * width,
    ),
  );
  if (
    faceWidth < 0.15 ||
    Math.abs(points[1].x - midX) / faceWidth > 0.12 ||
    roll > 0.175
  )
    return fail("pose");
  const left = distance(159, 145) / distance(33, 133),
    right = distance(386, 374) / distance(362, 263);
  const mouthWidth = distance(61, 291);
  if (
    ![left, right, mouthWidth].every(Number.isFinite) ||
    left < 0.08 ||
    right < 0.08 ||
    mouthWidth < 30 ||
    distance(13, 14) / mouthWidth > 0.09
  )
    return fail("expression");
  if (
    !Object.values(quality).every(Number.isFinite) ||
    quality.meanLuma < 40 ||
    quality.meanLuma > 235 ||
    quality.laplacianVariance < 18 ||
    quality.sideDifference > 45
  )
    return fail("quality");
  const round = (value: number) => Math.round(value * 1000) / 10;
  const result = {
    status: "measured" as const,
    eyeHeightWidth: round((left + right) / 2),
    noseFaceWidth: round(distance(98, 327) / distance(234, 454)),
    lipMouthWidth: round((distance(0, 13) + distance(14, 17)) / mouthWidth),
  };
  return [
    result.eyeHeightWidth,
    result.noseFaceWidth,
    result.lipMouthWidth,
  ].every((value) => value > 0 && value < 100)
    ? result
    : fail("unavailable");
}
