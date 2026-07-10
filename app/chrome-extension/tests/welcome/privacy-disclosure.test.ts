import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WelcomeApp, { PRIVACY_POLICY_URL } from "@/entrypoints/welcome/App";

describe("first-install privacy disclosure", () => {
  it("prominently explains local and external data flows and links the policy", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(createElement(WelcomeApp));

    const disclosure = container.querySelector<HTMLElement>(
      '[data-testid="privacy-disclosure"]',
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure?.parentElement?.firstElementChild).toBe(disclosure);

    const disclosureText = disclosure?.textContent ?? "";
    expect(disclosureText).toContain("processes browser data locally");
    expect(disclosureText).toContain("connected MCP client");
    expect(disclosureText).toContain("configured AI provider");
    expect(disclosureText).toContain("page content");
    expect(disclosureText).toContain("screenshots");
    expect(disclosureText).toContain("browsing history");
    expect(disclosureText).toContain("bookmarks");
    expect(disclosureText).toContain("network data");

    const policyLink = disclosure?.querySelector<HTMLAnchorElement>(
      `a[href="${PRIVACY_POLICY_URL}"]`,
    );
    expect(policyLink).not.toBeNull();
    expect(policyLink?.target).toBe("_blank");
    expect(policyLink?.rel).toContain("noopener");
    expect(policyLink?.rel).toContain("noreferrer");
    expect(policyLink?.textContent).toContain("Privacy Policy");
  });
});
