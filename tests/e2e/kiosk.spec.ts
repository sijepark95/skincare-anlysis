import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const baseURL = "http://127.0.0.1:3100";

async function start(page: Page) {
  await page.goto("/kiosk/skin");
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/kiosk/sessions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Let's get started" }).click();
  const session = await (await response).json();
  await expect(
    page.getByRole("heading", {
      name: "A moment for you. With your permission.",
    }),
  ).toBeVisible();
  return session.id as string;
}

async function consentAndPreferences(page: Page, excludeFragrance = false) {
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await page
    .getByRole("button", { name: /Dry Often feels tight or dry/ })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Hydration", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  if (excludeFragrance)
    await page.getByRole("button", { name: "Fragrance", exact: true }).click();
  await page.getByRole("button", { name: "Continue to photo" }).click();
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

async function syntheticFaceCamera(page: Page, pixelScale = 1) {
  await page.addInitScript((scale) => {
    const state = {
      requested: 0,
      stopped: 0,
      revoked: 0,
      visible: true,
      capturedWidth: 0,
      capturedHeight: 0,
    };
    Object.defineProperty(window, "__cameraAudit", { value: state });
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      state.stopped += 1;
      return stop.call(this);
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      state.revoked += 1;
      revoke(url);
    };
    const createUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob && blob.type === "image/jpeg")
        void createImageBitmap(blob).then((image) => {
          state.capturedWidth = image.width;
          state.capturedHeight = image.height;
          image.close();
        });
      return createUrl(blob);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      state.requested++;
      // An approved generated campaign portrait, never a customer/dataset image.
      // The real self-hosted detector sees pixels from a real canvas video track.
      const image = new Image();
      image.src = "/media/hero-poster.png";
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 640 * scale;
      canvas.height = 780 * scale;
      const context = canvas.getContext("2d")!;
      context.scale(scale, scale);
      const draw = () => {
        context.fillStyle = "#faf8f5";
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (state.visible)
          context.drawImage(image, 760, 0, 640, 780, 0, 0, 640, 780);
      };
      draw();
      const timer = setInterval(draw, 40);
      const media = canvas.captureStream(25);
      const track = media.getVideoTracks()[0];
      const stopTrack = track.stop.bind(track);
      track.stop = () => {
        clearInterval(timer);
        stopTrack();
      };
      return media;
    };
  }, pixelScale);
}

