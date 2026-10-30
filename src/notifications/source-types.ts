/** Trusted source contracts for proactive notification admission and recovery. */
export type NotificationSourceReference = {
  sourceId: string;
  ownerId: string;
  /** Stable identity of a particular decision or result within this owner. */
  topicId: string;
  purpose: "decision" | "result";
};

/** Host-owned route context; source references never grant access to another recipient. */
export type NotificationResolveContext = {
  agentId: string;
  recipient: {
    channel: string;
    /** Selected provider prefix removed; target-kind and topic components remain intact. */
    to: string;
    accountId?: string;
    threadId?: string | number | null;
  };
  signal?: AbortSignal;
};

export type NotificationSourceStatus = "open" | "paused" | "answered" | "resolved" | "superseded";

export type NotificationSourceState = {
  /** Source-confirmed topic identity; arbitrary caller-created topics are not authority. */
  topicId: string;
  /** Source-owned meaningful revision, not a model-created key or review timestamp. */
  revision: string;
  status: NotificationSourceStatus;
  resolvedAt?: number;
  /** Explicit source closure date when the owner records a date without a timestamp. */
  resolvedOn?: string;
  /** Source-verified deadline or material consequence that can reopen attention. */
  consequenceKey?: string;
  timeZone: string;
};

export type NotificationReceiptState = Pick<
  NotificationSourceState,
  "status" | "resolvedAt" | "resolvedOn"
>;
export type NotificationReceiptResolveContext = { signal?: AbortSignal };

export type NotificationSourceV1 = {
  contractVersion: 1;
  id: string;
  resolve: (
    reference: NotificationSourceReference,
    context: NotificationResolveContext,
  ) => NotificationSourceState | null | Promise<NotificationSourceState | null>;
  /** Match an opaque owner hash against this source's finite current owners. */
  resolveReceipt?: (
    ownerKey: string,
    context: NotificationReceiptResolveContext,
  ) => NotificationReceiptState | null | Promise<NotificationReceiptState | null>;
};
