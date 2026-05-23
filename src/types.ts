export type Account = {
  id: number;
  email: string;
  display_name: string | null;
  picture_url: string | null;
  provider: string;
  created_at: string;
};

export type MessageMeta = {
  id: string;
  thread_id: string | null;
  from: string;
  subject: string;
  snippet: string;
  date_millis: number;
  unread: boolean;
  label_ids: string[];
  account_email: string;
};

export type MessageDetail = {
  id: string;
  thread_id: string | null;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  message_id_header: string;
  references: string;
  html_body: string | null;
  text_body: string | null;
  calendar_body?: string | null;
  calendar_method?: string | null;
  calendar_uid?: string | null;
};

export type ComposeState = {
  from_account: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  references: string | null;
  show_cc_bcc: boolean;
};

export type SyncProgress = { email: string; fetched: number; total: number };
export type SyncDone = { email: string; total: number };
export type SyncError = { email: string; error: string };

export type SyncState = {
  fetched: number;
  total: number;
  status: "idle" | "syncing" | "done" | "error";
  error?: string;
};

export type Folder = { id: string; label: string };

export const FOLDERS: Folder[] = [
  { id: "inbox", label: "Inbox" },
  { id: "pinned", label: "Pinned" },
  { id: "snoozed", label: "Snoozed" },
  { id: "sent", label: "Sent" },
  { id: "archive", label: "Archive" },
  { id: "spam", label: "Spam" },
  { id: "trash", label: "Trash" },
];

export type SnoozePreset = { label: string; fireAt: number };

export function snoozePresets(now: Date = new Date()): SnoozePreset[] {
  const inOneHour = now.getTime() + 60 * 60 * 1000;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextMonday = new Date(now);
  const daysUntilMonday = ((1 + 7 - nextMonday.getDay()) % 7) || 7;
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(9, 0, 0, 0);
  const thisEvening = new Date(now);
  thisEvening.setHours(18, 0, 0, 0);
  return [
    { label: "1 hour", fireAt: inOneHour },
    ...(thisEvening.getTime() > now.getTime() + 30 * 60 * 1000
      ? [{ label: "This evening (6pm)", fireAt: thisEvening.getTime() }]
      : []),
    { label: "Tomorrow 9am", fireAt: tomorrow.getTime() },
    { label: "Next Monday 9am", fireAt: nextMonday.getTime() },
  ];
}
