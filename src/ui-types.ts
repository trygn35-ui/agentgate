export type View = "overview" | "keyring" | "activity" | "settings";

export type FeedTab = "requests" | "history";

export type RequestFilter = "all" | "active" | "completed" | "failed";

export type BusyAction =
  | "load"
  | "save"
  | "duplicate"
  | "apply"
  | "test"
  | "probe"
  | "delete"
  | "undo"
  | "gateway-start"
  | "gateway-stop"
  | "settings";

export interface ToastState {
  kind: "success" | "error" | "info";
  message: string;
  undoId?: string;
}
