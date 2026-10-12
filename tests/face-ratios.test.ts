import { describe, expect, it } from "vitest";
import { calculateFaceRatios, type FaceRatioPoint } from "@/domain/face-ratios";
const quality = { meanLuma: 130, laplacianVariance: 100, sideDifference: 10 };
function fixture(): FaceRatioPoint[] {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  for (const [index, x, y] of [
    [234, 0.25, 0.5],
    [454, 0.75, 0.5],
    [1, 0.5, 0.5],
    [33, 0.32, 0.38],
    [133, 0.42, 0.38],
    [159, 0.37, 0.365],
    [145, 0.37, 0.395],
    [362, 0.58, 0.38],
    [263, 0.68, 0.38],
    [386, 0.63, 0.365],
    [374, 0.63, 0.395],
    [98, 0.46, 0.52],
    [327, 0.54, 0.52],
    [61, 0.4, 0.65],
    [291, 0.6, 0.65],
    [0, 0.5, 0.625],
    [13, 0.5, 0.645],
    [14, 0.5, 0.655],
    [17, 0.5, 0.675],
  ])
    points[index] = { x, y };
  return points;
}
describe("local photo landmark ratios", () => {
  it("computes actual image-plane ratios, without scores or percentiles", () => {
    expect(calculateFaceRatios([fixture()], 1000, 1000, quality)).toEqual({
      status: "measured",
      eyeHeightWidth: 30,
      noseFaceWidth: 16,
      lipMouthWidth: 20,
    });
  });
  it("accounts for capture aspect ratio rather than treating normalized axes as pixels", () => {
    expect(calculateFaceRatios([fixture()], 1000, 500, quality)).toEqual({
      status: "measured",
      eyeHeightWidth: 15,
      noseFaceWidth: 16,
      lipMouthWidth: 10,
    });
  });
  it.each([{ faces: [] }, { faces: [fixture(), fixture()] }])(
    "requires exactly one face",
    ({ faces }) => {
      expect(calculateFaceRatios(faces, 1000, 1000, quality)).toEqual({
        status: "unavailable",
        reason: "face_count",
      });
    },
  );
  it("rejects missing or nonfinite geometry", () => {
    const points = fixture();
    points[98].x = NaN;
    expect(calculateFaceRatios([points], 1000, 1000, quality)).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(
      calculateFaceRatios([[{ x: 0.5, y: 0.5 }]], 1000, 1000, quality),
    ).toEqual({ status: "unavailable", reason: "unavailable" });
  });
  it("rejects clipped or too-small faces", () => {
    const clipped = fixture();
    clipped[234].x = 0.01;
    expect(calculateFaceRatios([clipped], 1000, 1000, quality)).toEqual({
      status: "unavailable",
      reason: "crop",
    });
    expect(calculateFaceRatios([fixture()], 256, 256, quality)).toEqual({
      status: "unavailable",
      reason: "crop",
    });
  });
  it("rejects visible yaw or roll proxies", () => {
    const yaw = fixture();
    yaw[1].x = 0.62;
    expect(calculateFaceRatios([yaw], 1000, 1000, quality)).toEqual({
      status: "unavailable",
      reason: "pose",
    });
    const roll = fixture();
    roll[263].y = 0.48;
    expect(calculateFaceRatios([roll], 1000, 1000, quality)).toEqual({
      status: "unavailable",
      reason: "pose",
    });
  });
  it("rejects closed eyes and open mouth rather than measuring altered expression", () => {
    const closed = fixture();
    closed[145] = closed[159];
    expect(calculateFaceRatios([closed], 1000, 1000, quality)).toEqual({
      status: "unavailable",
      reason: "expression",
    });
    const open = fixture();
    open[14].y = 0.7;
    expect(calculateFaceRatios([open], 1000, 1000, quality)).toEqual({
      status: "unavailable",
      reason: "expression",
    });
  });
  it.each([
    { meanLuma: 20 },
    { meanLuma: 250 },
    { laplacianVariance: 2 },
    { sideDifference: 50 },
    { meanLuma: NaN },
  ])("fails closed for lighting and blur quality %j", (change) => {
    expect(
      calculateFaceRatios([fixture()], 1000, 1000, { ...quality, ...change }),
    ).toEqual({ status: "unavailable", reason: "quality" });
  });
});
