/** LTTB downsampling: select n points that best preserve visual shape */
export function lttb<T>(
  data: T[],
  n: number,
  getX: (d: T) => number,
  getY: (d: T) => number,
): T[] {
  if (data.length <= n) return data;
  const bucketSize = (data.length - 2) / (n - 2);
  const result: T[] = [data[0]];
  for (let i = 0; i < n - 2; i++) {
    const bStart = Math.floor(i * bucketSize) + 1;
    const bEnd = Math.floor((i + 1) * bucketSize) + 1;
    // average the next bucket [bEnd, nextEnd) for the triangle's far vertex
    const nextEnd = Math.min(
      Math.floor((i + 2) * bucketSize) + 1,
      data.length - 1,
    );
    let avgX = 0;
    let avgY = 0;
    for (let j = bEnd; j < nextEnd; j++) {
      avgX += getX(data[j]);
      avgY += getY(data[j]);
    }
    const cnt = nextEnd - bEnd || 1;
    avgX /= cnt;
    avgY /= cnt;
    const prev = result[result.length - 1];
    const px = getX(prev);
    const py = getY(prev);
    let maxArea = -1;
    let maxIdx = bStart;
    for (let j = bStart; j < bEnd; j++) {
      const area = Math.abs(
        (px - avgX) * (getY(data[j]) - py) - (px - getX(data[j])) * (avgY - py),
      );
      if (area > maxArea) {
        maxArea = area;
        maxIdx = j;
      }
    }
    result.push(data[maxIdx]);
  }
  result.push(data[data.length - 1]);
  return result;
}
