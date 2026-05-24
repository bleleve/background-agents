/**
 * Conditional preamble rules — barrel exports.
 */

export type {
  PreambleSource,
  PreambleMatcher,
  PreambleRule,
  ResolveContext,
  ResolveResult,
  SuggestedSessionType,
} from "./types";

export { matchesRule, resolvePreambles } from "./resolver";