test("a stale development context response cannot replace the active kiosk device", async ({
  page,
  request,
}) => {
  let calls = 0;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let staleComplete!: () => void;
  const staleFinished = new Promise<void>((resolve) => {
    staleComplete = resolve;
  });
  await page.route("**/api/v1/context", async (route) => {
    const call = ++calls;
    const response = await request.get(route.request().url(), {
      headers: { cookie: "" },
    });
    if (call === 1) await delayed;
    await route.fulfill({ response }).catch(() => undefined);
    if (call === 1) staleComplete();
  });
  await start(page);
  await expect.poll(() => calls).toBe(2);
  release();
  await staleFinished;
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await expect(
    page.getByRole("heading", { name: "How does your skin usually feel?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "End session", exact: true }).click();
});

test("consent is explicit and declining clears the anonymous consultation", async ({
  page,
}) => {
  const id = await start(page);
  await expect(
    page.getByRole("button", { name: "I agree, let's begin" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "No thanks, end session" }).click();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await page.request.get(`/api/v1/kiosk/sessions/${id}`)).status(),
    )
    .toBe(404);
});

test("mock results honor an ingredient exclusion and finish clears all customer state", async ({
  page,
}) => {
  const product = {
    sku: "000-E2E-FRAGRANCE",
    brand: "SENMIVA LAB",
    name: "E2E Fragrance Serum",
    category: "serum",
    priceMinor: 1000,
    currency: "USD",
    stock: 10,
    visible: false,
    ingredients: ["Aqua", "Glycerin", "Parfum"],
    formulaComplete: true,
    suitableSkinTypes: ["dry"],
  };
  const headers = { origin: baseURL };
  expect(
    (
      await page.request.post("/api/v1/management/products", {
        data: product,
        headers,
      })
    ).ok(),
  ).toBe(true);
  const catalog = await (
    await page.request.get("/api/v1/management/catalog")
  ).json();
  const row = catalog.products.find(
    (item: { sku: string }) => item.sku === product.sku,
  );
  expect(
    (
      await page.request.post(`/api/v1/management/products/${row.id}/publish`, {
        data: {},
        headers,
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.patch(
        `/api/v1/management/products/${row.id}/listing`,
        { data: { stock: 10, priceMinor: 1000, visible: true }, headers },
      )
    ).ok(),
  ).toBe(true);
  const id = await start(page);
  await consentAndPreferences(page, true);
  const analysisResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/${id}/analysis`) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Continue with mock experience" })
    .click();
  const result = await (await analysisResponse).json();
  expect(result.answers.excludedIngredients).toEqual(["Parfum"]);
  expect(result.analysis.mode).toBe("mock");
  expect(result.analysis.quality_status).toBe("demo");
  expect(result.recommendations.length).toBeGreaterThan(0);
  expect(
    result.recommendations.every(
      (item: { product: { ingredients: string[] } }) =>
        !item.product.ingredients.includes("Parfum"),
    ),
  ).toBe(true);
  await expect(page.getByText(/Simulated results ·/)).toBeVisible();
  await expect(page.getByText(product.name, { exact: true })).toHaveCount(0);
  await expectNoOverflow(page);
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await page.request.get(`/api/v1/kiosk/sessions/${id}`)).status(),
    )
    .toBe(404);
});

test("90-second warning and 120-second inactivity reset clear the session", async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  const id = await start(page);
  await page.clock.fastForward(90_000);
  await expect(
    page.getByRole("dialog", { name: "Still enjoying your moment?" }),
  ).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.request.get(`/api/v1/kiosk/sessions/${id}`)).status(),
    )
    .toBe(404);
});

test("the inactivity warning Finish button clears the consultation when clicked", async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  const id = await start(page);
  await page.clock.fastForward(90_000);
  const dialog = page.getByRole("dialog", {
    name: "Still enjoying your moment?",
  });
  await expect(dialog).toBeVisible();
  const finish = dialog.getByRole("button", { name: "Finish and clear now" });
  await finish.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(finish).toBeFocused();
  await finish.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await page.request.get(`/api/v1/kiosk/sessions/${id}`)).status(),
    )
    .toBe(404);
});

test("page exit and persisted history restoration cannot display an old customer's results", async ({
  page,
}) => {
  const id = await start(page);
  await consentAndPreferences(page, true);
  await page
    .getByRole("button", { name: "Continue with mock experience" })
    .click();
  await expect(page.getByText(/Simulated results ·/)).toBeVisible();

  // Exercise the lifecycle event directly because browser BFCache eligibility
  // varies in development; verify normal Back/Forward navigation separately.
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect(page.getByText(/Simulated results ·/)).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.request.get(`/api/v1/kiosk/sessions/${id}`)).status(),
    )
    .toBe(404);

  await page.goto("/");
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(baseURL + "/");
  await page.goBack();
  await expect(page.getByText(/Simulated results ·/)).toHaveCount(0);

  const restoredId = await start(page);
  await expect(
    page.getByRole("checkbox", { name: /I agree to this temporary session/ }),
  ).not.toBeChecked();
  await consentAndPreferences(page);
  await page
    .getByRole("button", { name: "Continue with mock experience" })
    .click();
  await expect(page.getByText(/Simulated results ·/)).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect(page.getByText(/Simulated results ·/)).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.request.get(`/api/v1/kiosk/sessions/${restoredId}`)).status(),
    )
    .toBe(404);
});

test("a late consent response cannot reopen a session after the customer ends it", async ({
  page,
}) => {
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route("**/api/v1/kiosk/sessions/*/consent", async (route) => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  const id = await start(page);
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await intercepted;
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  const delivered = page.waitForResponse((response) =>
    response.url().endsWith(`/${id}/consent`),
  );
  release();
  await delivered;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "How does your skin usually feel?" }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.request.get(`/api/v1/kiosk/sessions/${id}`)).status(),
    )
    .toBe(404);
});

test("a late camera permission result is stopped after navigating Back", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { ready: false, stopped: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(window, "__delayedCamera", {
      value: { state, release: () => release() },
    });
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      state.stopped += 1;
      return stop.call(this);
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      state.ready = true;
      await gate;
      return stream;
    };
  });
  await start(page);
  await consentAndPreferences(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __delayedCamera: { state: { ready: boolean } };
            }
          ).__delayedCamera.state.ready,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Let's make it comfortable for you." }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __delayedCamera: { release: () => void } }
    ).__delayedCamera.release(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __delayedCamera: { state: { stopped: number } };
            }
          ).__delayedCamera.state.stopped,
      ),
    )
    .toBeGreaterThan(0);
  await expect(page.locator("video")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Let's make it comfortable for you." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "End session", exact: true }).click();
});

test("a centered face automatically counts down, captures and analyzes without exporting demo pixels", async ({
  page,
}) => {
  // Simulate a camera ignoring the ideal resolution: native frame is 2560x3120.
  await syntheticFaceCamera(page, 4);
  const bodies: { contentType: string; body: string }[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/v1/") &&
      ["POST", "PUT", "PATCH"].includes(request.method())
    )
      bodies.push({
        contentType: request.headers()["content-type"] ?? "",
        body: request.postData() ?? "",
      });
  });
  await start(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __cameraAudit: { requested: number } })
          .__cameraAudit.requested,
    ),
  ).toBe(0);
  await consentAndPreferences(page);
  await expect(page.locator("video")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).videoWidth),
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".capture-countdown")).toHaveText("3", {
    timeout: 20000,
  });
  await page.screenshot({ path: test.info().outputPath("face-countdown.png") });
  await expect(page.getByText(/Simulated results ·/)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __cameraAudit: { capturedHeight: number } })
            .__cameraAudit.capturedHeight,
      ),
    )
    .toBe(1920);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __cameraAudit: { capturedWidth: number } })
          .__cameraAudit.capturedWidth,
    ),
  ).toBe(1575);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __cameraAudit: { stopped: number } })
            .__cameraAudit.stopped,
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __cameraAudit: { revoked: number } })
            .__cameraAudit.revoked,
      ),
    )
    .toBeGreaterThan(0);
  expect(bodies.length).toBeGreaterThan(2);
  for (const request of bodies) {
    expect(request.contentType).toContain("application/json");
    expect(request.body).not.toMatch(
      /data:image|base64|multipart\/form-data|blob:/i,
    );
    expect(request.body.length).toBeLessThan(2000);
    expect(Object.keys(JSON.parse(request.body))).not.toContain("photo");
  }
  await page.getByRole("button", { name: "Finish & clear session" }).click();
});

test("losing the face cancels the countdown and a fresh centered face restarts it", async ({
  page,
}) => {
  await syntheticFaceCamera(page);
  let analyses = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/analysis")) analyses++;
  });
  await start(page);
  await consentAndPreferences(page);
  await expect(page.locator(".capture-countdown")).toHaveText("3", {
    timeout: 20000,
  });
  await page.evaluate(() => {
    (
      window as unknown as { __cameraAudit: { visible: boolean } }
    ).__cameraAudit.visible = false;
  });
  await expect(page.locator(".capture-countdown")).toHaveCount(0);
  await expect(page.locator(".face-position-status")).toContainText(
    "Center your face",
  );
  await page.waitForTimeout(3400);
  expect(analyses).toBe(0);
  await page.evaluate(() => {
    (
      window as unknown as { __cameraAudit: { visible: boolean } }
    ).__cameraAudit.visible = true;
  });
  await expect(page.locator(".capture-countdown")).toHaveText("3");
  await expect(page.getByText(/Simulated results ·/)).toBeVisible();
  expect(analyses).toBe(1);
  await page.getByRole("button", { name: "Finish & clear session" }).click();
});

test("Back during countdown clears camera and never captures a late frame", async ({
  page,
}) => {
  await syntheticFaceCamera(page);
  let analyses = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/analysis")) analyses++;
  });
  await start(page);
  await consentAndPreferences(page);
  await expect(page.locator(".capture-countdown")).toHaveText("3", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await page.waitForTimeout(3400);
  expect(analyses).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __cameraAudit: { stopped: number } })
          .__cameraAudit.stopped,
    ),
  ).toBeGreaterThan(0);
  await page.getByRole("button", { name: "End session", exact: true }).click();
});

test("denied automatic camera access leaves retry and photo-free continuation usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await start(page);
  await consentAndPreferences(page);
  await expect(
    page.getByText("Camera access isn't available.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry camera" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Continue with mock experience" })
    .click();
  await expect(page.getByText(/Simulated results ·/)).toBeVisible();
  await page.getByRole("button", { name: "Finish & clear session" }).click();
});

test("tablet welcome and consent are accessible and fit landscape and portrait widths", async ({
  page,
}, testInfo) => {
  await page.goto("/kiosk/skin");
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeEnabled();
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoOverflow(page);
    const header = await page.locator(".kiosk-header").boundingBox();
    expect(header?.y).toBeLessThan(10);
    expect(header?.width).toBeGreaterThan(viewport.width * 0.9);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      accessibility.violations,
      JSON.stringify(
        accessibility.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
      ),
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(
        `kiosk-${viewport.width}x${viewport.height}.png`,
      ),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Let's get started" }).click();
  await expect(
    page.getByRole("checkbox", { name: /I agree to this temporary session/ }),
  ).toBeVisible();
  await expectNoOverflow(page);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations,
    JSON.stringify(
      accessibility.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ),
  ).toEqual([]);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectNoOverflow(page);
  const landscapeConsent = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(landscapeConsent.violations).toEqual([]);
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await expect(
    page.getByRole("heading", { name: "How does your skin usually feel?" }),
  ).toBeVisible();
  await expectNoOverflow(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const continueAction = await page
    .getByRole("button", { name: "Continue", exact: true })
    .boundingBox();
  expect(continueAction).not.toBeNull();
  expect(continueAction!.y + continueAction!.height).toBeLessThanOrEqual(768);
  const skinAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(skinAccessibility.violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("kiosk-skin-question-1024x768.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "End session", exact: true }).click();
});
