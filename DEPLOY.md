# Deploying Wordshot

Self-hosted on a small VPS (Hetzner CX22 ~€4/mo or a DigitalOcean $6 droplet
both work). The app + Caddy (automatic HTTPS) run via Docker Compose.

## One-time setup

1. **DNS** — at your registrar, point `wordshot.art` (and `www`) at the server's
   public IP:
   ```
   A   wordshot.art      <server-ip>
   A   www.wordshot.art  <server-ip>
   ```

2. **Server** — install Docker (`curl -fsSL https://get.docker.com | sh`), then:
   ```
   git clone https://github.com/gfriedm4/wordshot.git
   cd wordshot
   echo "GEMINI_API_KEY=your-key-here" > .env
   # Analytics secrets (generated once, never commit them):
   cat >> .env <<EOF
   UMAMI_DB_PASSWORD=$(openssl rand -hex 24)
   UMAMI_APP_SECRET=$(openssl rand -hex 32)
   EOF
   docker compose up -d --build
   ```

That's it. Caddy fetches a Let's Encrypt cert on first boot (give it ~30s after
DNS resolves), and `https://wordshot.art` is live. The leaderboard persists in
the `wordshot-data` Docker volume, so it survives restarts and rebuilds.

## Analytics (Umami)

Self-hosted, privacy-friendly, cookieless. Served first-party at
`https://wordshot.art/stats` so the tracker is same-origin (no third-party
requests, satisfies the game's CSP) and all data stays in the `umami-db-data`
volume on this box.

One-time, after the first deploy:

1. Open `https://wordshot.art/stats` and log in with the default
   `admin` / `umami`. **Change the password immediately** (Settings → Profile).
2. Settings → Websites → Add. Name it `Wordshot`, domain `wordshot.art`.
3. Copy the generated **Website ID** (a UUID). The tracking snippet in
   `public/index.html` reads it from `data-website-id` — drop the UUID in there,
   commit, and the next deploy starts collecting.

The two `UMAMI_*` secrets live only in `.env` on the server, never in the repo.

## Updating

```
git pull
docker compose up -d --build
```

## Notes

- The Gemini key lives only in `.env` on the server (gitignored), never in the repo.
- Open ports 80 and 443 in the VPS firewall; Caddy needs both (80 for the
  ACME challenge, 443 for traffic).
- Logs: `docker compose logs -f wordshot`
