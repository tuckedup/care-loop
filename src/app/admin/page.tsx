import Link from "next/link";
import { requirePageRole } from "@/infra/auth/guard";
import {
  ArrowRightIcon,
  ChartIcon,
  ClipboardIcon,
  ListIcon,
  PageHeader,
  PageShell,
  ShieldIcon,
} from "../_components/ui";

const SECTIONS = [
  {
    href: "/admin/dashboard",
    title: "Dashboard",
    body: "Concurrence (target, not a result), escalation mix, time to decision.",
    icon: <ChartIcon className="h-6 w-6" />,
  },
  {
    href: "/admin/autonomy",
    title: "Autonomy mode",
    body: "SHADOW, RETRO or SAMPLED. Production builds are locked to SHADOW.",
    icon: <ShieldIcon className="h-6 w-6" />,
  },
  {
    href: "/admin/evals",
    title: "Eval results",
    body: "Fixture-based safety evals with their limits stated.",
    icon: <ClipboardIcon className="h-6 w-6" />,
  },
  {
    href: "/admin/audit",
    title: "Audit log",
    body: "Hash-chained audit entries as FHIR AuditEvent-shaped JSON.",
    icon: <ListIcon className="h-6 w-6" />,
  },
];

export default async function Page() {
  await requirePageRole("admin");
  return (
    <PageShell width="max-w-5xl">
      <PageHeader
        title="Admin"
        lead="Oversight for the synthetic renewal loop: how autonomous it is, how it is performing on its test set, and what exactly happened."
      />
      <ul aria-label="Admin sections" className="mt-8 grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <Link
              href={s.href}
              className="group flex h-full flex-col gap-3 rounded-card border border-line bg-surface p-5 shadow-card transition-colors hover:border-brand-600"
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-800 dark:bg-sunken dark:text-brand-300">
                {s.icon}
              </span>
              <span className="text-lg font-semibold">{s.title}</span>
              <span className="text-sm text-muted">{s.body}</span>
              <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-semibold text-brand-800 dark:text-brand-300">
                Open{" "}
                <ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
