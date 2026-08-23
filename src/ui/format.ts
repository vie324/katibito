// 数値表示の整形。すべて等幅フォント(.num)で表示する前提(§11)。

import { FEATURE_META, type FeatureKey } from "../config/scoring";

export function formatFeature(key: FeatureKey, v: number | null): string {
  if (v === null) return "—";
  const meta = FEATURE_META[key];
  const value = meta.kind === "percent" ? v * 100 : v;
  return value.toFixed(meta.digits);
}

export function featureUnit(key: FeatureKey): string {
  const meta = FEATURE_META[key];
  return meta.kind === "percent" ? meta.unit || "%" : meta.unit;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatAxis(v: number | null): string {
  return v === null ? "—" : v.toFixed(1);
}
