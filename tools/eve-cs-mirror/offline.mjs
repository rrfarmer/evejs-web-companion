// Local adaptations are applied in memory; downloaded source stays intact.
export const EXTERNAL_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "images.evetech.net", "esi.evetech.net"];

export function rewriteExternal(text) {
  for (const host of EXTERNAL_HOSTS) {
    const escaped = host.replaceAll(".", "\\.");
    text = text.replace(new RegExp(`(?:https?:)?//${escaped}(?=[/\"'\x60])`, "g"), `/__ext/${host}`);
  }
  return text.replace(/https?:\/\/eve-cs\.com\//g, "/");
}

export function offlineText(text, kind) {
  text = rewriteExternal(text);
  if (kind === "main") {
    // This guest bundle restricts execution to the two production origins.
    // Retain the surrounding startup and guest behavior, adapting only its origin list.
    const guard = /var n2=\[\[.*?\]\];function YF/;
    if (!guard.test(text)) throw new Error("Unrecognized guest bundle origin guard; offline adapter needs review");
    if (!text.includes("});BVe();var n2=")) throw new Error("Unrecognized guest bundle domain-lock bootstrap");
    text = text.replace("});BVe();var n2=", "});var n2=").replace(guard, "var n2=null;function YF");
    text = text.replace("if(!E4e.test(location.hostname))return;Gs.on=!0", "return;Gs.on=!0");
  }
  if (kind === "html") {
    text = text.replaceAll('["localhost","127.0.0.1","[::1]"].includes(location.hostname)', "false");
    text = text.replace(/<link\b[^>]*rel="preconnect"[^>]*>/g, "");
    text = text.replace("<head>", `<head>\n<style>.nav-cta,[href*="auth/sso"],[data-member]{display:none!important}</style>`);
    text = text.replace('<b><span class="dot"></span>Online</b>', '<b><span class="dot"></span>Offline</b>');
  }
  return text;
}
