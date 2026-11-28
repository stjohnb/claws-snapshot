import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  WHATSAPP_ENABLED: false,
}));

vi.mock("../whatsapp.js", () => ({
  whatsappStatus: () => ({ configured: false, connected: false, pairingRequired: false }),
}));

import { buildWhatsAppPage } from "./whatsapp.js";

describe("buildWhatsAppPage events table", () => {
  it("renders the events table as data-cards with a data-label on the title cell", () => {
    const html = buildWhatsAppPage("light");
    expect(html).toContain('class="data-cards"');
    expect(html).toContain('data-label="Event"');
    expect(html).toContain('x-for="ev in events"');
  });
});
