export function menuMessage(): string {
  return [
    "📋 *Menu*",
    "",
    "Choose an option below:",
    "• *Status* — view current status",
    "• *Contracts* — list contracts",
    "• *Help* — show help",
  ].join("\n");
}

export function menuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📊 Status", callback_data: "status" }],
      [{ text: "📄 Contracts", callback_data: "contracts" }],
      [{ text: "❓ Help", callback_data: "help" }],
    ],
  };
}
