import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Detection } from "@mediapipe/tasks-vision";
import {
  createBrowserFaceDetector,
  normalizeFaceDetections,
} from "@/infrastructure/browser-face-detector";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  create: vi.fn(),
  detect: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: mocks.resolve },
  FaceDetector: { createFromOptions: mocks.create },
}));

const detection = (): Detection => ({
  boundingBox: { originX: 160, originY: 48, width: 320, height: 288, angle: 0 },
  categories: [{ score: 0.9, index: 0, categoryName: "face", displayName: "" }],
  keypoints: [{ x: 0.5, y: 0.4 }],
});

describe("browser-local face adapter", () => {
  let canvas: {
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
  };
  let context: {
    drawImage: ReturnType<typeof vi.fn>;
    clearRect: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.resetAllMocks();
    context = { drawImage: vi.fn(), clearRect: vi.fn() };
    canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    mocks.resolve.mockResolvedValue({ wasmLoaderPath: "local-loader" });
    mocks.create.mockResolvedValue({
      detectForVideo: mocks.detect,
      close: mocks.close,
    });
    mocks.detect.mockReturnValue({ detections: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const video = (props = {}) =>
    ({
      videoWidth: 1920,
      videoHeight: 1080,
      readyState: 4,
      ...props,
    }) as HTMLVideoElement;

  it("uses pinned same-origin paths, CPU, threshold and no supplied external endpoint", async () => {
    await createBrowserFaceDetector();
    expect(mocks.resolve).toHaveBeenCalledWith("/face/mediapipe-1.1.0/wasm");
    expect(mocks.create).toHaveBeenCalledWith(
      { wasmLoaderPath: "local-loader" },
      {
        baseOptions: {
          modelAssetPath: "/face/blaze-face-short-range-v1.tflite",
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.7,
        minSuppressionThreshold: 0.3,
      },
    );
  });

  it("bounds camera pixels to 640px and clears them after each detection", async () => {
    const adapter = await createBrowserFaceDetector();
    const frame = video();
    expect(adapter.detect(frame)).toEqual({ faces: [] });
    expect(context.drawImage).toHaveBeenCalledWith(frame, 0, 0, 640, 360);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 640, 360);
    expect(mocks.detect).toHaveBeenCalledWith(canvas, expect.any(Number));
  });

  it("uses strictly increasing timestamps even with a stalled clock", async () => {
    vi.stubGlobal("performance", { now: () => 20 });
    const adapter = await createBrowserFaceDetector();
    adapter.detect(video());
    adapter.detect(video());
    expect(mocks.detect.mock.calls.map((call) => call[1])).toEqual([20, 21]);
  });

  it("clears pixels after a detector failure and releases resources once", async () => {
    const adapter = await createBrowserFaceDetector();
    mocks.detect.mockImplementation(() => {
      throw new Error("fixture failure");
    });
    expect(() => adapter.detect(video())).toThrow("fixture failure");
    expect(context.clearRect).toHaveBeenCalledOnce();
    adapter.close();
    adapter.close();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(() => adapter.detect(video())).toThrow(
      "Face detection is unavailable.",
    );
  });

  it("closes the allocated engine when canvas is unsupported", async () => {
    canvas.getContext.mockReturnValue(null);
    await expect(createBrowserFaceDetector()).rejects.toThrow("unavailable");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("fails closed outside supported browser runtime", async () => {
    vi.stubGlobal("document", undefined);
    await expect(createBrowserFaceDetector()).rejects.toThrow("unavailable");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("bounds initialization time and closes an engine that arrives after timeout", async () => {
    vi.useFakeTimers();
    let resolveEngine!: (value: unknown) => void;
    mocks.create.mockReturnValue(
      new Promise((resolve) => {
        resolveEngine = resolve;
      }),
    );
    const initialization = createBrowserFaceDetector();
    const failure = expect(initialization).rejects.toThrow("Please try again");
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    resolveEngine({ detectForVideo: mocks.detect, close: mocks.close });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    { videoWidth: 0 },
    { videoHeight: -1 },
    { videoWidth: NaN },
    { videoHeight: Infinity },
    { videoWidth: 9000 },
    { videoHeight: 9000 },
    { readyState: 1 },
    { readyState: NaN },
    { readyState: 5 },
  ])(
    "does not analyze an invalid or unavailable camera frame %j",
    async (props) => {
      const adapter = await createBrowserFaceDetector();
      expect(() => adapter.detect(video(props))).toThrow("not ready");
      expect(mocks.detect).not.toHaveBeenCalled();
    },
  );

  it("normalizes pixel boxes and bounded landmarks without metadata", () => {
    expect(normalizeFaceDetections([detection()], 640, 480)).toEqual({
      faces: [
        {
          box: { x: 0.25, y: 0.1, width: 0.5, height: 0.6 },
          confidence: 0.9,
          keypoints: [{ x: 0.5, y: 0.4 }],
        },
      ],
    });
    const edge = detection();
    edge.boundingBox!.originX = -160;
    edge.keypoints = [{ x: -0.1, y: 1.1 }];
    expect(normalizeFaceDetections([edge], 640, 480).faces[0]).toMatchObject({
      box: { x: 0, width: 0.25 },
      keypoints: [{ x: 0, y: 1 }],
    });
  });

  it.each([NaN, 0, 641, 0.5])("refuses invalid frame bounds %s", (width) => {
    expect(() => normalizeFaceDetections([], width, 480)).toThrow(
      "unavailable",
    );
  });

  it.each([
    null,
    {},
    { ...detection(), boundingBox: undefined },
    { ...detection(), categories: [] },
    { ...detection(), categories: [{ score: NaN }] },
    { ...detection(), categories: [{ score: 1.1 }] },
    {
      ...detection(),
      boundingBox: { originX: NaN, originY: 0, width: 1, height: 1 },
    },
    {
      ...detection(),
      boundingBox: { originX: 9000, originY: 0, width: 1, height: 1 },
    },
    { ...detection(), keypoints: [null] },
    { ...detection(), keypoints: Array(1) },
    { ...detection(), keypoints: [{ x: Infinity, y: 0.5 }] },
    { ...detection(), keypoints: Array(7).fill({ x: 0.5, y: 0.5 }) },
  ])("refuses malformed detector output %#", (input) => {
    expect(() =>
      normalizeFaceDetections([input as Detection], 640, 480),
    ).toThrow("unavailable");
  });
});
