import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function jumpIntoStory(page: Page, fraction: number) {
  await expect(page.locator("#experience")).toHaveAttribute(
    "data-story-mode",
    "cinematic",
  );
  await page.locator("#experience").evaluate((section, progress) => {
    const stage = section.querySelector<HTMLElement>(".aelune-story-stage")!;
    const top = section.getBoundingClientRect().top + window.scrollY;
    const travel = section.clientHeight - stage.clientHeight;
    window.scrollTo({ top: top + travel * progress, behavior: "instant" });
  }, fraction);
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}

async function fullViewportMedia(
  page: Page,
  stageSelector: string,
  mediaSelectors: string[],
) {
  const bounds = await page.evaluate(
    ({ stageSelector, mediaSelectors }) => {
      const read = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing media element: ${selector}`);
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      return {
        stage: read(stageSelector),
        media: mediaSelectors.map(read),
        viewport: { width: innerWidth, height: innerHeight },
      };
    },
    { stageSelector, mediaSelectors },
  );
  expect(Math.abs(bounds.stage.left)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(bounds.stage.right - bounds.viewport.width),
  ).toBeLessThanOrEqual(1);
  expect(bounds.stage.height).toBeGreaterThanOrEqual(
    bounds.viewport.height - 1,
  );
  for (const media of bounds.media) {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      expect(
        Math.abs(media[edge] - bounds.stage[edge]),
        `${stageSelector} media ${edge} edge`,
      ).toBeLessThanOrEqual(1);
    }
  }
}

async function withinViewport(page: Page, selector: string) {
  const bounds = await page.locator(selector).boundingBox();
  expect(bounds).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test("the native scroll story paints forward and backward while inactive chapters stay out of keyboard order", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await fullViewportMedia(page, ".aelune-hero", [
      ".aelune-hero-image",
      ".aelune-hero-image img",
    ]);
    const story = page.locator("#experience");
    const stage = story.locator(".aelune-story-stage");
    const canvas = story.locator("canvas");
    const manifest = await (
      await page.request.get("/media/aelune/story/manifest.json")
    ).json();
    await expect(story).toHaveAttribute("data-story-mode", "cinematic");
    await jumpIntoStory(page, 0.05);
    await expect(canvas).toHaveAttribute("data-frame-ready", "true");
    await fullViewportMedia(page, "#experience .aelune-story-stage", [
      "#experience .aelune-story-media",
      "#experience .aelune-story-media img",
      "#experience canvas",
    ]);
    const opening = Number(await canvas.getAttribute("data-frame-index"));
    await expect(stage).toHaveAttribute("data-active-chapter", "0");
    await page.screenshot({
      path: testInfo.outputPath(`story-opening-${viewport.width}.png`),
    });
    await page.mouse.wheel(0, 700);
    await expect
      .poll(async () =>
        Number(await stage.getAttribute("data-scroll-progress")),
      )
      .toBeGreaterThan(0.1);
    const afterWheel = Number(await stage.getAttribute("data-scroll-progress"));
    await page.mouse.wheel(0, -500);
    await expect
      .poll(async () =>
        Number(await stage.getAttribute("data-scroll-progress")),
      )
      .toBeLessThan(afterWheel);

    await jumpIntoStory(page, 0.34);
    await expect(stage).toHaveAttribute("data-active-chapter", "transition");
    await expect(story.locator(".aelune-story-chapter[hidden]")).toHaveCount(3);
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-frame-index")))
      .toBeGreaterThan(manifest.frameCount * 0.2);
    await page.screenshot({
      path: testInfo.outputPath(`story-ripple-${viewport.width}.png`),
    });

    await jumpIntoStory(page, 0.63);
    await expect(stage).toHaveAttribute("data-active-chapter", "1");
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-frame-index")))
      .toBeGreaterThan(manifest.frameCount * 0.7);
    const middle = Number(await canvas.getAttribute("data-frame-index"));
    expect(middle).toBeGreaterThan(opening);
    await page.screenshot({
      path: testInfo.outputPath(`story-discovery-${viewport.width}.png`),
    });
    await expect(
      story.getByRole("heading", { name: "Your beauty. Seen with care." }),
    ).toBeVisible();
    await withinViewport(
      page,
      "#experience .aelune-story-chapter:not([hidden]) h2",
    );
    await withinViewport(
      page,
      "#experience .aelune-story-chapter:not([hidden]) .aelune-story-description",
    );
    await withinViewport(page, "#experience .aelune-story-topline a");
    await withinViewport(page, "#experience .aelune-story-caption button");
    expect(
      (
        await new AxeBuilder({ page })
          .include("#experience")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await expect(
      story.getByRole("link", { name: "See how it works" }),
    ).toHaveCount(0);
    const hiddenChapters = story.locator(".aelune-story-chapter[hidden]");
    await expect(hiddenChapters).toHaveCount(2);
    for (const chapter of await hiddenChapters.all())
      await expect(chapter).toHaveAttribute("inert", "");

    await jumpIntoStory(page, 0.94);
    await expect(stage).toHaveAttribute("data-active-chapter", "2");
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-frame-index")))
      .toBeGreaterThanOrEqual(manifest.frameCount - 2);
    await page.screenshot({
      path: testInfo.outputPath(`story-resolution-${viewport.width}.png`),
    });
    await expect(
      story.getByRole("link", { name: "See how it works" }),
    ).toBeVisible();
    await withinViewport(
      page,
      "#experience .aelune-story-chapter:not([hidden]) h2",
    );
    await withinViewport(
      page,
      "#experience .aelune-story-chapter:not([hidden]) .aelune-story-description",
    );
    await withinViewport(page, "#experience .aelune-story-action");
    await jumpIntoStory(page, 0.17);
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-frame-index")))
      .toBeLessThan(middle);
    await expect(stage).toHaveAttribute("data-active-chapter", "0");
    await noOverflow(page);
  }
});

test("visitors can skip the pinned story with a real anchor", async ({
  page,
}) => {
  await page.goto("/");
  await jumpIntoStory(page, 0.1);
  const skip = page.getByRole("link", { name: "Skip the film" });
  await expect(skip).toHaveAttribute("href", "#how-it-works");
  await skip.click();
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(
    page.getByRole("heading", { name: "Less guesswork. More understanding." }),
  ).toBeInViewport();
});

test("reduced motion retains the full story and requests no motion sequence", async ({
  page,
}) => {
  const motionRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/media/aelune/story/"))
      motionRequests.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("#experience")).toHaveAttribute(
    "data-story-mode",
    "simple",
  );
  await expect(page.locator("#experience .aelune-story-chapter")).toHaveCount(
    3,
  );
  await expect(page.locator("#experience [hidden]")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "From inspiration to your own style." }),
  ).toBeVisible();
  await page
    .getByRole("heading", { name: "Your beauty. Your choice." })
    .scrollIntoViewIfNeeded();
  expect(motionRequests).toEqual([]);
  await noOverflow(page);
});

test("data-saving visitors get the content without frame requests", async ({
  page,
}) => {
  const frameRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/media/aelune/story/"))
      frameRequests.push(request.url());
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true, effectiveType: "4g" },
    });
  });
  await page.goto("/");
  await expect(page.locator("#experience")).toHaveAttribute(
    "data-story-mode",
    "simple",
  );
  await page.locator("#how-it-works").scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("link", { name: "Find your beauty direction", exact: true }),
  ).toHaveAttribute("href", "/kiosk");
  expect(frameRequests).toEqual([]);
});

test("short landscape screens keep ordinary content without requesting the sequence", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/media/aelune/story/"))
      requests.push(request.url());
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  await expect(page.locator("#experience")).toHaveAttribute(
    "data-story-mode",
    "simple",
  );
  await expect(
    page.locator("#experience .aelune-story-chapter[hidden]"),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
  await noOverflow(page);
});

test("a missing sequence leaves complete readable content and a useful still", async ({
  page,
}) => {
  await page.route("**/media/aelune/story/manifest.json", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto("/");
  await expect(page.locator("#experience")).toHaveAttribute(
    "data-story-mode",
    "simple",
  );
  await expect(
    page.locator("#experience .aelune-story-chapter[hidden]"),
  ).toHaveCount(0);
  await expect(page.locator("#experience img")).toHaveAttribute(
    "src",
    "/media/aelune/drop-poster.webp",
  );
  await expect(
    page.getByRole("heading", { name: "From inspiration to your own style." }),
  ).toBeVisible();
});

test("missing frames retry at most twice and recover to the reading experience", async ({
  page,
}) => {
  const attempts = new Map<string, number>();
  await page.route("**/media/aelune/story/*.webp", (route) => {
    const url = route.request().url();
    attempts.set(url, (attempts.get(url) ?? 0) + 1);
    return route.fulfill({ status: 404, body: "Missing frame" });
  });
  await page.goto("/");
  await expect.poll(() => attempts.size).toBeGreaterThan(0);
  await expect(page.locator("#experience")).toHaveAttribute(
    "data-story-mode",
    "simple",
  );
  expect([...attempts.values()].every((count) => count <= 2)).toBe(true);
  await expect(
    page.locator("#experience .aelune-story-chapter[hidden]"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "From inspiration to your own style." }),
  ).toBeVisible();
});

test("read without motion restores every chapter without navigating away", async ({
  page,
}) => {
  await page.goto("/");
  await jumpIntoStory(page, 0.05);
  await page.getByRole("button", { name: "Read without motion" }).click();
  await expect(page.locator("#experience")).toHaveAttribute(
    "data-story-mode",
    "simple",
  );
  await expect(
    page.locator("#experience .aelune-story-chapter[hidden]"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your beauty. Seen with care." }),
  ).toBeVisible();
});

test("a resting story preloads only nearby frames rather than the whole film", async ({
  page,
}) => {
  const frames = new Set<string>();
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/\/media\/aelune\/story\/.*\.webp$/.test(pathname))
      frames.add(pathname);
  });
  await page.goto("/");
  await jumpIntoStory(page, 0.05);
  await expect(page.locator("#experience canvas")).toHaveAttribute(
    "data-frame-ready",
    "true",
  );
  await expect.poll(() => frames.size).toBeGreaterThan(0);
  // The requested target and at most seven frames on each side form one bounded window.
  expect(frames.size).toBeLessThanOrEqual(15);
  const manifest = await (
    await page.request.get("/media/aelune/story/manifest.json")
  ).json();
  expect(manifest.frameCount).toBeGreaterThan(frames.size);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
]) {
  test(`the brand website and design tile are readable and accessible at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "A little closer. A lot clearer." }),
    ).toBeVisible();
    await fullViewportMedia(page, ".aelune-hero", [
      ".aelune-hero-image",
      ".aelune-hero-image img",
    ]);
    await expect
      .poll(() =>
        page
          .locator(".aelune-hero-image img")
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.screenshot({
      path: testInfo.outputPath(`aelune-hero-${viewport.width}.png`),
    });
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to how it works" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#how-it-works$/);
    await noOverflow(page);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    await page.screenshot({
      path: testInfo.outputPath(`aelune-site-${viewport.width}.png`),
      fullPage: true,
    });

    const unexpectedFilmRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith(".mp4"))
        unexpectedFilmRequests.push(request.url());
    });
    await page.goto("/brand");
    await expect(
      page.getByRole("heading", { name: "Beauty, seen differently." }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download editable SVG" }),
    ).toHaveAttribute("href", "/brand/aelune-wordmark.svg");
    await expect(
      page.getByRole("heading", { name: "Soft rose" }),
    ).toBeVisible();
    const film = page.locator(".brand-tile-film video");
    await expect(film).toHaveAttribute("preload", "none");
    await expect(film).toHaveJSProperty("paused", true);
    await expect(film).toHaveJSProperty("muted", true);
    await expect(film.locator("source")).toHaveAttribute(
      "src",
      "/media/aelune/inside-the-drop-web.mp4",
    );
    await expect(
      page.getByRole("link", { name: "Original film", exact: true }),
    ).toHaveAttribute("href", "/media/aelune/inside-the-drop.mp4");
    for (const image of await page.locator(".brand-tile img").all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          image.evaluate(
            (element) => (element as HTMLImageElement).naturalWidth,
          ),
        )
        .toBeGreaterThan(0);
    }
    await noOverflow(page);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`aelune-style-tile-${viewport.width}.png`),
      fullPage: true,
    });
    expect(unexpectedFilmRequests).toEqual([]);
    if (viewport.width === 1440) {
      await film.evaluate((element) => (element as HTMLVideoElement).play());
      await expect
        .poll(() =>
          film.evaluate((element) => (element as HTMLVideoElement).currentTime),
        )
        .toBeGreaterThan(0);
      expect(
        await film.evaluate((element) => (element as HTMLVideoElement).error),
      ).toBeNull();
      await film.evaluate((element) => (element as HTMLVideoElement).pause());
    }
  });
}
