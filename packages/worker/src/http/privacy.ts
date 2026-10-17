/*
 * The one page served without Cloudflare Access: Google's OAuth consent screen needs a
 * public privacy policy. It is static text and reads nothing from the database.
 */
const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy - keeper.wk</title>
<style>body{max-width:40rem;margin:3rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif;color:#1c2430}h1{font-size:1.5rem}</style>
</head>
<body>
<h1>Privacy</h1>
<p>keeper.wk is a personal, self-hosted calendar sync. It has one user, its owner, and is not offered to anyone else.</p>
<p>When the owner connects a calendar, keeper.wk reads that calendar's events and copies them into the owner's other calendars. With Google, it uses access to the calendar list and to calendar events for exactly that, and it only ever changes or deletes events it created itself.</p>
<p>Event data and the credentials needed to reach the calendars are stored in the owner's own Cloudflare account. Credentials are encrypted at rest. Nothing is shared with, sold to, or shown to anyone else, and nothing is used for advertising or analytics.</p>
<p>Disconnecting a calendar in the dashboard, or revoking access in the Google account settings, stops all access. The source is public at <a href="https://github.com/jerynv/keeper.wk">github.com/jerynv/keeper.wk</a>.</p>
</body>
</html>`;

const privacyPage = (): Response =>
  new Response(PRIVACY_HTML, {
    headers: { "cache-control": "public, max-age=3600", "content-type": "text/html; charset=utf-8" },
  });

export { privacyPage };
