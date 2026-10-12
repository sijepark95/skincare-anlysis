import { describe, expect, it } from "vitest";
import { assessFaceCapture, type FaceObservation } from "@/domain/face-capture";

const face = (box: Partial<FaceObservation["box"]> = {}): FaceObservation => ({
  box: { x: 0.3, y: 0.2, width: 0.4, height: 0.52, ...box },
  keypoints: [{ x: 0.5, y: 0.4 }],
  confidence: 0.9,
});

describe("transient face capture policy", () => {
  it("requires exactly one credible face before allowing capture", () => {
    expect(assessFaceCapture({ faces: [] }).status).toBe("no-face");
    expect(assessFaceCapture({ faces: [face(), face()] }).status).toBe(
      "multiple-faces",
    );
    expect(assessFaceCapture({ faces: [face()] }).status).toBe("ready");
    expect(
      assessFaceCapture({ faces: [{ ...face(), confidence: 0.69 }] }).status,
    ).toBe("no-face");
    expect(
      assessFaceCapture({
        faces: [face(), { ...face(), confidence: 0.69 }],
      }).status,
    ).toBe("ready");
  });

  it.each([
    [{ width: 0.23 }, "too-far"],
    [{ height: 0.27 }, "too-far"],
    [{ x: 0.09, width: 0.81 }, "too-close"],
    [{ y: 0.05, height: 0.85 }, "too-close"],
    [{ x: 0.02 }, "off-center"],
    [{ y: 0.02 }, "off-center"],
    [{ x: 0.56 }, "off-center"],
    [{ y: 0.43 }, "off-center"],
  ])("guides size and position with %j", (box, status) => {
    expect(assessFaceCapture({ faces: [face(box)] }).status).toBe(status);
  });

  it.each([
    null,
    undefined,
    [],
    {},
    { faces: {} },
    { faces: [null] },
    { faces: [undefined] },
    { faces: Array(1) },
    { faces: Array(21).fill(face()) },
    { faces: [{ ...face(), confidence: NaN }] },
    { faces: [{ ...face(), confidence: Infinity }] },
    { faces: [{ ...face(), confidence: -0.1 }] },
    { faces: [{ ...face(), confidence: 1.01 }] },
    { faces: [face({ x: NaN })] },
    { faces: [face({ x: -0.01 })] },
    { faces: [face({ width: 0 })] },
    { faces: [face({ height: 1.1 })] },
    { faces: [face({ x: 0.7 })] },
    { faces: [{ ...face(), keypoints: [null] }] },
    { faces: [{ ...face(), keypoints: Array(1) }] },
    { faces: [{ ...face(), keypoints: [{ x: 0.5, y: Infinity }] }] },
    { faces: [{ ...face(), keypoints: Array(7).fill({ x: 0.5, y: 0.5 }) }] },
  ])("fails closed on malformed or unbounded geometry %#", (input) => {
    expect(assessFaceCapture(input)).toEqual({ status: "invalid", face: null });
  });

  it("returns only local alignment geometry and never mutates it", () => {
    const current = face();
    const input = { faces: [current] };
    const serialized = JSON.stringify(input);
    expect(assessFaceCapture(input)).toEqual({
      status: "ready",
      face: current,
    });
    expect(JSON.stringify(input)).toBe(serialized);
  });
});
