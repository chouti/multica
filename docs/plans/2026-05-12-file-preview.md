# File Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "eye" preview action to file attachments in the editor (and read-only view), opening an in-app preview modal that renders HTML / Markdown / PDF / images / video / audio / CSV / XLSX / DOCX without leaving the app.

**Architecture:** A new `packages/views/file-preview/` sub-module (NOT a separate workspace package) exports `<FilePreviewModal />` and a registry that maps file extension → renderer component. Heavy renderers (`xlsx-renderer`, `docx-renderer`) use `React.lazy` so they only load when needed. The existing `FileCard` Tiptap NodeView gains an Eye button next to the Download button that opens the modal. Image previews keep the existing lightbox.

**Tech Stack:**
- `xlsx` (SheetJS Community, MIT) → HTML table for `.xlsx` / `.xls`
- `papaparse` (MIT) → table for `.csv`
- `docx-preview` (Apache-2.0) → DOCX rendering
- Native `<iframe>` for PDF (Chromium has built-in PDF viewer in Electron and all modern browsers — no PDF.js bundle needed for MVP)
- Sandboxed `<iframe srcdoc>` for HTML
- Existing `<Markdown>` from `@multica/views/common/markdown` for `.md`/`.mdx`
- Existing shadcn `<Dialog>` from `@multica/ui` for the modal shell
- `.pptx`, legacy `.doc`/`.xls`/`.ppt` are intentionally **out of scope** — show "unsupported, please download" placeholder

---

## Task 0: Add new deps to pnpm catalog

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `packages/views/package.json`

**Step 1: Add catalog entries**

Append under existing groups in `pnpm-workspace.yaml` `catalog:`:

```yaml
  # File preview renderers
  xlsx: "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
  papaparse: "^5.4.1"
  "@types/papaparse": "^5.3.14"
  docx-preview: "^0.3.5"
```

> Note: SheetJS Community is published off-npm; the tarball URL above is the canonical source per their docs. If install fails, fall back to `"xlsx": "^0.18.5"` from npm (older but functional).

**Step 2: Reference catalog from `packages/views/package.json`**

Add to `dependencies`:

```json
"xlsx": "catalog:",
"papaparse": "catalog:",
"docx-preview": "catalog:"
```

Add to `devDependencies`:

```json
"@types/papaparse": "catalog:"
```

**Step 3: Install**

Run: `pnpm install`
Expected: lockfile updates, no errors.

**Step 4: Commit**

```bash
git add pnpm-workspace.yaml packages/views/package.json pnpm-lock.yaml
git commit -m "chore(deps): add xlsx, papaparse, docx-preview for file preview"
```

---

## Task 1: Add `./file-preview` package export

**Files:**
- Modify: `packages/views/package.json` (`exports` block)
- Create: `packages/views/file-preview/index.ts`

**Step 1: Add export entry**

In `packages/views/package.json`, add to `exports`:

```json
"./file-preview": "./file-preview/index.ts",
```

**Step 2: Create empty index**

```ts
// packages/views/file-preview/index.ts
export { FilePreviewModal } from "./file-preview-modal";
export { FilePreview } from "./file-preview";
export { getRendererKey, type RendererKey } from "./get-renderer";
```

(File contents will exist after later tasks; we add the index now to lock in the public surface.)

**Step 3: Commit**

```bash
git add packages/views/package.json packages/views/file-preview/index.ts
git commit -m "feat(views): scaffold file-preview module export"
```

---

## Task 2: Renderer routing logic + tests

**Files:**
- Create: `packages/views/file-preview/get-renderer.ts`
- Create: `packages/views/file-preview/get-renderer.test.ts`

**Step 1: Write failing test**

```ts
// packages/views/file-preview/get-renderer.test.ts
import { describe, it, expect } from "vitest";
import { getRendererKey } from "./get-renderer";

describe("getRendererKey", () => {
  it.each([
    ["foo.html", "html"],
    ["a/b/c.HTM", "html"],
    ["readme.md", "markdown"],
    ["readme.MDX", "markdown"],
    ["plan.txt", "text"],
    ["main.ts", "text"],
    ["file.pdf", "pdf"],
    ["pic.png", "image"],
    ["pic.JPG", "image"],
    ["movie.mp4", "video"],
    ["sound.mp3", "audio"],
    ["data.csv", "csv"],
    ["sheet.xlsx", "xlsx"],
    ["legacy.xls", "xlsx"],
    ["doc.docx", "docx"],
    ["weird.bin", "unsupported"],
    ["", "unsupported"],
  ])("maps %s → %s", (filename, expected) => {
    expect(getRendererKey(filename)).toBe(expected);
  });
});
```

