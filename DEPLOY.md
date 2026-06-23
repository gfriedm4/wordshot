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
   docker compose up -d --build
   ```

That's it. Caddy fetches a Let's Encrypt cert on first boot (give it ~30s after
DNS resolves), and `https://wordshot.art` is live. The leaderboard persists in
the `wordshot-data` Docker volume, so it survives restarts and rebuilds.

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
