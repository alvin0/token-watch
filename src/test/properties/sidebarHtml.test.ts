import * as assert from "node:assert";
import { buildSidebarHtml, parseCspDirectives } from "../../host/sidebarHtml.js";

const CSP_SOURCE = "vscode-webview://abc123";

function html(nonce = "test-nonce-123") {
  return buildSidebarHtml({
    nonce,
    scriptUri: `${CSP_SOURCE}/dist/webview.js?v=1`,
    styleUri: `${CSP_SOURCE}/dist/webview.css?v=1`,
    cspSource: CSP_SOURCE,
    lang: "vi",
  });
}

suite("Sidebar WebView CSP", () => {
  test("declares a policy at all", () => {
    const directives = parseCspDirectives(html());
    assert.ok(Object.keys(directives).length > 0, "The document must carry a CSP meta tag");
  });

  test("denies everything by default", () => {
    assert.deepStrictEqual(parseCspDirectives(html())["default-src"], ["'none'"]);
  });

  test("only the nonce may run scripts", () => {
    const scriptSrc = parseCspDirectives(html("abc"))["script-src"];
    assert.deepStrictEqual(scriptSrc, ["'nonce-abc'"]);
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), "Inline scripts must not be allowed");
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), "eval must not be allowed");
    assert.ok(
      !scriptSrc.some((source) => source.startsWith("http")),
      `script-src must contain no remote origin, got ${scriptSrc.join(" ")}`,
    );
  });

  test("styles and fonts come only from the webview origin", () => {
    const directives = parseCspDirectives(html());
    assert.ok(directives["style-src"].includes(CSP_SOURCE));
    assert.ok(
      !directives["style-src"].some((source) => source.startsWith("http")),
      "style-src must not allow a remote origin",
    );
    assert.deepStrictEqual(directives["font-src"], [CSP_SOURCE]);
  });

  test("the page cannot phone home", () => {
    assert.deepStrictEqual(parseCspDirectives(html())["connect-src"], ["'none'"]);
  });

  test("the script tag carries the nonce and points at the bundled asset", () => {
    const document = html("nonce-under-test");
    assert.ok(
      document.includes('<script nonce="nonce-under-test"'),
      "The script tag must carry the same nonce the policy allows",
    );
    assert.ok(document.includes("/dist/webview.js?v=1"));
    assert.ok(!/<script(?![^>]*\bnonce=)/.test(document), "Every script tag must carry a nonce");
  });

  test("the document language follows the UI language", () => {
    assert.ok(html().includes('<html lang="vi">'));
  });
});
