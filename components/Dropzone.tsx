"use client";

import { useRef, useState, type ReactNode, type ClipboardEvent } from "react";
import { cx } from "./ui";

const ACCEPT = ["image/png", "image/jpeg", "image/webp"];

export function pickImageFile(files: FileList | File[] | null | undefined): File | null {
  if (!files) return null;
  for (const f of Array.from(files)) if (ACCEPT.includes(f.type)) return f;
  return null;
}

export default function Dropzone({
  onFile,
  children,
  className,
  compact,
  pasteTarget,
}: {
  onFile: (file: File) => void;
  children: ReactNode;
  className?: string;
  compact?: boolean;
  /** Bila true, Ctrl+V saat elemen fokus akan menempelkan gambar ke dropzone ini. */
  pasteTarget?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!pasteTarget) return;
    const file = pickImageFile(Array.from(e.clipboardData.items).map((i) => i.getAsFile()).filter((f): f is File => !!f));
    if (file) {
      e.preventDefault();
      e.stopPropagation();
      onFile(file);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onPaste={handlePaste}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = pickImageFile(e.dataTransfer.files);
        if (f) onFile(f);
      }}
      className={cx(
        "group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed text-center transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent-500/60",
        compact ? "px-3 py-4" : "px-6 py-10",
        over ? "border-accent-500 bg-accent-500/10" : "border-zinc-700 bg-zinc-950/40 hover:border-zinc-500 hover:bg-zinc-900/60",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT.join(",")}
        className="hidden"
        onChange={(e) => {
          const f = pickImageFile(e.target.files);
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      {children}
    </div>
  );
}