Run: `pnpm --filter @multica/views exec vitest run file-preview/get-renderer.test.ts`
Expected: FAIL — module does not exist.

**Step 2: Implement**

```ts
// packages/views/file-preview/get-renderer.ts
export type RendererKey =
  | "html"
  | "markdown"
  | "text"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "csv"
  | "xlsx"
  | "docx"
  | "unsupported";

const EXT_MAP: Record<string, RendererKey> = {
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  txt: "text",
  log: "text",
  json: "text",
  yaml: "text",
  yml: "text",
  ts: "text",
  tsx: "text",
  js: "text",
  jsx: "text",
  py: "text",
  go: "text",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  csv: "csv",
  xlsx: "xlsx",
  xls: "xlsx",
  docx: "docx",
};

export function getRendererKey(filename: string): RendererKey {
  if (!filename) return "unsupported";
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "unsupported";
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_MAP[ext] ?? "unsupported";
}
```

**Step 3: Run tests**

Run: `pnpm --filter @multica/views exec vitest run file-preview/get-renderer.test.ts`
Expected: PASS (17 cases).

**Step 4: Commit**

```bash
git add packages/views/file-preview/get-renderer.ts packages/views/file-preview/get-renderer.test.ts
git commit -m "feat(file-preview): add extension → renderer routing"
```

---

## Task 3: Lightweight renderers (image, video, audio, text, pdf, html, markdown, unsupported)

**Files:**
- Create: `packages/views/file-preview/renderers/image-renderer.tsx`
- Create: `packages/views/file-preview/renderers/media-renderer.tsx`
- Create: `packages/views/file-preview/renderers/text-renderer.tsx`
- Create: `packages/views/file-preview/renderers/pdf-renderer.tsx`
- Create: `packages/views/file-preview/renderers/html-renderer.tsx`
- Create: `packages/views/file-preview/renderers/markdown-renderer.tsx`
- Create: `packages/views/file-preview/renderers/unsupported-renderer.tsx`

Each renderer accepts the same props:

```ts
interface RendererProps {
  url: string;       // signed download URL
  filename: string;
}
```

**Step 1: image-renderer.tsx**

```tsx
"use client";
import type { RendererProps } from "../types";

export function ImageRenderer({ url, filename }: RendererProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/20 p-4">
      <img
        src={url}
        alt={filename}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
```

**Step 2: media-renderer.tsx**

```tsx
"use client";
import { useMemo } from "react";
import type { RendererProps } from "../types";
import { getRendererKey } from "../get-renderer";

export function MediaRenderer({ url, filename }: RendererProps) {
  const kind = useMemo(() => getRendererKey(filename), [filename]);
  return (
    <div className="flex h-full w-full items-center justify-center bg-black p-4">
      {kind === "video" ? (
        <video src={url} controls className="max-h-full max-w-full" />
      ) : (
        <audio src={url} controls className="w-full max-w-md" />
      )}
    </div>
  );
}
```

**Step 3: text-renderer.tsx**

Fetches the file as text and shows it in a `<pre>`. Caps at 1 MB to avoid pasting a 50MB log into the DOM.

```tsx
"use client";
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import type { RendererProps } from "../types";

const MAX_BYTES = 1_000_000;

export function TextRenderer({ url }: RendererProps) {
  const { t } = useT("editor");
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; text: string; truncated: boolean }
    | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const truncated = blob.size > MAX_BYTES;
        const slice = truncated ? blob.slice(0, MAX_BYTES) : blob;
        return { text: await slice.text(), truncated };
      })
      .then((out) => { if (!cancelled) setState({ kind: "ready", ...out }); })
      .catch(() => { if (!cancelled) setState({ kind: "error" }); });
    return () => { cancelled = true; };
  }, [url]);

  if (state.kind === "loading") return <div className="p-4 text-sm text-muted-foreground">{t(($) => $.file_preview.loading)}</div>;
  if (state.kind === "error") return <div className="p-4 text-sm text-destructive">{t(($) => $.file_preview.load_failed)}</div>;
  return (
    <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
      {state.text}
      {state.truncated ? `\n\n--- ${t(($) => $.file_preview.truncated)} ---` : ""}
    </pre>
  );
}
```

