// Password gate for the whole site while it is in preview.
// Every request needs the fv_gate cookie; without it the visitor gets the
// password page. The form posts to /__gate, which sets the cookie and sends
// them back where they were going. Remove this file to open the site up.

const PASSWORD = "vote";
const COOKIE = "fv_gate";
const TOKEN = "fv-ok-7f3a91"; // bump to sign everyone out

export const config = { matcher: "/:path*" };

const page = (next, wrong) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Farmers Fightback Votes</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #143E65; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #143E65; padding: 16px; box-sizing: border-box; }
  form { background: #F7C325; padding: 32px 24px; border-radius: 6px; width: 100%; max-width: 360px; box-sizing: border-box; display: grid; gap: 14px; }
  h1 { margin: 0; font-size: 26px; text-transform: uppercase; letter-spacing: .02em; }
  p { margin: 0; font-size: 16px; }
  input { font: inherit; font-size: 18px; padding: 14px; border: 2px solid #143E65; border-radius: 4px; background: #fff; }
  button { font: inherit; font-size: 18px; font-weight: 700; text-transform: uppercase; padding: 14px; border: 0; border-radius: 4px; background: #B5121B; color: #fff; cursor: pointer; }
  .err { color: #B5121B; font-weight: 700; }
</style></head>
<body><form method="post" action="/__gate">
  <h1>Farmers Fightback Votes</h1>
  <p>This site is private for now. Enter the password to continue.</p>
  ${wrong ? '<p class="err">That password is not right.</p>' : ""}
  <input type="password" name="pw" placeholder="Password" autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="${next.replace(/[&"<>]/g, "")}">
  <button type="submit">Enter</button>
</form></body></html>`;

const html = (body, status) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

export default async function middleware(request) {
  const url = new URL(request.url);
  const cookies = request.headers.get("cookie") || "";
  const ok = cookies.split(/;\s*/).includes(`${COOKIE}=${TOKEN}`);

  if (url.pathname === "/__gate" && request.method === "POST") {
    const form = await request.formData();
    let next = String(form.get("next") || "/");
    if (!next.startsWith("/") || next.startsWith("//")) next = "/";
    if (String(form.get("pw") || "").trim().toLowerCase() !== PASSWORD) return html(page(next, true), 401);
    return new Response(null, {
      status: 303,
      headers: { location: next, "set-cookie": `${COOKIE}=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`, "cache-control": "no-store" },
    });
  }

  if (ok) return; // carry on to the site

  if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: "Password required" }), { status: 401, headers: { "content-type": "application/json" } });
  return html(page(url.pathname + url.search, false), 401);
}
