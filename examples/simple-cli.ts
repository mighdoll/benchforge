import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

const sorting: BenchMatrix<number[]> = {
  name: "Array Sorting (1000 numbers)",
  caseData: {
    numbers: () => Array.from({ length: 1000 }, () => Math.random()),
  },
  variants: {
    quicksort: quickSort,
    "insertion sort": insertionSort,
    "native sort": nativeSort,
  },
  baselineVariant: "native sort",
};

const suite: MatrixSuite = {
  name: "Performance Tests",
  matrices: [sorting],
};

export default suite;

/** Immutable quicksort implementation */
function quickSort(arr: number[]): number[] {
  if (arr.length <= 1) return arr;
  const pivot = arr[Math.floor(arr.length / 2)];
  const left = arr.filter(x => x < pivot);
  const middle = arr.filter(x => x === pivot);
  const right = arr.filter(x => x > pivot);
  return [...quickSort(left), ...middle, ...quickSort(right)];
}

/** Immutable insertion sort implementation */
function insertionSort(arr: number[]): number[] {
  const result = [...arr];
  for (let i = 1; i < result.length; i++) {
    const key = result[i];
    let j = i - 1;
    while (j >= 0 && result[j] > key) {
      result[j + 1] = result[j];
      j--;
    }
    result[j + 1] = key;
  }
  return result;
}

/** Immutable native sort */
function nativeSort(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}
