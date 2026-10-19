import { useAtomValue } from "@effect/atom-react";
import {
  fileAttachmentTooLargeMessage,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";
import {
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import * as Schema from "effect/Schema";
import {
  BookmarkIcon,
  CornerDownLeftIcon,
  PaperclipIcon,
  PencilIcon,
  PinIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type Ref,
} from "react";

import {
  hydrateImagesFromPersisted,
  type ComposerFileAttachment,
  type DraftId,
  type PersistedComposerFileAttachment,
  type PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useTheme } from "../../hooks/useTheme";
import {
  readAttachmentUpload,
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "../../lib/attachmentUploadState";
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
import {
  runPromptTemplateAction,
  sortPromptTemplatesByRecentUse,
  usePromptTemplateStore,
  type PromptTemplate,
  type PromptTemplateAction,
} from "../../promptTemplateStore";
import { environmentServerConfigsAtom } from "../../state/server";
import { videoMimeType } from "../../types";
import {
  classifyComposerAttachmentFile,
  fileAttachmentStagingLimit,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";
import { ComposerSurface } from "../chat/ComposerSurface";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface DraftImage {
  id: string;
  file: File;
  previewUrl: string;
  /** Set for images loaded from a template being edited, so saving does not re-encode them. */
  persisted?: PersistedComposerImageAttachment;
}

const PromptsSegment = Schema.Literals(["later", "templates"]);
type PromptsSegment = typeof PromptsSegment.Type;
const PROMPTS_SEGMENT_STORAGE_KEY = "t3code:prompts-panel-segment:v1";

interface PromptsComposerHandle {
  editTemplate: (template: PromptTemplate) => void;
  cancelEdit: () => void;
}

/**
 * Mirrors the composer's ⌘S stash: the entry is written first so a closed tab cannot lose the
 * text, then images are re-encoded to fit the localStorage budget the stash shares. Other files
 * are already on the server, so the entry keeps their upload references like a composer stash.
 */
async function stashFromPanel(
  prompt: string,
  images: ReadonlyArray<DraftImage>,
  files: ReadonlyArray<PersistedComposerFileAttachment>,
) {
  const store = usePromptStashStore.getState();
  const entryId = randomUUID();
  const { evicted, written } = store.stashEntry({
    id: entryId,
    createdAt: new Date().toISOString(),
    prompt,
    attachments: [],
    ...(files.length > 0 ? { files } : {}),
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

/** Images are encoded before the single write: unlike the stash, a template is not a quick capture. */
async function saveTemplateFromPanel(
  prompt: string,
  images: ReadonlyArray<DraftImage>,
  editing: PromptTemplate | null,
) {
  const candidates: PersistedComposerImageAttachment[] = [];
  const notSaved: string[] = [];
  for (const image of images) {
    if (image.persisted) {
      candidates.push(image.persisted);
      continue;
    }
    const result = await compressImageForStash(image.file);
    if (!result.ok) {
      notSaved.push(image.file.name);
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
  notSaved.push(...droppedNames);
  if (prompt.length === 0 && kept.length === 0) {
    toastManager.add({
      type: "error",
      title: "Could not save this template",
      description: `${notSaved.join(", ")} could not be saved, and the template has no text.`,
      data: { hideCopyButton: true },
    });
    return false;
  }
  const saved = usePromptTemplateStore.getState().saveTemplate({
    ...editing,
    id: editing?.id ?? randomUUID(),
    createdAt: editing?.createdAt ?? new Date().toISOString(),
    prompt,
    attachments: kept,
  });
  if (!saved) {
    toastManager.add({
      type: "error",
      title: "Could not save this template",
      description: "Browser storage rejected the write. Free up site data and try again.",
      data: { hideCopyButton: true },
    });
    return false;
  }
  if (notSaved.length > 0) {
    toastManager.add({
      type: "warning",
      title: "Some images were not saved",
      description: `${notSaved.join(", ")} could not be read or exceeded the size limit.`,
      data: { hideCopyButton: true },
    });
  }
  return true;
}

function PromptsComposer(props: {
  environmentId: EnvironmentId;
  segment: PromptsSegment;
  ref: Ref<PromptsComposerHandle>;
  onEditingChange: (templateId: string | null) => void;
}) {
  const { environmentId, segment, ref, onEditingChange } = props;
  const isTemplates = segment === "templates";
  const { resolvedTheme } = useTheme();
  const serverConfig = useAtomValue(environmentServerConfigsAtom).get(environmentId) ?? null;
  const uploadsById = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [files, setFiles] = useState<ComposerFileAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  const filesRef = useRef(files);
  useEffect(() => {
    imagesRef.current = images;
    filesRef.current = files;
  }, [images, files]);
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
      // Unsaved uploads belong to no draft or stash entry, so nothing else would release them.
      for (const file of filesRef.current) releaseAttachmentUpload(file.id);
    },
    [],
  );

  const fileLimit = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown: serverConfig !== null,
    supportsAttachmentUploads: serverConfig?.environment.capabilities.attachmentUploads === true,
    maxFileAttachmentBytes:
      serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  });

  // The same rules the composer applies, so anything saved here can be restored into it.
  const addAttachments = (picked: ReadonlyArray<File>) => {
    let slots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - images.length - files.length;
    const nextImages: DraftImage[] = [];
    const nextFiles: ComposerFileAttachment[] = [];
    let error: string | null = null;
    for (const file of picked) {
      if (slots <= 0) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
        break;
      }
      const kind = classifyComposerAttachmentFile(file);
      if (isTemplates && kind !== "image") {
        error = "Templates keep text and images only. Save prompts with files under Later.";
        continue;
      }
      if (kind === "unsupported-image") {
        error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
        continue;
      }
      if (kind === "image") {
        const image = normalizeComposerImageFileMimeType(file);
        nextImages.push({ id: randomUUID(), file: image, previewUrl: URL.createObjectURL(image) });
        slots -= 1;
        continue;
      }
      if (fileLimit === null) {
        error = "This server does not support file attachments.";
        continue;
      }
      if (file.size <= 0) {
        error = `'${file.name}' is empty or could not be read.`;
        continue;
      }
      if (file.size > fileLimit) {
        error = fileAttachmentTooLargeMessage(file.name, fileLimit);
        continue;
      }
      const mimeType =
        videoMimeType({ name: file.name, mimeType: file.type }) ??
        (file.type || "application/octet-stream");
      const attachmentFile =
        file.type === mimeType
          ? file
          : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
      const attachment: ComposerFileAttachment = {
        type: "file",
        id: randomUUID(),
        name: attachmentFile.name || "file",
        mimeType,
        sizeBytes: attachmentFile.size,
        file: attachmentFile,
      };
      startAttachmentUpload({ environmentId, image: attachment });
      nextFiles.push(attachment);
      slots -= 1;
    }
    if (error) toastManager.add({ type: "error", title: error });
    if (nextImages.length > 0) setImages((current) => [...current, ...nextImages]);
    if (nextFiles.length > 0) setFiles((current) => [...current, ...nextFiles]);
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  };

  const removeFile = (id: string) => {
    releaseAttachmentUpload(id);
    setFiles((current) => current.filter((file) => file.id !== id));
  };

  const canSave = !isSaving && (prompt.trim().length > 0 || images.length > 0 || files.length > 0);

  const clearTemplateEdit = () => {
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setPrompt("");
    setImages([]);
    setEditing(null);
    onEditingChange(null);
  };

  useImperativeHandle(ref, () => ({
    editTemplate: (template) => {
      if (editing === null && (prompt.trim().length > 0 || images.length > 0 || files.length > 0)) {
        toastManager.add({
          type: "info",
          title: "Save or clear the prompt box first",
          description: "Editing loads the template into the box, which already has a prompt.",
          data: { hideCopyButton: true },
        });
        return;
      }
      setEditing(template);
      onEditingChange(template.id);
      setPrompt(template.prompt);
      setImages(
        template.attachments.flatMap((attachment) =>
          hydrateImagesFromPersisted([attachment]).map((image) => ({
            id: image.id,
            file: image.file,
            previewUrl: image.previewUrl,
            persisted: attachment,
          })),
        ),
      );
      textareaRef.current?.focus();
    },
    cancelEdit: () => {
      if (editing) clearTemplateEdit();
    },
  }));

  const saveTemplate = async () => {
    if (files.length > 0) {
      toastManager.add({
        type: "error",
        title: "Templates keep text and images only",
        description: "Remove the files to save a template, or save this prompt under Later.",
      });
      return;
    }
    setIsSaving(true);
    const saved = await saveTemplateFromPanel(prompt.trim(), images, editing);
    setIsSaving(false);
    if (!saved) return;
    clearTemplateEdit();
    textareaRef.current?.focus();
  };

  const save = async () => {
    if (!canSave) return;
    if (isTemplates) {
      await saveTemplate();
      return;
    }
    // A stash entry points at the server's copy of each file, so it needs every upload done.
    const persistedFiles: PersistedComposerFileAttachment[] = [];
    for (const file of files) {
      const upload = readAttachmentUpload(file.id);
      if (upload?.status !== "ready" || upload.environmentId !== environmentId) {
        toastManager.add({
          type: upload?.status === "failed" ? "error" : "info",
          title:
            upload?.status === "failed"
              ? `'${file.name}' did not upload. Retry or remove it to save.`
              : "Wait for file uploads before saving this prompt",
        });
        return;
      }
      persistedFiles.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        attachmentId: upload.attachmentId,
        environmentId,
      });
    }
    setIsSaving(true);
    const saved = await stashFromPanel(prompt.trim(), images, persistedFiles);
    setIsSaving(false);
    if (!saved) return;
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setPrompt("");
    setImages([]);
    setFiles([]);
    textareaRef.current?.focus();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    if (pasted.length === 0) return;
    event.preventDefault();
    addAttachments(pasted);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setIsDragOver(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length === 0) return;
    event.preventDefault();
    addAttachments(dropped);
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
              {editing ? (
                <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
                  <PencilIcon className="size-3" aria-hidden="true" />
                  <span className="mr-auto">Editing template</span>
                  <Button variant="ghost" size="xs" onClick={clearTemplateEdit}>
                    Cancel
                  </Button>
                </div>
              ) : null}
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
              {files.length > 0 ? (
                <div className="mb-3 flex flex-col gap-1">
                  {files.map((file) => {
                    const upload = uploadsById[file.id];
                    return (
                      <div
                        key={file.id}
                        className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"
                      >
                        <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="shrink-0 text-xs text-secondary-label">
                          {upload?.status === "uploading"
                            ? formatAttachmentUploadProgress(upload.progress)
                            : formatAttachmentSize(file.sizeBytes)}
                        </span>
                        {upload?.status === "failed" ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() =>
                                    retryAttachmentUpload({ environmentId, image: file })
                                  }
                                  aria-label={`Retry upload for ${file.name}`}
                                />
                              }
                            >
                              <RefreshIcon />
                            </TooltipTrigger>
                            <TooltipPopup side="top">{upload.reason}</TooltipPopup>
                          </Tooltip>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeFile(file.id)}
                          aria-label={`Remove ${file.name}`}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                value={prompt}
                aria-label={isTemplates ? "Template" : "New prompt"}
                placeholder={
                  isTemplates
                    ? "Write a reusable prompt, paste or drop images"
                    : "Write a follow-up for later, paste or drop files"
                }
                className={cn(
                  "-m-1 block field-sizing-content max-h-52 min-h-19.5 w-[calc(100%+0.5rem)] resize-none overflow-y-auto bg-transparent p-1 whitespace-pre-wrap wrap-break-word text-foreground placeholder:text-placeholder/75 focus:outline-none",
                  // The composer's editor reads these appearance settings; matching them keeps both boxes the same size.
                  "font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
                  // After the size: class merging drops a line height that precedes a font size.
                  "leading-relaxed",
                )}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={onPaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void save();
                  }
                  if (event.key === "Escape" && editing) {
                    event.preventDefault();
                    clearTemplateEdit();
                  }
                }}
              />
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                {...(isTemplates ? { accept: "image/*" } : {})}
                onChange={(event) => {
                  addAttachments(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={isTemplates ? "Attach images" : "Attach files"}
                      onClick={() => fileInputRef.current?.click()}
                    />
                  }
                >
                  <PaperclipIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {isTemplates ? "Attach images" : "Attach files"}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={isTemplates ? "Save template" : "Save prompt"}
                      disabled={!canSave}
                      onClick={() => void save()}
                      className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 hover:scale-105 hover:bg-message-action-hover enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-control-highlight active:shadow-none active:inset-shadow-control-pressed disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:h-8 sm:w-8"
                    />
                  }
                >
                  {isTemplates ? (
                    <PinIcon className="size-4" aria-hidden="true" />
                  ) : (
                    <BookmarkIcon className="size-4" aria-hidden="true" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {isTemplates
                    ? `${editing ? "Update" : "Save"} template (${saveShortcut})`
                    : `Save for later (${saveShortcut})`}
                </TooltipPopup>
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
  theme: "light" | "dark";
  onAction: (entry: PromptStashEntry, action: PromptStashAction) => void;
}) {
  const { entry, theme, onAction } = props;
  const files = entry.files ?? [];
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
      {files.length > 0 ? (
        <div
          className={cn(
            "flex flex-col gap-1",
            (text.length > 0 || entry.attachments.length > 0) && "mt-2.5",
          )}
        >
          {files.map((file) => (
            <div key={file.id} className="flex min-w-0 items-center gap-2 text-sm text-foreground">
              <PierreEntryIcon pathValue={file.name} kind="file" theme={theme} />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="shrink-0 text-xs text-secondary-label">
                {formatAttachmentSize(file.sizeBytes)}
              </span>
            </div>
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

function TemplateCard(props: {
  template: PromptTemplate;
  isEditing: boolean;
  onEdit: (template: PromptTemplate) => void;
  onDelete: (template: PromptTemplate) => void;
  onAction: (template: PromptTemplate, action: PromptTemplateAction) => void;
}) {
  const { template, isEditing, onEdit, onDelete, onAction } = props;
  const text = template.prompt.trim();

  return (
    <li
      className={cn(
        "rounded-2xl border border-border/70 bg-card/60 p-3",
        isEditing && "border-primary/60",
      )}
    >
      {text.length > 0 ? (
        <p className="line-clamp-6 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground">
          {text}
        </p>
      ) : null}
      {template.attachments.length > 0 ? (
        <div className={cn("flex flex-wrap gap-2", text.length > 0 && "mt-2.5")}>
          {template.attachments.map((attachment) => (
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
        <span className="mr-auto text-muted-foreground text-xs tabular-nums">
          {isEditing ? (
            "Editing…"
          ) : template.lastUsedAt ? (
            <time dateTime={template.lastUsedAt}>
              Used <RelativeTime timestamp={template.lastUsedAt} />
            </time>
          ) : (
            <time dateTime={template.createdAt}>
              Saved <RelativeTime timestamp={template.createdAt} />
            </time>
          )}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Edit template"
          disabled={isEditing}
          onClick={() => onEdit(template)}
        >
          <PencilIcon />
        </Button>
        <Button
          variant="ghost-destructive"
          size="icon-xs"
          aria-label="Delete template"
          disabled={isEditing}
          onClick={() => onDelete(template)}
        >
          <Trash2Icon />
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onAction(template, "insert")}>
          <CornerDownLeftIcon />
          Insert
        </Button>
        <Button variant="secondary" size="xs" onClick={() => onAction(template, "send")}>
          Send
        </Button>
      </div>
    </li>
  );
}

function deleteTemplateWithUndo(template: PromptTemplate) {
  const removed = usePromptTemplateStore.getState().removeTemplate(template.id);
  if (!removed) {
    toastManager.add({
      type: "error",
      title: "Could not delete this template",
      description: "Browser storage rejected the change.",
      data: { hideCopyButton: true },
    });
    return;
  }
  const toastId = toastManager.add({
    type: "info",
    title: "Template deleted",
    actionProps: {
      children: "Undo",
      onClick: () => {
        toastManager.close(toastId);
        usePromptTemplateStore.getState().restoreTemplate(removed.template, removed.index);
      },
    },
    data: { hideCopyButton: true },
  });
}

/**
 * Follow-up prompts kept beside the thread. "Later" shares its entries with the composer's ⌘S
 * stash and uses each one up; "Templates" keeps prompts until they are deleted.
 */
export function PromptsPanel(props: {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
}) {
  const { composerDraftTarget, environmentId } = props;
  const { resolvedTheme } = useTheme();
  const entries = usePromptStashStore((state) => state.entries);
  const templates = usePromptTemplateStore((state) => state.templates);
  const [segment, setSegment] = useLocalStorage(
    PROMPTS_SEGMENT_STORAGE_KEY,
    "later",
    PromptsSegment,
  );
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const composerRef = useRef<PromptsComposerHandle>(null);

  const onAction = (entry: PromptStashEntry, action: PromptStashAction) => {
    void runPromptStashAction(composerDraftTarget, entry, action).then((handled) => {
      if (handled || action !== "delete") return;
      // Without a mounted composer there are no tracked uploads to release.
      usePromptStashStore.getState().takeEntry(entry.id);
    });
  };

  const onTemplateAction = (template: PromptTemplate, action: PromptTemplateAction) => {
    if (runPromptTemplateAction(composerDraftTarget, template, action)) return;
    toastManager.add({
      type: "error",
      title: "Could not add the template to the composer",
      description: "The composer is not accepting a prompt right now.",
      data: { hideCopyButton: true },
    });
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-3">
        <ToggleGroup
          aria-label="Prompt list"
          className="w-full *:flex-1"
          value={[segment]}
          onValueChange={(next) => {
            const value = next[0];
            if (value !== "later" && value !== "templates") return;
            composerRef.current?.cancelEdit();
            setSegment(value);
          }}
        >
          <Toggle value="later">Later{entries.length > 0 ? ` ${entries.length}` : ""}</Toggle>
          <Toggle value="templates">
            Templates{templates.length > 0 ? ` ${templates.length}` : ""}
          </Toggle>
        </ToggleGroup>
        <PromptsComposer
          ref={composerRef}
          environmentId={environmentId}
          segment={segment}
          onEditingChange={setEditingTemplateId}
        />
        {segment === "templates" ? (
          templates.length === 0 ? (
            <Empty size="compact">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PinIcon />
                </EmptyMedia>
                <EmptyTitle>No templates yet</EmptyTitle>
                <EmptyDescription>
                  Save prompts you send often. Type / in the composer to use them.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul role="list" aria-label="Templates" className="flex flex-col gap-2">
              {sortPromptTemplatesByRecentUse(templates).map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  isEditing={template.id === editingTemplateId}
                  onEdit={(target) => composerRef.current?.editTemplate(target)}
                  onDelete={deleteTemplateWithUndo}
                  onAction={onTemplateAction}
                />
              ))}
            </ul>
          )
        ) : entries.length === 0 ? (
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
              <PromptCard key={entry.id} entry={entry} theme={resolvedTheme} onAction={onAction} />
            ))}
          </ul>
        )}
      </div>
    </ScrollArea>
  );
}