**Step 4: pdf-renderer.tsx**

Browser-native PDF viewer (Chromium has it built in; Electron inherits it). No PDF.js bundle.

```tsx
"use client";
import type { RendererProps } from "../types";

export function PdfRenderer({ url, filename }: RendererProps) {
  return (
    <iframe
      src={url}
      title={filename}
      className="h-full w-full border-0"
    />
  );
}
```

**Step 5: html-renderer.tsx**

Sandbox iframe with `srcdoc`. Default sandbox = no scripts, no top navigation, no forms — safe for arbitrary HTML.

```tsx
"use client";
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import type { RendererProps } from "../types";

export function HtmlRenderer({ url }: RendererProps) {
  const { t } = useT("editor");
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; html: string }
    | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then((html) => { if (!cancelled) setState({ kind: "ready", html }); })
      .catch(() => { if (!cancelled) setState({ kind: "error" }); });
    return () => { cancelled = true; };
  }, [url]);

  if (state.kind === "loading") return <div className="p-4 text-sm text-muted-foreground">{t(($) => $.file_preview.loading)}</div>;
  if (state.kind === "error") return <div className="p-4 text-sm text-destructive">{t(($) => $.file_preview.load_failed)}</div>;

  return (
    <iframe
      sandbox=""
      srcDoc={state.html}
      className="h-full w-full border-0 bg-white"
    />
  );
}
```

**Step 6: markdown-renderer.tsx**

```tsx
"use client";
import { useEffect, useState } from "react";
import { Markdown } from "../../common/markdown";
import { useT } from "../../i18n";
import type { RendererProps } from "../types";

export function MarkdownRenderer({ url }: RendererProps) {
  const { t } = useT("editor");
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; text: string }
    | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => res.ok ? res.text() : Promise.reject(res.status))
      .then((text) => { if (!cancelled) setState({ kind: "ready", text }); })
      .catch(() => { if (!cancelled) setState({ kind: "error" }); });
    return () => { cancelled = true; };
  }, [url]);

  if (state.kind === "loading") return <div className="p-4 text-sm text-muted-foreground">{t(($) => $.file_preview.loading)}</div>;
  if (state.kind === "error") return <div className="p-4 text-sm text-destructive">{t(($) => $.file_preview.load_failed)}</div>;
  return (
    <div className="h-full w-full overflow-auto p-6">
      <Markdown mode="full">{state.text}</Markdown>
    </div>
  );
}
```

**Step 7: unsupported-renderer.tsx**

```tsx
"use client";
import { Download, FileQuestion } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { useAttachmentDownloadResolver } from "../../editor/attachment-download-context";
import type { RendererProps } from "../types";

export function UnsupportedRenderer({ url, filename }: RendererProps) {
  const { t } = useT("editor");
  const { openByUrl } = useAttachmentDownloadResolver();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <FileQuestion className="size-12 text-muted-foreground" />
      <div className="text-sm text-muted-foreground">
        {t(($) => $.file_preview.unsupported, { filename })}
      </div>
      <Button variant="outline" size="sm" onClick={() => openByUrl(url)}>
        <Download className="mr-1 size-4" />
        {t(($) => $.file_preview.download)}
      </Button>
    </div>
  );
}
```

**Step 8: Shared types file**

```ts
// packages/views/file-preview/types.ts
export interface RendererProps {
  url: string;
  filename: string;
}
```

**Step 9: Commit**

```bash
git add packages/views/file-preview/types.ts packages/views/file-preview/renderers
git commit -m "feat(file-preview): add lightweight renderers (image, media, text, pdf, html, markdown, unsupported)"
```

---

## Task 4: Heavy renderers (csv, xlsx, docx) — lazy loaded

**Files:**
- Create: `packages/views/file-preview/renderers/csv-renderer.tsx`
- Create: `packages/views/file-preview/renderers/xlsx-renderer.tsx`
- Create: `packages/views/file-preview/renderers/docx-renderer.tsx`

**Step 1: csv-renderer.tsx**

