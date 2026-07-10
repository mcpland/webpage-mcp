import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WelcomeApp, { PRIVACY_POLICY_URL } from "@/entrypoints/welcome/App";

const localeExpectations = [
  {
    locale: "en",
    terms: [
      "workflow",
      "trigger",
      "HTTP",
      "upload",
      "download",
      "website",
      "endpoint",
    ],
  },
  {
    locale: "de",
    terms: [
      "Workflow",
      "Trigger",
      "HTTP",
      "hoch-",
      "herunterladen",
      "Website",
      "Endpunkt",
    ],
  },
  {
    locale: "ja",
    terms: [
      "ワークフロー",
      "トリガー",
      "HTTP",
      "アップロード",
      "ダウンロード",
      "ウェブサイト",
      "エンドポイント",
    ],
  },
  {
    locale: "ko",
    terms: [
      "워크플로",
      "트리거",
      "HTTP",
      "업로드",
      "다운로드",
      "웹사이트",
      "엔드포인트",
    ],
  },
  {
    locale: "zh_CN",
    terms: ["工作流", "触发器", "HTTP", "上传", "下载", "网站", "端点"],
  },
  {
    locale: "zh_TW",
    terms: ["工作流程", "觸發器", "HTTP", "上傳", "下載", "網站", "端點"],
  },
] as const;

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
    expect(disclosureText).toContain(
      "workflow or trigger you previously enabled runs",
    );
    expect(disclosureText).toContain("connected MCP client");
    expect(disclosureText).toContain("configured AI provider");
    expect(disclosureText).toContain("requested website or endpoint");
    expect(disclosureText).toContain("page content");
    expect(disclosureText).toContain("screenshots");
    expect(disclosureText).toContain("browsing history");
    expect(disclosureText).toContain("bookmarks");
    expect(disclosureText).toContain("network data");
    expect(disclosureText).toContain("HTTP requests");
    expect(disclosureText).toContain("upload or download files");

    const policyLink = disclosure?.querySelector<HTMLAnchorElement>(
      `a[href="${PRIVACY_POLICY_URL}"]`,
    );
    expect(policyLink).not.toBeNull();
    expect(policyLink?.target).toBe("_blank");
    expect(policyLink?.rel).toContain("noopener");
    expect(policyLink?.rel).toContain("noreferrer");
    expect(policyLink?.textContent).toContain("Privacy Policy");
  });

  it.each(localeExpectations)(
    "keeps the automatic-run disclosure complete in $locale",
    ({ locale, terms }) => {
      const messages = JSON.parse(
        readFileSync(
          join(process.cwd(), "_locales", locale, "messages.json"),
          "utf8",
        ),
      ) as { welcomePrivacySummary?: { message?: string } };
      const summary = messages.welcomePrivacySummary?.message ?? "";

      for (const term of terms) {
        expect(summary).toContain(term);
      }
    },
  );
});
