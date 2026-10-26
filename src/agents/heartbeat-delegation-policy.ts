/** A heartbeat's outcome consumer belongs to its original monitoring turn. */
export const HEARTBEAT_INLINE_ONLY_MESSAGE =
  "Background delegation and yielding are unavailable during a heartbeat. Finish this check inline and record its outcome with heartbeat_respond. Run work that needs delegation as an ordinary task.";
