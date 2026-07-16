/// <reference types="vitest" />
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Skip git worktrees (e.g. .claude/worktrees/*) so their stale test copies
    // aren't run alongside the real suite.
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/worktrees/**"],
  },
});
