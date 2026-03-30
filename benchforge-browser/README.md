# benchforge-browser

Browser benchmarking CLI with Playwright included.

This is a thin wrapper around [benchforge](https://www.npmjs.com/package/benchforge) that bundles Playwright as a direct dependency, so you don't need to install it separately.

## Install

```bash
npm install benchforge-browser
```

## Usage

```bash
benchforge-browser <url> [options]
```

The URL is a positional argument (no `--url` flag needed):

```bash
benchforge-browser http://localhost:5173
benchforge-browser http://localhost:5173 --alloc --gc-stats
benchforge-browser file://$(pwd)/bench.html --duration 3
```

All shared benchforge options (`--duration`, `--iterations`, `--alloc`, `--gc-stats`, `--view`, etc.) are supported. See [benchforge browser docs](https://github.com/mighdoll/benchforge/blob/main/README-browser.md) for bench function mode, lap mode, and full option reference.
