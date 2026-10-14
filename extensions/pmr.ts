// Session state: one object the whole extension reads and mutates.
// A leaf on purpose — gate, routing, panels and the event wiring all touch `state`, so keeping it
// here is what stops those files from importing each other in a cycle.

/** Reasoning depth a slot can be pinned to; the picker walks this list in order. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * What each routing slot cycles through, and where it starts. Two lists, not one, because the slots
 * have opposite jobs: a light chore must be able to drop to `off`, and a heavy review is pinned by
 * default at `high` and only ever goes deeper. A single list meant the light slot could be set to
 * `max` and the heavy slot to `off` by a stray press — and it was the only reason the screen needed
 * two separate thinking chords.
 */
export const LIGHT_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
export const HEAVY_THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Where each slot starts, and where a hand-written `routing.json` with no `*Thinking` key lands.
 *  One declaration: `routing.ts` reads it and the picker cycles from it. */
export const SLOT_DEFAULT_THINKING: Record<"light" | "heavy", ThinkingLevel> = { light: "low", heavy: "high" };

interface PendingModelRevert {
  model: any;
  thinking?: ThinkingLevel;
}

interface EyeState {
  enabled: boolean;
  reviewMode: boolean;
  modifiedFilesThisTurn: boolean;
  verifiedThisTurn: boolean;
  pendingRevert?: PendingModelRevert;
  stats: {
    destructiveBlocked: number;
    secretsBlocked: number;
    slopBlocked: number;
    verificationReminders: number;
    jevRequests: number;
    jevRoutingCalls: number;
    /** Calls that needed the fallback backend after the active one failed. */
    fallbacks: number;
    lightTurns: number;
    heavyTurns: number;
    reviewTurns: number;
  };
  pendingReview?: string;
}

export const state: EyeState = {
  enabled: true,
  reviewMode: false,
  modifiedFilesThisTurn: false,
  verifiedThisTurn: false,
  stats: {
    destructiveBlocked: 0,
    secretsBlocked: 0,
    slopBlocked: 0,
    verificationReminders: 0,
    jevRequests: 0,
    jevRoutingCalls: 0,
    fallbacks: 0,
    lightTurns: 0,
    heavyTurns: 0,
    reviewTurns: 0,
  },
};