```tsx
"use client";
import { useEffect, useState } from "react";
import Papa from "papaparse";
import { useT } from "../../i18n";
import type { RendererProps } from "../types";

export function CsvRenderer({ url }: RendererProps) {
  const { t } = useT("editor");
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => res.ok ? res.text() : Promise.reject(res.status))
      .then((text) => Papa.parse<string[]>(text, { skipEmptyLines: true }))
      .then((result) => { if (!cancelled) setRows(result.data); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [url]);

  if (error) return <div className="p-4 text-sm text-destructive">{t(($) => $.file_preview.load_failed)}</div>;
  if (!rows) return <div className="p-4 text-sm text-muted-foreground">{t(($) => $.file_preview.loading)}</div>;

  return (
    <div className="h-full w-full overflow-auto">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i === 0 ? "bg-muted font-medium" : "hover:bg-muted/40"}>
              {row.map((cell, j) => (
                <td key={j} className="border border-border px-2 py-1">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**Step 2: xlsx-renderer.tsx**

```tsx
"use client";
import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { useT } from "../../i18n";
import type { RendererProps } from "../types";

interface Sheet { name: string; html: string }

export function XlsxRenderer({ url }: RendererProps) {
  const { t } = useT("editor");
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => res.ok ? res.arrayBuffer() : Promise.reject(res.status))
      .then((buf) => {
        const wb = XLSX.read(buf, { type: "array" });
        const out: Sheet[] = wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name]!, { editable: false }),
        }));
        if (!cancelled) setSheets(out);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [url]);

  if (error) return <div className="p-4 text-sm text-destructive">{t(($) => $.file_preview.load_failed)}</div>;
  if (!sheets) return <div className="p-4 text-sm text-muted-foreground">{t(($) => $.file_preview.loading)}</div>;

  return (
    <div className="flex h-full w-full flex-col">
      {sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1 text-xs">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActive(i)}
              className={i === active
                ? "rounded bg-primary px-2 py-1 text-primary-foreground"
                : "rounded px-2 py-1 hover:bg-muted"}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div
        className="xlsx-preview flex-1 overflow-auto p-2 text-sm [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1"
        // sheet_to_html output is library-controlled, no user JS injection;
        // sheet_to_html does NOT execute scripts (it strips them).
        dangerouslySetInnerHTML={{ __html: sheets[active]!.html }}
      />
    </div>
  );
}
```

**Step 3: docx-renderer.tsx**

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { useT } from "../../i18n";
import type { RendererProps } from "../types";

export function DocxRenderer({ url }: RendererProps) {
  const { t } = useT("editor");
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    fetch(url)
      .then((res) => res.ok ? res.blob() : Promise.reject(res.status))
      .then((blob) => renderAsync(blob, container, undefined, {
        className: "docx-preview",
        inWrapper: true,
      }))
      .then(() => { if (!cancelled) setState("ready"); })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [url]);

  return (
    <div className="h-full w-full overflow-auto bg-muted/20 p-4">
      {state === "loading" && <div className="text-sm text-muted-foreground">{t(($) => $.file_preview.loading)}</div>}
      {state === "error" && <div className="text-sm text-destructive">{t(($) => $.file_preview.load_failed)}</div>}
      <div ref={containerRef} />
    </div>
  );
}
```

**Step 4: Commit**

```bash
git add packages/views/file-preview/renderers
git commit -m "feat(file-preview): add csv, xlsx (SheetJS), docx (docx-preview) renderers"
```

---

## Task 5: Top-level `<FilePreview />` router with lazy loading

**Files:**
- Create: `packages/views/file-preview/file-preview.tsx`

**Step 1: Implement**

```tsx
"use client";
import { lazy, Suspense, useMemo } from "react";
import { useT } from "../i18n";
import { getRendererKey } from "./get-renderer";
import { ImageRenderer } from "./renderers/image-renderer";
import { MediaRenderer } from "./renderers/media-renderer";
import { TextRenderer } from "./renderers/text-renderer";
import { PdfRenderer } from "./renderers/pdf-renderer";
import { HtmlRenderer } from "./renderers/html-renderer";
import { MarkdownRenderer } from "./renderers/markdown-renderer";
import { UnsupportedRenderer } from "./renderers/unsupported-renderer";
import type { RendererProps } from "./types";

// Heavy renderers are split-loaded so a workspace that never previews an
// xlsx/docx never pays for SheetJS / docx-preview at boot.
const CsvRenderer = lazy(() => import("./renderers/csv-renderer").then((m) => ({ default: m.CsvRenderer })));
const XlsxRenderer = lazy(() => import("./renderers/xlsx-renderer").then((m) => ({ default: m.XlsxRenderer })));
const DocxRenderer = lazy(() => import("./renderers/docx-renderer").then((m) => ({ default: m.DocxRenderer })));

export function FilePreview({ url, filename }: RendererProps) {
  const { t } = useT("editor");
  const key = useMemo(() => getRendererKey(filename), [filename]);

  const fallback = <div className="p-4 text-sm text-muted-foreground">{t(($) => $.file_preview.loading)}</div>;

  switch (key) {
    case "image":      return <ImageRenderer url={url} filename={filename} />;
    case "video":
    case "audio":      return <MediaRenderer url={url} filename={filename} />;
    case "text":       return <TextRenderer url={url} filename={filename} />;
    case "pdf":        return <PdfRenderer url={url} filename={filename} />;
    case "html":       return <HtmlRenderer url={url} filename={filename} />;
    case "markdown":   return <MarkdownRenderer url={url} filename={filename} />;
    case "csv":        return <Suspense fallback={fallback}><CsvRenderer url={url} filename={filename} /></Suspense>;
    case "xlsx":       return <Suspense fallback={fallback}><XlsxRenderer url={url} filename={filename} /></Suspense>;
    case "docx":       return <Suspense fallback={fallback}><DocxRenderer url={url} filename={filename} /></Suspense>;
    default:           return <UnsupportedRenderer url={url} filename={filename} />;
  }
}
```

