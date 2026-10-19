import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  type ComposerThreadTarget,
  composerTargetKey,
  PersistedComposerImageAttachment,
} from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

export const PROMPT_TEMPLATES_STORAGE_KEY = "t3code:prompt-templates:v1";

/**
 * Templates keep text and images only. A file attachment is a pending server upload that the
 * server sweeps after 24 hours, so a reusable reference to one would stop sending a day later.
 */
const PromptTemplateSchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.optionalKey(Schema.String),
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
});
export type PromptTemplate = typeof PromptTemplateSchema.Type;

const PersistedPromptTemplates = Schema.Struct({
  templates: Schema.Array(PromptTemplateSchema),
});
const decodePersistedPromptTemplates = Schema.decodeUnknownSync(PersistedPromptTemplates);

function resolveStorage(): StateStorage {
  // Reading the `localStorage` property itself throws when storage is blocked by policy.
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {}
  return createMemoryStorage();
}

const storage = resolveStorage();

function persistTemplates(templates: ReadonlyArray<PromptTemplate>): boolean {
  try {
    storage.setItem(PROMPT_TEMPLATES_STORAGE_KEY, JSON.stringify({ templates }));
    return true;
  } catch (error) {
    console.error("[PROMPT-TEMPLATES] Could not persist templates (storage quota?).", error);
    return false;
  }
}

function readPersistedTemplates(): ReadonlyArray<PromptTemplate> {
  try {
    const raw = storage.getItem(PROMPT_TEMPLATES_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return [];
    return decodePersistedPromptTemplates(JSON.parse(raw)).templates;
  } catch {
    return [];
  }
}

interface PromptTemplateStoreState {
  templates: ReadonlyArray<PromptTemplate>;
  /** Replaces the template with the same id in place, or adds it. False when storage rejected it. */
  saveTemplate: (template: PromptTemplate) => boolean;
  removeTemplate: (templateId: string) => { template: PromptTemplate; index: number } | null;
  /** Puts a removed template back where it was, for undo. */
  restoreTemplate: (template: PromptTemplate, index: number) => boolean;
  markTemplateUsed: (templateId: string, usedAt: string) => void;
}

export const usePromptTemplateStore = create<PromptTemplateStoreState>()((set, get) => {
  // State only changes after a successful write, so a rejected write cannot show a template that
  // a reload would lose.
  const commit = (templates: ReadonlyArray<PromptTemplate>) => {
    if (!persistTemplates(templates)) return false;
    set({ templates });
    return true;
  };
  return {
    templates: readPersistedTemplates(),
    saveTemplate: (template) => {
      const templates = get().templates;
      const index = templates.findIndex((candidate) => candidate.id === template.id);
      return commit(
        index === -1
          ? [template, ...templates]
          : templates.map((candidate) => (candidate.id === template.id ? template : candidate)),
      );
    },
    removeTemplate: (templateId) => {
      const templates = get().templates;
      const index = templates.findIndex((candidate) => candidate.id === templateId);
      const template = templates[index];
      if (!template) return null;
      if (!commit(templates.filter((candidate) => candidate.id !== templateId))) return null;
      return { template, index };
    },
    restoreTemplate: (template, index) => {
      const templates = [...get().templates];
      templates.splice(Math.min(index, templates.length), 0, template);
      return commit(templates);
    },
    markTemplateUsed: (templateId, usedAt) => {
      commit(
        get().templates.map((candidate) =>
          candidate.id === templateId ? { ...candidate, lastUsedAt: usedAt } : candidate,
        ),
      );
    },
  };
});

export function sortPromptTemplatesByRecentUse(
  templates: ReadonlyArray<PromptTemplate>,
): PromptTemplate[] {
  return templates.toSorted((left, right) =>
    (right.lastUsedAt ?? right.createdAt).localeCompare(left.lastUsedAt ?? left.createdAt),
  );
}

export function promptTemplateTitle(template: PromptTemplate): string {
  const firstLine = template.prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length > 0) return firstLine;
  const count = template.attachments.length;
  return `${count} image${count === 1 ? "" : "s"}`;
}

export type PromptTemplateAction = "insert" | "send";
type PromptTemplateActionHandler = (
  template: PromptTemplate,
  action: PromptTemplateAction,
) => boolean;

/** Inserting needs the mounted composer's cursor and draft, so the Prompts surface hands templates to it here. */
const actionHandlers = new Map<string, PromptTemplateActionHandler>();

export function setPromptTemplateActionHandler(
  target: ComposerThreadTarget,
  handler: PromptTemplateActionHandler,
): () => void {
  const key = composerTargetKey(target);
  actionHandlers.set(key, handler);
  return () => {
    if (actionHandlers.get(key) === handler) actionHandlers.delete(key);
  };
}

/** False when no composer is mounted for the target or it could not take the template. */
export function runPromptTemplateAction(
  target: ComposerThreadTarget,
  template: PromptTemplate,
  action: PromptTemplateAction,
): boolean {
  const handler = actionHandlers.get(composerTargetKey(target));
  return handler ? handler(template, action) : false;
}

export function readPersistedPromptTemplatesForTest(): ReadonlyArray<PromptTemplate> {
  return readPersistedTemplates();
}
