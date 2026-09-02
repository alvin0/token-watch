/**
 * The sidebar WebView document.
 *
 * Kept out of `SidebarProvider` so the Content-Security-Policy can be asserted
 * directly by a test instead of inferred from the manifest. The previous test
 * named "strict CSP + nonce" only checked that a webview view was contributed,
 * which would still pass with no CSP at all.
 *
 * This module MUST NOT import `vscode`.
 */

export interface SidebarHtmlOptions {
  nonce: string;
  scriptUri: string;
  styleUri: string;
  /** `webview.cspSource` — the only origin allowed to serve styles and images. */
  cspSource: string;
  /** BCP-47 tag for the document language. */
  lang?: string;
}

export function buildSidebarHtml({
  nonce,
  scriptUri,
  styleUri,
  cspSource,
  lang = "en",
}: SidebarHtmlOptions): string {
  return /* html */ `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    img-src ${cspSource} https: data:;
    font-src ${cspSource};
    connect-src 'none';
  ">
  <link rel="stylesheet" href="${styleUri}" />
  <title>Token Watch</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Parse the `content` of the CSP meta tag into directive → sources. */
export function parseCspDirectives(html: string): Record<string, string[]> {
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  if (!match) { return {}; }
  const directives: Record<string, string[]> = {};
  for (const part of match[1].split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) { continue; }
    directives[tokens[0]] = tokens.slice(1);
  }
  return directives;
}
