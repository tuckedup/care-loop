// Shared presentational primitives for CareLoop. Pure server-renderable components: no client state,
// no data access. Tones map to meaning (not decoration) and always pair colour with text/icon.
import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- icons (decorative: aria-hidden, sized by className) ---------- */

type IconProps = { className?: string };
const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

export function BrandMark({ className = "h-8 w-8" }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" className="fill-brand-700" />
      <path
        d="M9.5 16a6.5 6.5 0 0 1 11.1-4.6M22.5 16a6.5 6.5 0 0 1-11.1 4.6"
        fill="none"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="m19.2 8.4 1.7 3.2-3.5.6M12.8 23.6l-1.7-3.2 3.5-.6"
        fill="none"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="2" fill="white" />
    </svg>
  );
}
export const ShieldIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6l-7-3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </svg>
);
export const PillIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <g transform="rotate(-45 12 12)">
      <rect x="2.5" y="7.5" width="19" height="9" rx="4.5" />
      <path d="M12 7.5v9" />
    </g>
  </svg>
);
export const ClipboardIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="6" y="4" width="12" height="17" rx="2" />
    <path d="M9 4.5h6M9.5 10h5M9.5 14h5" />
  </svg>
);
export const StethoscopeIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M6 3v6a4 4 0 0 0 8 0V3M10 13v2.5a4.5 4.5 0 0 0 9 0V13" />
    <circle cx="19" cy="11" r="2" />
  </svg>
);
export const StoreIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 9.5 5.5 4h13L20 9.5M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5 12.5V20h14v-7.5M10 20v-4.5h4V20" />
  </svg>
);
export const LockIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </svg>
);
export const CheckIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
export const ClockIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);
export const AlertIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 4 3 19.5h18L12 4Z" />
    <path d="M12 10v4.5M12 17.2v.1" />
  </svg>
);
export const InfoIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8v.1" />
  </svg>
);
export const ArrowRightIcon = ({ className = "h-4 w-4" }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const ListIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.1M4.5 12h.1M4.5 18h.1" />
  </svg>
);
export const ChartIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);

/* ---------- buttons ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost";
const buttonBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-brand-700 text-white shadow-sm hover:bg-brand-800 active:bg-brand-900",
  secondary: "border border-line-strong bg-surface text-ink shadow-sm hover:bg-sunken",
  ghost: "text-brand-800 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-sunken",
};
export function buttonClass(variant: ButtonVariant = "primary", extra?: string): string {
  return cx(buttonBase, buttonVariants[variant], extra);
}

export function ButtonLink({
  href,
  variant = "primary",
  className,
  children,
  ...rest
}: { href: string; variant?: ButtonVariant } & Omit<ComponentPropsWithoutRef<"a">, "href">) {
  return (
    <Link href={href} className={buttonClass(variant, className)} {...rest}>
      {children}
    </Link>
  );
}

/* ---------- containers ---------- */

export function Card({
  children,
  className,
  as: Tag = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
} & Omit<ComponentPropsWithoutRef<"div">, "className" | "children">) {
  return (
    <Tag
      className={cx("rounded-card border border-line bg-surface p-5 shadow-card sm:p-6", className)}
      {...(rest as object)}
    >
      {children}
    </Tag>
  );
}

export function PageShell({
  children,
  width = "max-w-3xl",
}: {
  children: ReactNode;
  width?: "max-w-md" | "max-w-2xl" | "max-w-3xl" | "max-w-5xl" | "max-w-6xl";
}) {
  return <main className={cx("mx-auto w-full px-5 py-8 sm:px-8 sm:py-12", width)}>{children}</main>;
}

export function PageHeader({
  title,
  lead,
  eyebrow,
}: {
  title: string;
  lead?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="rise">
      {eyebrow ? (
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700 dark:text-brand-300">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        {title}
      </h1>
      {lead ? <p className="mt-3 max-w-2xl text-base leading-7 text-muted">{lead}</p> : null}
    </header>
  );
}

/* ---------- badges + notices ---------- */

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";
const badgeTones: Record<Tone, string> = {
  neutral: "bg-sunken text-muted border-line",
  brand:
    "bg-brand-50 text-brand-800 border-brand-200 dark:bg-sunken dark:text-brand-300 dark:border-line",
  success:
    "bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-900",
  warning:
    "bg-amber-50 text-amber-950 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900",
  danger:
    "bg-red-50 text-red-900 border-red-200 dark:bg-red-950 dark:text-red-100 dark:border-red-900",
  info: "bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-900",
};
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        badgeTones[tone],
      )}
    >
      {children}
    </span>
  );
}

const noticeTones: Record<Exclude<Tone, "neutral" | "brand">, { box: string; icon: ReactNode }> = {
  info: { box: badgeTones.info, icon: <InfoIcon /> },
  success: { box: badgeTones.success, icon: <CheckIcon /> },
  warning: { box: badgeTones.warning, icon: <AlertIcon /> },
  danger: { box: badgeTones.danger, icon: <AlertIcon /> },
};

/** Inline message. `alert` for errors that need immediate attention, `status` for polite updates. */
export function Notice({
  tone = "info",
  role,
  title,
  children,
  ...rest
}: {
  tone?: Exclude<Tone, "neutral" | "brand">;
  role?: "alert" | "status";
  title?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "role" | "title" | "children">) {
  const t = noticeTones[tone];
  return (
    <div
      role={role}
      className={cx("flex gap-3 rounded-xl border p-4 text-sm leading-6", t.box)}
      {...rest}
    >
      <span className="mt-0.5 shrink-0">{t.icon}</span>
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

/* ---------- renewal progress ---------- */

const FLOW_STEPS = ["Choose medication", "Verify identity", "Check-in", "Result"] as const;

/** Where the patient is in the renewal: 1-based index into FLOW_STEPS. */
export function FlowSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <nav aria-label="Renewal progress" className="mb-8">
      <ol className="grid grid-cols-4 gap-2" data-testid="flow-steps">
        {FLOW_STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < current;
          const active = n === current;
          return (
            <li key={label} aria-current={active ? "step" : undefined} className="min-w-0">
              <div
                className={cx(
                  "h-1.5 rounded-full",
                  done || active ? "bg-brand-700 dark:bg-brand-300" : "bg-line-strong",
                )}
              />
              <p
                className={cx(
                  "mt-2 flex items-center gap-1.5 text-xs leading-4 sm:text-sm",
                  active ? "font-semibold text-ink" : "text-muted",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                    done
                      ? "bg-brand-700 text-white"
                      : active
                        ? "border-2 border-brand-700 text-brand-800 dark:border-brand-300 dark:text-brand-300"
                        : "border border-line-strong text-muted",
                  )}
                >
                  {done ? <CheckIcon className="h-3 w-3" /> : n}
                </span>
                <span className="min-w-0 break-words">
                  {label}
                  <span className="sr-only">
                    {done ? " (completed)" : active ? " (current step)" : ""}
                  </span>
                </span>
              </p>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ---------- form fields ---------- */

export const inputClass =
  "block w-full min-h-11 rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-base text-ink shadow-sm placeholder:text-muted";

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint ? <p className="text-sm text-muted">{hint}</p> : null}
    </div>
  );
}
