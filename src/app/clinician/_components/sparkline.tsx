import { sparkGeometry } from "../_lib/view-model";

interface Props {
  id: string;
  label: string;
  max: number;
  /** Oldest first. */
  points: { date: string; value: number | null; flagged?: boolean }[];
}

/** Inline-SVG sparkline with a text alternative (title/desc + a plain-language sentence). */
export function Sparkline({ id, label, max, points }: Props) {
  const W = 160;
  const H = 40;
  const geo = sparkGeometry(
    points.map((p) => p.value),
    max,
    W,
    H,
  );
  const known = points.filter((p) => p.value !== null);
  const latest = known.at(-1);
  const prev = known.at(-2);
  const sentence =
    known.length === 0
      ? `${label}: no scores recorded.`
      : `${label}: ${known.length} check-in${known.length === 1 ? "" : "s"}, latest ${latest!.value} of ${max}${
          prev ? `, previous ${prev.value}` : ""
        }. Values oldest to newest: ${known.map((p) => p.value).join(", ")}.`;
  return (
    <figure data-testid={`sparkline-${id}`} className="flex flex-wrap items-center gap-3">
      <svg
        role="img"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="text-slate-700 dark:text-slate-300"
      >
        <title id={`${id}-title`}>{`${label} trend`}</title>
        <desc id={`${id}-desc`}>{sentence}</desc>
        <line x1="0" y1={H - 4} x2={W} y2={H - 4} stroke="currentColor" strokeOpacity="0.25" />
        {geo.points.length > 1 ? (
          <path d={geo.path} fill="none" stroke="currentColor" strokeWidth="2" />
        ) : null}
        {geo.points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3" fill="currentColor" />
        ))}
      </svg>
      <figcaption className="text-sm">
        <span className="font-medium">{label}</span>{" "}
        <span data-testid={`sparkline-${id}-latest`}>
          {latest ? `latest ${latest.value}/${max}` : "no data"}
        </span>
        {prev ? (
          <span className="text-slate-600 dark:text-slate-400"> (was {prev.value})</span>
        ) : null}
        <span className="sr-only"> {sentence}</span>
      </figcaption>
    </figure>
  );
}
