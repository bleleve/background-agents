/**
 * Warm a sandbox once a prompt shows real intent — strictly more than this many
 * non-whitespace characters — so it's ready by submit, without spinning one up
 * for a stray space or a couple of keystrokes.
 *
 * Shared by the new-session prompt (warms by creating a session) and the
 * in-session composer (warms by relaunching a stopped sandbox) so both inputs
 * use the same gate.
 */
export const WARMUP_MIN_TRIMMED_CHARS = 5;

/**
 * Whether a prompt's trimmed length clears the warm-on-type gate.
 */
export function shouldWarmForPrompt(value: string): boolean {
  return value.trim().length > WARMUP_MIN_TRIMMED_CHARS;
}
