"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Section({
  step,
  title,
  subtitle,
  children,
  disabled,
  aside,
}: {
  step: number;
  title: string;
  subtitle?: string;
  children: ReactNode;
  disabled?: boolean;
  aside?: ReactNode;
}) {
  return (
    <section
      className={cx(
        "rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5 transition-opacity",
        disabled && "pointer-events-none opacity-40",
      )}
      aria-disabled={disabled}
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-500/15 text-xs font-semibold text-accent-400 ring-1 ring-accent-500/30">
            {step}
          </span>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-100">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{subtitle}</p>}
          </div>
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-zinc-400">{label}</span>
        <span className="tabular-nums text-zinc-300">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        className="w-full cursor-pointer"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-xs font-medium text-zinc-200">{label}</span>
        {description && <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-500">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          checked ? "bg-accent-500" : "bg-zinc-700",
        )}
      >
        <span
          className={cx(
            "inline-block size-4 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4.5" : "translate-x-0.5",
          )}
        />
      </button>
    </label>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex w-full rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "flex-1 rounded-md font-medium transition-colors",
            size === "sm" ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
            value === o.value ? "bg-zinc-800 text-zinc-50 shadow-sm" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" &&
          "bg-accent-500 px-4 py-2.5 text-zinc-950 shadow-lg shadow-accent-500/20 hover:bg-accent-400 active:scale-[0.99]",
        variant === "secondary" && "border border-zinc-700 bg-zinc-800/70 px-3.5 py-2 text-zinc-100 hover:bg-zinc-700/70",
        variant === "ghost" && "px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("size-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Menampilkan HTMLCanvasElement offscreen ke canvas yang terlihat. */
export function CanvasView({ canvas, className, label }: { canvas: HTMLCanvasElement | null; className?: string; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !canvas) return;
    el.width = canvas.width;
    el.height = canvas.height;
    el.getContext("2d")?.drawImage(canvas, 0, 0);
  }, [canvas]);
  if (!canvas) return null;
  return <canvas ref={ref} aria-label={label} role="img" className={cx("block h-auto w-full", className)} />;
}

export function Alert({ tone = "error", title, children }: { tone?: "error" | "warning" | "info"; title: string; children?: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded-xl border px-3.5 py-3 text-xs leading-relaxed",
        tone === "error" && "border-red-500/30 bg-red-500/10 text-red-200",
        tone === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-100",
        tone === "info" && "border-sky-500/30 bg-sky-500/10 text-sky-100",
      )}
    >
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 opacity-90">{children}</div>}
    </div>
  );
}
