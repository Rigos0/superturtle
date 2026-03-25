import type { DriverStatusType } from "./types";

export enum OutboundMessageKind {
  InteractiveProgress = "interactive_progress",
  InteractiveFinal = "interactive_final",
  InteractiveSideEffect = "interactive_side_effect",
  InputProcessingStatus = "input_processing_status",
  CommandUi = "command_ui",
  CallbackUi = "callback_ui",
  BackgroundNotification = "background_notification",
  SystemNotification = "system_notification",
  ErrorOrStop = "error_or_stop",
}

export function classifyDriverStatusMessage(
  statusType: DriverStatusType
): OutboundMessageKind | null {
  switch (statusType) {
    case "thinking":
    case "tool":
    case "text":
      return OutboundMessageKind.InteractiveProgress;
    case "segment_end":
      return OutboundMessageKind.InteractiveFinal;
    case "done":
      return null;
  }
}

export function classifyCodexToolCompletionMessage(
  toolName: string
): OutboundMessageKind | null {
  const normalizedTool = toolName.toLowerCase().replace(/-/g, "_");

  switch (normalizedTool) {
    case "ask_user":
    case "bot_control":
    case "pino_logs":
    case "send_file":
    case "send_image":
    case "send_turtle":
      return OutboundMessageKind.InteractiveSideEffect;
    default:
      return null;
  }
}
