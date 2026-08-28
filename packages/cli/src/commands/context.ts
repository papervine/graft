/**
 * What a command may write to.
 *
 * Its own module rather than a member of whichever command happened to need it first. It lived in
 * `check.ts`, so every other command imported from `check` to name its own arguments — and the day
 * `check` needed something from `ir.ts`, which imported the type back, that became an import cycle
 * the boundary check rejected. A type shared by every command belongs to none of them.
 *
 * Injected rather than reaching for `process.stdout` directly, so a test can assert on exact output
 * instead of capturing a global.
 */
export interface CommandContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}
