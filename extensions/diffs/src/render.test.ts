import { disposeHighlighter } from "@pierre/diffs";
import { afterEach, expect, it } from "vitest";
import { resolveDiffImageRenderOptions, resolveDiffsPluginDefaults } from "./config.js";
import { renderDiffDocument } from "./render.js";

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);
const renderOptions = {
  presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
  image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
  expandUnchanged: false,
};
const summaryNav = '<nav class="oc-diff-card oc-diff-nav"';

function contains(html: string | undefined, fragments: string[]) {
  for (const fragment of fragments) {
    expect(html).toContain(fragment);
  }
}

function patchFile(name: string, lines = "-const x = 1;\n+const x = 2;", hunk = "@@ -1 +1 @@") {
  return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${hunk}\n${lines}`;
}

afterEach(disposeHighlighter);

it("renders before/after input into a complete viewer document", async () => {
  const rendered = await renderDiffDocument(
    {
      kind: "before_after",
      before: "const value = 1;\n",
      after: "const value = 2;\n",
      path: "src/example.ts",
    },
    renderOptions,
  );

  expect(rendered).toMatchObject({ title: "src/example.ts", fileCount: 1 });
  contains(rendered.html, [
    "data-openclaw-diff-root",
    "src/example.ts",
    "../../assets/viewer.js",
    "min-height: 100vh;",
    '"diffIndicators":"bars"',
    '"disableLineNumbers":false',
    "--diffs-line-height: 24px;",
    "--diffs-font-size: 15px;",
    "@media (prefers-reduced-motion: reduce)",
    "scroll-behavior: auto;",
  ]);
  contains(rendered.imageHtml, [
    "../../assets/viewer.js",
    "max-width: 960px;",
    "--diffs-font-size: 16px;",
  ]);
  expect(rendered.html).not.toContain("fonts.googleapis.com");
  expect(rendered.html).not.toContain(summaryNav);
});

it("renders multi-file navigation with counts, change labels, and escaped names", async () => {
  const patch = [
    patchFile(
      "a.ts",
      "-const a = 1;\n+const a = 2;\n+const extra = true;\n const keep = 0;",
      "@@ -1,2 +1,3 @@",
    ),
    patchFile("b.ts", "-const b = 1;\n+const b = 2;"),
    patchFile("new.ts", "+const created = true;", "@@ -0,0 +1 @@").replace(
      "--- a/new.ts",
      "new file mode 100644\n--- /dev/null",
    ),
    patchFile("old.ts", "-const removed = true;", "@@ -1 +0,0 @@")
      .replace("--- a/old.ts", "deleted file mode 100644\n--- a/old.ts")
      .replace("+++ b/old.ts", "+++ /dev/null"),
    "diff --git a/before.ts b/after.ts\nsimilarity index 90%\nrename from before.ts\nrename to after.ts",
    "--- a/before.ts\n+++ b/after.ts\n@@ -1 +1 @@\n-const v = 1;\n+const v = 2;",
    patchFile("a&b.ts", "-x\n+y"),
  ].join("\n");

  const rendered = await renderDiffDocument(
    { kind: "patch", patch, title: "Workspace patch" },
    {
      presentation: { ...DEFAULT_DIFFS_TOOL_DEFAULTS, layout: "split", theme: "dark" },
      image: resolveDiffImageRenderOptions({
        defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
        fileQuality: "hq",
        fileMaxWidth: 1180,
      }),
      expandUnchanged: true,
    },
  );
  expect(rendered).toMatchObject({ title: "Workspace patch", fileCount: 6 });
  contains(rendered.html, [
    "Workspace patch",
    `${summaryNav} aria-label="Changed files">`,
    "6 changed files",
    '<span class="oc-diff-nav-additions">+6</span><span class="oc-diff-nav-deletions">-5</span>',
    '<span class="oc-diff-nav-additions">+2</span><span class="oc-diff-nav-deletions">-1</span>',
    'href="#oc-diff-file-1"',
    'id="oc-diff-file-1"',
    'href="#oc-diff-file-2"',
    'id="oc-diff-file-2"',
    "before.ts &rarr; after.ts",
    "a&amp;b.ts",
  ]);
  contains(rendered.imageHtml, ["max-width: 1180px;", summaryNav]);
  for (const change of ["added", "deleted", "renamed"]) {
    expect(rendered.html).toContain(
      `<span class="oc-diff-nav-badge" data-change="${change}">${change}</span>`,
    );
  }
});

it("omits the summary nav for single-file patches", async () => {
  const rendered = await renderDiffDocument(
    { kind: "patch", patch: patchFile("solo.ts") },
    renderOptions,
    "viewer",
  );
  expect(rendered.fileCount).toBe(1);
  expect(rendered.html).not.toContain(summaryNav);
});

it("rejects patches that exceed file-count limits", async () => {
  const patch = Array.from({ length: 129 }, (_, i) => patchFile(`f${i}.ts`)).join("\n");

  await expect(renderDiffDocument({ kind: "patch", patch }, renderOptions)).rejects.toThrow(
    "too many files",
  );
});
