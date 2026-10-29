export type Point = [number, number | null];
export type Series = { labels: Record<string, string>; points: Point[] };

export function currentValue(
  series: Series | undefined,
  end: number,
): number | null {
  const point = series?.points.at(-1);
  // Range queries omit absent series; a historical final point is not current.
  return point && point[0] >= end - 1 ? point[1] : null;
}
export function selectSeries(
  metrics: Record<string, Series[]>,
  name: string,
  version?: string,
  target?: string,
) {
  return (metrics[name] ?? []).filter(
    (s) =>
      (!version || s.labels.version === version) &&
      (!target || s.labels.target === target),
  );
}
export function filterSeries(series: Series[], query: string) {
  return series.filter((s) =>
    JSON.stringify(s.labels).toLowerCase().includes(query.toLowerCase()),
  );
}
export function linePath(
  points: Point[],
  step: number,
  x: (time: number) => number,
  y: (value: number) => number,
) {
  let previous: number | null = null;
  return points
    .map(([time, value]) => {
      if (value === null) {
        previous = null;
        return "";
      }
      const command =
        previous === null || time - previous > step * 1.5 ? "M" : "L";
      previous = time;
      return `${command}${x(time).toFixed(1)},${y(value).toFixed(1)}`;
    })
    .join(" ");
}
