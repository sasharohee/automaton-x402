"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { fmtDateTime, fmtDay, fmtNum, fmtTime } from "@/lib/format";

type Point = [number, number]; // [epoch ms, usdc]

const RANGES = [
  { key: "6h", label: "6 h", ms: 6 * 3600_000, step: 3600_000 },
  { key: "24h", label: "24 h", ms: 24 * 3600_000, step: 4 * 3600_000 },
  { key: "7d", label: "7 j", ms: 7 * 86400_000, step: 86400_000 },
] as const;

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 52 };
const GAP_MS = 30 * 60_000; // au-delà, on interrompt la courbe (pusher hors ligne)

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

export default function BalanceChart({ history, nowMs }: { history: Point[]; nowMs: number }) {
  const [rangeKey, setRangeKey] = useState<(typeof RANGES)[number]["key"]>("24h");
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[1];
  // Arrondi à la minute pour ne pas recalculer à chaque seconde.
  const end = Math.ceil(nowMs / 60_000) * 60_000;
  const start = end - range.ms;

  const points = useMemo(
    () => history.filter(([t]) => t >= start && t <= end).sort((a, b) => a[0] - b[0]),
    [history, start, end],
  );

  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  let yMin = Math.min(...points.map((p) => p[1]));
  let yMax = Math.max(...points.map((p) => p[1]));
  if (points.length === 0) {
    yMin = 0;
    yMax = 1;
  } else if (yMax - yMin < 0.02) {
    yMin -= 0.5;
    yMax += 0.5;
  } else {
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad;
    yMax += pad;
  }
  if (yMin < 0 && points.every((p) => p[1] >= 0)) yMin = 0;

  const x = (t: number) => PAD.left + ((t - start) / range.ms) * innerW;
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  let line = "";
  points.forEach(([t, v], i) => {
    const gap = i === 0 || t - points[i - 1][0] > GAP_MS;
    line += `${gap ? "M" : "L"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
  });

  const yTicks = niceTicks(yMin, yMax, 4);
  const xTicks: number[] = [];
  for (let t = Math.ceil(start / range.step) * range.step; t <= end; t += range.step) xTicks.push(t);
  const xLabel = (t: number) => (range.key === "7d" ? fmtDay(t) : fmtTime(t));
  const digits = yMax - yMin < 0.5 ? 3 : 2;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    if (points.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = start + ((e.clientX - rect.left - PAD.left) / innerW) * range.ms;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i][0] - t) < Math.abs(points[best][0] - t)) best = i;
    }
    setHover(best);
  }

  const hp = hover !== null ? points[hover] : undefined;
  const last = points[points.length - 1];

  return (
    <div>
      <div className="seg" role="group" aria-label="Période">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            className={r.key === rangeKey ? "active" : ""}
            onClick={() => {
              setRangeKey(r.key);
              setHover(null);
            }}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div ref={boxRef} className="chart-box">
        {points.length < 2 ? (
          <p className="muted chart-empty">Pas assez de points sur cette période.</p>
        ) : (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label="Solde USDC dans le temps"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {yTicks.map((v) => (
              <g key={`y${v}`}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="grid" />
                <text x={PAD.left - 6} y={y(v)} className="axis" textAnchor="end" dominantBaseline="middle">
                  {fmtNum(v, digits)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={`x${t}`} x={x(t)} y={HEIGHT - 8} className="axis" textAnchor="middle">
                {xLabel(t)}
              </text>
            ))}
            <path d={line} className="line" />
            {last && <circle cx={x(last[0])} cy={y(last[1])} r={3.5} className="dot" />}
            {hp && (
              <g>
                <line x1={x(hp[0])} x2={x(hp[0])} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="cursor" />
                <circle cx={x(hp[0])} cy={y(hp[1])} r={4} className="dot" />
              </g>
            )}
          </svg>
        )}
      </div>
      <p className="muted small chart-legend">
        {hp
          ? `${fmtDateTime(hp[0])} — ${fmtNum(hp[1], 2)} USDC`
          : last
            ? `Dernier point : ${fmtDateTime(last[0])} — ${fmtNum(last[1], 2)} USDC`
            : " "}
      </p>
    </div>
  );
}
