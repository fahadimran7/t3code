import type { ScopedThreadRef } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { BookmarkIcon, CornerDownLeftIcon, ImagePlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import type { DraftId, PersistedComposerImageAttachment } from "../../composerDraftStore";
import { compressImageForStash } from "../../lib/imageCompression";
import { cn, isMacPlatform, randomUUID } from "../../lib/utils";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  runPromptStashAction,
  usePromptStashStore,
  type PromptStashAction,
  type PromptStashEntry,
} from "../../promptStashStore";
import { ComposerSurface } from "../chat/ComposerSurface";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface DraftImage {
  id: string;
  file: File;
  previewUrl: string;
}

const imageFilesOf = (files: Iterable<File>) =>
  Array.from(files).filter((file) => file.type.startsWith("image/"));

/**
 * Mirrors the composer's ⌘S stash: the entry is written first so a closed tab cannot lose the
 * text, then images are re-encoded to fit the localStorage budget the stash shares.
 */
async function stashFromPanel(prompt: string, images: ReadonlyArray<DraftImage>) {
  const store = usePromptStashStore.getState();
  const entryId = randomUUID();
  const { evicted, written } = store.stashEntry({
    id: entryId,
    createdAt: new Date().toISOString(),
    prompt,
    attachments: [],
    droppedImageNames: [],
    unreadableImageNames: [],
    pendingImageCount: images.length,
  });
  if (!written) {
    toastManager.add({
      type: "error",
      title: "Could not save this prompt",
      description: "Browser storage rejected the write. Free up site data and try again.",
      data: { hideCopyButton: true },
    });
    return false;
  }
  if (evicted) {
    toastManager.add({
      type: "warning",
      title: "Oldest saved prompt discarded",
      description: `Prompts holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
      data: { hideCopyButton: true },
    });
  }
  const candidates: PersistedComposerImageAttachment[] = [];
  const oversized: string[] = [];
  const unreadable: string[] = [];
  for (const image of images) {
    const result = await compressImageForStash(image.file);
    if (!result.ok) {
      (result.reason === "too-large" ? oversized : unreadable).push(image.file.name);
      continue;
    }
    candidates.push({
      id: image.id,
      name: image.file.name,
      mimeType: result.image.mimeType,
      sizeBytes: result.image.sizeBytes,
      dataUrl: result.image.dataUrl,
    });
  }
  const { kept, droppedNames } = partitionStashAttachments(candidates);
  store.finalizeEntryImages(entryId, {
    attachments: kept,
    droppedImageNames: [...oversized, ...droppedNames],
    unreadableImageNames: unreadable,
  });
  return true;
}

function PromptsComposer() {
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );

  const addImages = (files: ReadonlyArray<File>) => {
    if (files.length === 0) return;
    setImages((current) => [
      ...current,
      ...files.map((file) => ({ id: randomUUID(), file, previewUrl: URL.createObjectURL(file) })),
    ]);
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  };

  const canSave = !isSaving && (prompt.trim().length > 0 || images.length > 0);

  const save = async () => {
    if (!canSave) return;
    setIsSaving(true);
    const saved = await stashFromPanel(prompt.trim(), images);
    setIsSaving(false);
    if (!saved) return;
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setPrompt("");
    setImages([]);
    textareaRef.current?.focus();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = imageFilesOf(event.clipboardData.files);
    if (pasted.length === 0) return;
    event.preventDefault();
    addImages(pasted);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setIsDragOver(false);
    const dropped = imageFilesOf(event.dataTransfer.files);
    if (dropped.length === 0) return;
    event.preventDefault();
    addImages(dropped);
  };

  const saveShortcut = isMacPlatform(navigator.platform) ? "⌘↵" : "Ctrl+↵";

  return (
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <ComposerSurface.Main>
          <div
            className={cn(
              "rounded-3xl transition-[background-color] duration-200",
              isDragOver && "bg-accent/45 ring-1 ring-inset ring-primary/70",
            )}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={onDrop}
          >
            <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
              {images.length > 0 ? (
                <div className="mb-3 flex max-w-full flex-wrap gap-2">
                  {images.map((image) => (
                    <div
                      key={image.id}
                      className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background"
                    >
                      <img
                        src={image.previewUrl}
                        alt={image.file.name}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute top-1 right-1 flex">
                        <Button
                          variant="media-close"
                          size="icon-xs"
                          onClick={() => removeImage(image.id)}
                          aria-label={`Remove ${image.file.name}`}
                        >
                          <XIcon />
                        </Button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                value={prompt}
                aria-label="New prompt"
                placeholder="Write a follow-up for later, paste or drop images"
                className="-m-1 block field-sizing-content max-h-52 min-h-19.5 w-[calc(100%+0.5rem)] resize-none overflow-y-auto bg-transparent p-1 leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground placeholder:text-placeholder focus:outline-none"
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={onPaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void save();
                  }
                }}
              />
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  addImages(imageFilesOf(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost-muted"
                      size="icon-sm"
                      aria-label="Attach images"
                      onClick={() => fileInputRef.current?.click()}
                    />
                  }
                >
                  <ImagePlusIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Attach images</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Save prompt"
                      disabled={!canSave}
                      onClick={() => void save()}
                      className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 hover:scale-105 hover:bg-message-action-hover enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-control-highlight active:shadow-none active:inset-shadow-control-pressed disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:h-8 sm:w-8"
                    />
                  }
                >
                  <BookmarkIcon className="size-4" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup side="top">Save for later ({saveShortcut})</TooltipPopup>
              </Tooltip>
            </div>
          </div>
        </ComposerSurface.Main>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}

function PromptCard(props: {
  entry: PromptStashEntry;
  onAction: (entry: PromptStashEntry, action: PromptStashAction) => void;
}) {
  const { entry, onAction } = props;
  const text = assistantCitationsToPlainText(entry.prompt).trim();
  const isSaving = (entry.pendingImageCount ?? 0) > 0;
  const missingImages = entry.droppedImageNames.length + (entry.unreadableImageNames?.length ?? 0);

  return (
    <li className="group/prompt rounded-2xl border border-border/70 bg-card/60 p-3">
      {text.length > 0 ? (
        <p className="line-clamp-6 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground">
          {text}
        </p>
      ) : null}
      {entry.attachments.length > 0 ? (
        <div className={cn("flex flex-wrap gap-2", text.length > 0 && "mt-2.5")}>
          {entry.attachments.map((attachment) => (
            <img
              key={attachment.id}
              src={attachment.dataUrl}
              alt={attachment.name}
              className="h-12 w-12 rounded-lg border border-border/80 bg-background object-cover"
            />
          ))}
        </div>
      ) : null}
      <div className="mt-2.5 flex items-center gap-1">
        <time
          dateTime={entry.createdAt}
          className="mr-auto text-muted-foreground text-xs tabular-nums"
        >
          {isSaving ? (
            "Saving images…"
          ) : missingImages > 0 ? (
            <span className="text-warning-foreground">
              {missingImages} image{missingImages === 1 ? "" : "s"} not saved
            </span>
          ) : (
            <RelativeTime timestamp={entry.createdAt} />
          )}
        </time>
        <Button
          variant="ghost-destructive"
          size="icon-xs"
          aria-label="Delete prompt"
          onClick={() => onAction(entry, "delete")}
        >
          <Trash2Icon />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={isSaving}
          onClick={() => onAction(entry, "restore")}
        >
          <CornerDownLeftIcon />
          Composer
        </Button>
        <Button
          variant="secondary"
          size="xs"
          disabled={isSaving}
          onClick={() => onAction(entry, "send")}
        >
          Send
        </Button>
      </div>
    </li>
  );
}

/** Follow-up prompts kept beside the thread; shares its entries with the composer's ⌘S stash. */
export function PromptsPanel(props: { composerDraftTarget: ScopedThreadRef | DraftId }) {
  const { composerDraftTarget } = props;
  const entries = usePromptStashStore((state) => state.entries);

  const onAction = (entry: PromptStashEntry, action: PromptStashAction) => {
    void runPromptStashAction(composerDraftTarget, entry, action).then((handled) => {
      if (handled || action !== "delete") return;
      // Without a mounted composer there are no tracked uploads to release.
      usePromptStashStore.getState().takeEntry(entry.id);
    });
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-3">
        <PromptsComposer />
        {entries.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookmarkIcon />
              </EmptyMedia>
              <EmptyTitle>No saved prompts</EmptyTitle>
              <EmptyDescription>
                Write follow-ups here while the agent works, then send them when it is ready.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul role="list" aria-label="Saved prompts" className="flex flex-col gap-2">
            {entries.map((entry) => (
              <PromptCard key={entry.id} entry={entry} onAction={onAction} />
            ))}
          </ul>
        )}
      </div>
    </ScrollArea>
  );
}