**Step 2: Commit**

```bash
git add packages/views/file-preview/file-preview.tsx
git commit -m "feat(file-preview): top-level router with lazy heavy renderers"
```

---

## Task 6: `<FilePreviewModal />` shell

**Files:**
- Create: `packages/views/file-preview/file-preview-modal.tsx`

**Step 1: Implement**

```tsx
"use client";
import { Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";
import { useAttachmentDownloadResolver } from "../editor/attachment-download-context";
import { FilePreview } from "./file-preview";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  filename: string;
}

export function FilePreviewModal({ open, onOpenChange, url, filename }: Props) {
  const { t } = useT("editor");
  const { openByUrl } = useAttachmentDownloadResolver();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[90vw] max-w-[1100px] flex-col gap-0 p-0">
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-2 border-b px-4 py-2">
          <DialogTitle className="truncate text-sm font-medium">{filename}</DialogTitle>
          <Button variant="ghost" size="sm" onClick={() => openByUrl(url)}>
            <Download className="mr-1 size-4" />
            {t(($) => $.file_preview.download)}
          </Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <FilePreview url={url} filename={filename} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add packages/views/file-preview/file-preview-modal.tsx
git commit -m "feat(file-preview): add modal shell with download action"
```

---

## Task 7: i18n strings

**Files:**
- Modify: `packages/views/locales/en/editor.json`
- Modify: `packages/views/locales/zh-Hans/editor.json`

**Step 1: Read existing structure**

Open `packages/views/locales/en/editor.json` and find the top-level keys (likely `image`, `attachment`, `file_card`). Add a new `file_preview` block:

```json
"file_preview": {
  "loading": "Loading preview…",
  "load_failed": "Failed to load file",
  "truncated": "file truncated for preview",
  "unsupported": "No preview available for {{filename}}",
  "download": "Download",
  "preview": "Preview"
}
```

Add to `file_card`:

```json
"preview": "Preview"
```

**Step 2: Mirror into zh-Hans**

```json
"file_preview": {
  "loading": "加载预览中…",
  "load_failed": "无法加载文件",
  "truncated": "文件过大，已截断预览",
  "unsupported": "{{filename}} 暂不支持预览",
  "download": "下载",
  "preview": "预览"
},
```

And in `file_card`: `"preview": "预览"`.

**Step 3: Verify**

Run: `pnpm --filter @multica/views typecheck`
Expected: PASS (i18n string keys reference the typed `useT` selector — typecheck enforces existence).

**Step 4: Commit**

```bash
git add packages/views/locales/en/editor.json packages/views/locales/zh-Hans/editor.json
git commit -m "feat(i18n): add file_preview strings (en + zh)"
```

---

## Task 8: Wire Eye button into `FileCard`

**Files:**
- Modify: `packages/views/editor/extensions/file-card.tsx`

**Step 1: Add Eye import + state**

In `FileCardView` (currently lines 33-75):

```tsx
import { FileText, Loader2, Download, Eye } from "lucide-react";
import { useState } from "react";
import { FilePreviewModal } from "../../file-preview/file-preview-modal";
import { getRendererKey } from "../../file-preview/get-renderer";
```

**Step 2: Add preview button**

Inside the `<div className="my-1 ...">` block, BEFORE the existing Download button, add:

