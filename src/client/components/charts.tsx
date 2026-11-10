// Small hand-drawn SVG charts for Insights, styled by CSS classes (styles.css, "Insights")
// so they follow the theme. The same visual language as Ratio and Nitrogen: label-over-number
// tiles, pastel bars with an outline, the period still in progress dashed, slim share tracks.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from './ui';

/** The element's content width, kept up to date (charts draw at real size, never scaled). */
function useWidth(fallback = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e!.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** $1,234 → "$1.2k" for axes and bar labels; exact amounts live in tooltips. */
function compactMoney(cents: number): string {
  const d = cents / 100;
  const a = Math.abs(d);
  if (a >= 1_000_000) return `$${(d / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `$${(d / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
}

/** 4-5 round ticks from 0 to at least max (0, 1k, 2k ...), never odd steps like 2,103. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v < max + step; v += step) out.push(v);
  return out;
}

// ----------------------------------------------------------------------------------- tiles

export function Tile({
  label,
  value,
  sub,
  to,
  title,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  to?: string;
  title?: string;
}) {
  const body = (
    <>
      <span className="l">{label}</span>
      <span className="v">{value}</span>
      {sub ? <span className="d">{sub}</span> : null}
    </>
  );
  return to ? (
    <Link to={to} className="stat" title={title}>
      {body}
    </Link>
  ) : (
    <div className="stat" title={title}>
      {body}
    </div>
  );
}

// --------------------------------------------------------------------------- balance lines

export interface LinePoint {
  label: string;
  a: number;
  b: number;
  title: string;
}

/**
 * Two cumulative lines: `a` (claimable, accent) over `b` (reimbursed, green). The band between
 * them is what could be withdrawn at that point.
 */
export function BalanceLines({ data, ticks = 6 }: { data: LinePoint[]; ticks?: number }) {
  const [ref, W] = useWidth(700);
  const H = 220,
    pl = 46,
    pr = 10,
    pt = 12,
    pb = 24;
  const max = Math.max(1, ...data.map((d) => d.a), ...data.map((d) => d.b));
  const yt = niceTicks(max);
  const top = yt[yt.length - 1]!;
  const n = data.length;
  const x = (i: number) => pl + (n <= 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (n - 1));
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / top);
  const line = (k: 'a' | 'b') => data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d[k])}`).join('');
  const band =
    data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.a)}`).join('') +
    [...data]
      .reverse()
      .map((d, j) => `L${x(n - 1 - j)},${y(d.b)}`)
      .join('') +
    'Z';
  // No more labels than fit (about one per 72px), so phones don't get a pile-up.
  const every = Math.max(
    1,
    Math.ceil(n / Math.min(ticks, Math.max(2, Math.floor((W - pl - pr) / 72)))),
  );
  // Callers that label only some points (Januaries on a multi-year range) get exactly those.
  const sparse = data.some((d) => !d.label);
  const colW = n > 1 ? (W - pl - pr) / (n - 1) : W - pl - pr;
  return (
    <div ref={ref} className="chart-box">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img">
        {yt.map((v) => (
          <g key={v}>
            <line className="gl" x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} />
            <text x={pl - 8} y={y(v) + 4} textAnchor="end">
              {compactMoney(v)}
            </text>
          </g>
        ))}
        <path className="band" d={band} />
        <path className="ln ln-b" d={line('b')} />
        <path className="ln ln-a" d={line('a')} />
        {n > 0 && (
          <>
            <circle className="end end-a" cx={x(n - 1)} cy={y(data[n - 1]!.a)} r={3.5} />
            <circle className="end end-b" cx={x(n - 1)} cy={y(data[n - 1]!.b)} r={3.5} />
          </>
        )}
        {data.map((d, i) =>
          (sparse ? d.label : (n - 1 - i) % every === 0) ? (
            <text
              key={'x' + i}
              x={x(i)}
              y={H - 6}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            >
              {d.label}
            </text>
          ) : null,
        )}
        {data.map((d, i) => (
          <rect
            key={'h' + i}
            className="hit"
            x={x(i) - colW / 2}
            y={pt}
            width={colW}
            height={H - pt - pb}
          >
            <title>{d.title}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

// --------------------------------------------------------------------------- stacked columns

export interface StackCol {
  label: string;
  /** Bottom to top, in the order of `tones`. */
  values: number[];
  current?: boolean;
  title: string;
}

export function StackedColumns({
  data,
  tones,
  height = 190,
}: {
  data: StackCol[];
  tones: string[];
  height?: number;
}) {
  const [ref, W] = useWidth(700);
  const H = height,
    pl = 4,
    pt = 18,
    pb = 22;
  const total = (d: StackCol) => d.values.reduce((s, v) => s + v, 0);
  const max = Math.max(1, ...data.map(total));
  const bw = (W - pl * 2) / Math.max(1, data.length);
  const barW = Math.min(bw * 0.62, 44);
  const every = bw < 34 ? 2 : 1;
  return (
    <div ref={ref} className="chart-box">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img">
        <line className="ax" x1={pl} x2={W - pl} y1={H - pb} y2={H - pb} />
        {data.map((d, i) => {
          const x = pl + i * bw + (bw - barW) / 2;
          let yy = H - pb;
          const t = total(d);
          return (
            <g key={i} className={d.current ? 'current' : undefined}>
              <title>{d.title}</title>
              {d.values.map((v, j) => {
                if (v <= 0) return null;
                const h = Math.max(2, ((H - pb - pt) * v) / max);
                yy -= h;
                return (
                  <rect
                    key={j}
                    className={`bar tone-${tones[j]}`}
                    x={x}
                    y={yy}
                    width={barW}
                    height={h}
                  />
                );
              })}
              {/* Narrow bars (phones) skip the amount; it's in the tooltip. */}
              {t > 0 && bw >= 38 && (
                <text className="vl" x={x + barW / 2} y={yy - 5} textAnchor="middle">
                  {compactMoney(t)}
                </text>
              )}
              {/* Counted back from the newest, so the last label never crowds its neighbour. */}
              {(data.length - 1 - i) % every === 0 && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle">
                  {d.label}
                </text>
              )}
              {/* The whole column is the hover target, empty or not. */}
              <rect className="hit" x={pl + i * bw} y={pt} width={bw} height={H - pt - pb} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------------------- share bar

export interface Share {
  key: string;
  value: number;
  tone: string;
  title: string;
}

/** A total split into ordered parts: one row of rounded pills sized by share. */
export function ShareBar({ parts }: { parts: Share[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <div className="share empty-share" />;
  return (
    <div className="share">
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <span
            key={p.key}
            className={`tone-${p.tone}`}
            style={{ flexGrow: p.value / total }}
            title={p.title}
          />
        ))}
    </div>
  );
}

// ------------------------------------------------------------------------------ legend

export function Legend({ items }: { items: [tone: string, label: string][] }) {
  return (
    <div className="legend">
      {items.map(([tone, label]) => (
        <span key={tone}>
          <i className={`tone-${tone}`} />
          {label}
        </span>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------- ranked

export interface RankRow {
  key: string;
  label: ReactNode;
  value: number;
  vl: string;
  sub?: string;
  /** A CSS colour for the share track (a person's colour); default is the accent. */
  color?: string;
  to?: string;
}

/** Name and value, a muted sub-line, and a slim share track along the bottom. */
export function Rank({ rows, max }: { rows: RankRow[]; max: number }) {
  return (
    <div className="rank">
      {rows.map((r) => {
        const body = (
          <>
            <span className="rk-top">
              <span className="rk-l">{r.label}</span>
              <span className="rk-v">{r.vl}</span>
            </span>
            {r.sub ? <span className="rk-s">{r.sub}</span> : null}
            <span className="bar">
              <i
                style={{
                  width: `${max ? Math.min(100, (r.value / max) * 100) : 0}%`,
                  background: r.color,
                }}
              />
            </span>
          </>
        );
        return r.to ? (
          <Link key={r.key} to={r.to} className={cx('rk', 'rk-link')}>
            {body}
          </Link>
        ) : (
          <div key={r.key} className="rk">
            {body}
          </div>
        );
      })}
    </div>
  );
}
