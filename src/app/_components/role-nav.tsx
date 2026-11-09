"use client";
// One navigation bar for every role: same look, active-page indicator, and the demo role switch.
import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavLink = { href: string; label: string };

export function RoleNav({ label, links }: { label: string; links: readonly NavLink[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-5 py-2 sm:px-8">
        {links.map((l) => {
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <Link
              key={l.href}
              href={l.href}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800 dark:bg-sunken dark:text-brand-300"
                  : "rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-sunken hover:text-ink"
              }
            >
              {l.label}
            </Link>
          );
        })}
        <Link
          href="/login"
          prefetch={false}
          className="ml-auto rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-sunken hover:text-ink"
        >
          Switch role (demo auth)
        </Link>
      </div>
    </nav>
  );
}