```tsx
{!uploading && href && getRendererKey(filename) !== "unsupported" && (
  <button
    type="button"
    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    title={t(($) => $.file_card.preview)}
    onMouseDown={(e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreviewOpen(true);
    }}
  >
    <Eye className="size-3.5" />
  </button>
)}
```

**Step 3: Add modal render and state hook**

At the top of `FileCardView`:

```tsx
const [previewOpen, setPreviewOpen] = useState(false);
```

At the bottom of the returned JSX (after `</div>`, inside `<NodeViewWrapper>`):

```tsx
{previewOpen && (
  <FilePreviewModal
    open={previewOpen}
    onOpenChange={setPreviewOpen}
    url={href}
    filename={filename}
  />
)}
```

**Step 4: Typecheck**

Run: `pnpm --filter @multica/views typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/views/editor/extensions/file-card.tsx
git commit -m "feat(editor): add eye preview button on FileCard"
```

---

## Task 9: Integration test — eye button + modal mount

**Files:**
- Create: `packages/views/file-preview/file-preview.test.tsx`

**Step 1: Write test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FilePreview } from "./file-preview";

// jsdom doesn't implement fetch — stub with a static body that the
// renderer's useEffect will resolve.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("hello"))));
});
afterEach(() => vi.unstubAllGlobals());

describe("FilePreview routing", () => {
  it("renders unsupported placeholder for unknown extension", () => {
    render(<FilePreview url="http://x/y.bin" filename="y.bin" />);
    expect(screen.getByText(/no preview available/i)).toBeInTheDocument();
  });

  it("renders <img> for image files", () => {
    render(<FilePreview url="http://x/y.png" filename="y.png" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", "http://x/y.png");
  });

  it("renders <iframe> for pdf files", () => {
    const { container } = render(<FilePreview url="http://x/y.pdf" filename="y.pdf" />);
    expect(container.querySelector("iframe")).toHaveAttribute("src", "http://x/y.pdf");
  });
});
```

**Step 2: Run**

Run: `pnpm --filter @multica/views exec vitest run file-preview/file-preview.test.tsx`
Expected: 3 PASS.

**Step 3: Commit**

```bash
git add packages/views/file-preview/file-preview.test.tsx
git commit -m "test(file-preview): smoke tests for routing"
```

---

## Task 10: Full verification

**Step 1: Run typecheck across the workspace**

Run: `pnpm typecheck`
Expected: PASS.

**Step 2: Run unit tests**

Run: `pnpm test`
Expected: PASS (existing tests + 4 new tests in file-preview).

**Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS.

**Step 4: If anything fails, fix and re-run. No commit until green.**

---

## Task 11: Open PR

**Step 1: Push branch**

```bash
git push -u origin agent/n-y/<branch-suffix>
```

**Step 2: Create PR**

```bash
gh pr create --title "feat: in-app file preview (HTML, PDF, Office, Markdown)" --body "$(cat <<'EOF'
## Summary
- Add `<FilePreviewModal />` opened by an Eye icon on FileCard attachments
- Renderers: image, video, audio, text, PDF (native iframe), HTML (sandbox iframe), Markdown, CSV (papaparse), XLSX (SheetJS), DOCX (docx-preview)
- `.pptx`, legacy `.doc/.xls/.ppt` and unknown extensions show an "unsupported, please download" placeholder
- Heavy renderers (CSV/XLSX/DOCX) are `React.lazy`-loaded — no boot-time cost for users who never preview them

Closes MUL-2060.

## Test plan
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (4 new tests in `packages/views/file-preview/`)
- [ ] In dev, attach a `.png`, `.pdf`, `.html`, `.md`, `.csv`, `.xlsx`, `.docx`, and `.pptx` file to an issue/comment; verify Eye icon appears on supported types and modal renders correctly
- [ ] Verify `.pptx` shows the unsupported placeholder with a working Download button
EOF
)"
```

**Step 3: Comment the PR URL back on MUL-2060.**

---

## Out of Scope (deliberately)

- **PPTX rendering** — `pptx-preview` quality is unreliable; defer until a user actually requests
- **Server-side conversion (Gotenberg / LibreOffice)** — adds infra; defer until legacy `.doc/.xls/.ppt` shows up in real usage
- **In-editor split-pane preview** — for now, preview is a modal only; if HTML/Markdown editor wants split mode, that's a follow-up
- **Univer-based rich Excel editing** — too heavy (multi-MB) for a read-only preview
