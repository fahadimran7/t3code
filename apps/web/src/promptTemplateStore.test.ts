import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  promptTemplateTitle,
  readPersistedPromptTemplatesForTest,
  sortPromptTemplatesByRecentUse,
  usePromptTemplateStore,
  type PromptTemplate,
} from "./promptTemplateStore";

function makeTemplate(id: string, overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id,
    createdAt: "2026-10-01T12:00:00.000Z",
    prompt: `template ${id}`,
    attachments: [],
    ...overrides,
  };
}

function storedTemplateIds(): string[] {
  return readPersistedPromptTemplatesForTest().map((t) => t.id);
}

// Every write persists the whole list, so resetting state is enough to isolate tests.
function reset() {
  usePromptTemplateStore.setState({ templates: [] });
}

describe("usePromptTemplateStore", () => {
  beforeEach(reset);
  afterEach(reset);

  it("adds new templates first and edits existing ones in place", () => {
    const store = usePromptTemplateStore.getState();
    store.saveTemplate(makeTemplate("a"));
    store.saveTemplate(makeTemplate("b"));
    store.saveTemplate(makeTemplate("a", { prompt: "edited" }));

    const { templates } = usePromptTemplateStore.getState();
    expect(templates.map((t) => t.id)).toEqual(["b", "a"]);
    expect(templates[1]?.prompt).toBe("edited");
    expect(storedTemplateIds()).toEqual(["b", "a"]);
  });

  it("puts a removed template back at its old position on undo", () => {
    const store = usePromptTemplateStore.getState();
    for (const id of ["c", "b", "a"]) store.saveTemplate(makeTemplate(id));

    const removed = usePromptTemplateStore.getState().removeTemplate("b");
    expect(removed?.index).toBe(1);
    expect(storedTemplateIds()).toEqual(["a", "c"]);

    usePromptTemplateStore.getState().restoreTemplate(removed!.template, removed!.index);
    expect(storedTemplateIds()).toEqual(["a", "b", "c"]);
  });

  it("keeps templates when they are used", () => {
    usePromptTemplateStore.getState().saveTemplate(makeTemplate("a"));
    usePromptTemplateStore.getState().markTemplateUsed("a", "2026-10-20T09:00:00.000Z");

    expect(usePromptTemplateStore.getState().templates).toEqual([
      makeTemplate("a", { lastUsedAt: "2026-10-20T09:00:00.000Z" }),
    ]);
  });
});

describe("sortPromptTemplatesByRecentUse", () => {
  it("orders by last use, falling back to creation time", () => {
    const sorted = sortPromptTemplatesByRecentUse([
      makeTemplate("old", { createdAt: "2026-10-01T00:00:00.000Z" }),
      makeTemplate("used", {
        createdAt: "2026-09-01T00:00:00.000Z",
        lastUsedAt: "2026-10-10T00:00:00.000Z",
      }),
      makeTemplate("new", { createdAt: "2026-10-05T00:00:00.000Z" }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["used", "new", "old"]);
  });
});

describe("promptTemplateTitle", () => {
  it("uses the first non-empty line, or the image count for image-only templates", () => {
    expect(promptTemplateTitle(makeTemplate("a", { prompt: "\n  Review this diff \nmore" }))).toBe(
      "Review this diff",
    );
    expect(
      promptTemplateTitle(
        makeTemplate("b", {
          prompt: "",
          attachments: [
            { id: "i", name: "a.png", mimeType: "image/png", sizeBytes: 1, dataUrl: "data:" },
          ],
        }),
      ),
    ).toBe("1 image");
  });
});
