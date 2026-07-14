export type View = "overview" | "keyring" | "activity" | "sessions" | "settings";

export type RequestFilter = "all" | "active" | "completed" | "failed";

export type BusyAction =
  | "load"
  | "save"
  | "duplicate"
  | "apply"
  | "test"
  | "probe"
  | "delete"
  | "gateway-start"
  | "gateway-stop"
  | "settings";

export interface ToastState {
  kind: "success" | "error" | "info";
  message: string;
}
