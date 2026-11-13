# SevakTV: a web IPTV player

Watch an IPTV subscription in the browser. It supports **Xtream Codes** logins, **Stalker / MAG portals** (portal URL + MAC address), and **M3U playlists** (link or file). It ships with no channels: you bring your own provider or playlist.

## Two ways to run it

- **On Vercel:** a public web address that works from anywhere. See [Deploy on Vercel](#deploy-on-vercel).
- **At home:** on your own computer, below.

## Run it at home

You need [Node.js](https://nodejs.org) 18 or newer. There's nothing to install.

```bash
cd sevaktv
node server.js
```

Then open **http://localhost:8080**.

The small helper server (`server.js`) serves the app and relays playlist and stream requests. Browsers block most IPTV servers on their own, for three reasons: the servers lack CORS headers, they use plain `http://` links, and some need a specific User-Agent or Referer. The relay gets around all three. You *can* open `public/index.html` directly, but many providers won't load that way.

To use it from a phone or TV on the same Wi-Fi:

```bash
HOST=0.0.0.0 node server.js
```

Then open `http://<your-computer-ip>:8080` on the other device.
⚠️ Anyone on your network can then use the relay, so never expose this port to the internet.

## Features

- **Xtream Codes login:** live channels, movies and series by category, with a now/next TV guide and account status (expiry date, connections).
- **Stalker portal (MAG / Ministra):** sign in with the portal URL (any form: `http://host:port`, `…/c/` or `…/stalker_portal/c/`; SevakTV finds the portal behind it, following redirects) and your MAC address. Serial number and device ID are optional. You get live channels with a TV guide, plus movies and series. Movie and series lists load page by page, newest first, up to the newest 3,000 per category. Stalker portals need the helper server.
- **One MAC per device:** each phone, TV or computer that opens SevakTV automatically gets its own MAC address (`00:1A:79:…`). It's shown on the Stalker sign-in screen with a Copy button: give it to your provider to activate. Manage all devices in **Settings → Manage devices**: rename them, set or regenerate a MAC, re-link a browser that lost its settings ("Use on this device"), and see who's watching. The list is saved in `data/devices.json`; back up that file to keep your assignments.
- **TV guide & catch-up:** on a live channel, tap **TV guide** to see the schedule for today and tomorrow. If the channel supports catch-up (Xtream `tv_archive` or Stalker archive), past days appear too, each programme with a **Watch** button. Channels with catch-up say "Catch-up" in the list.
- **Resume where you left off:** movies and episodes remember your position (after 30 seconds of watching). Open one again and press **Resume**, or **Play from start**. Movies and Series show a **Continue watching** row. Anything within the last 90 seconds counts as finished.
- **M3U link or file:** groups, logos, channel numbers, and `#EXTVLCOPT` User-Agent/Referer headers.
- A `get.php?username=…&password=…` link is recognised as an Xtream login automatically.
- **Player:** SevakTV's own controls on every device:
  - **⟲10s / 10s⟳** buttons; on phones, **double-tap** the left/right side of the video
  - seek bar, **speed** (0.5×–2×), **audio language**, **quality** (Auto/1080p/…), volume, **picture-in-picture**, fullscreen
  - **live TV:** channel ▲/▼, and on channels that keep recent video, rewind plus a **Go live** button
  - **subtitles (CC button):** built-in tracks and live captions, **your own .srt/.vtt file**, or **Search online** (OpenSubtitles); adjust **timing** (±0.5s) and **size**; your subtitle language is remembered
  - **series:** a **Next episode** button, and at the end of an episode a 10-second countdown that plays the next one (Cancel to stop)
  - plays HLS (hls.js), MPEG-TS (mpegts.js) and MP4/MKV, trying the next method if one fails and reconnecting after network drops
  - on iPhone, fullscreen uses Apple's own player (with its own skip, subtitle and audio menus), and volume follows the phone's buttons
- **Keyboard:** Space/K play-pause · ←/→ 10s · ↑/↓ channel · F fullscreen · M mute · C subtitles · N next episode · P picture-in-picture · / search · Esc closes menus
- **Favorites, search, several playlists,** and a remembered last section. Everything is stored in your browser (localStorage).
- Responsive from phone to desktop.

## Online subtitles (optional)

1. Create a free account at opensubtitles.com.
2. Open your profile → **API consumers** → create one, and copy its **API key**.
3. In SevakTV: **Settings → Online subtitles**, paste the key, optionally add your username and password (raises the daily download limit), and set your languages (e.g. `en,hi`).
4. In the player: **CC → Search online**. The title, year and episode are filled in for you.

The key is stored once on the helper server (`data/settings.json`) for all your devices.

## Deploy on Vercel

1. **Import the project.** In [vercel.com](https://vercel.com), choose **Add New → Project**, pick this GitHub repository and click **Deploy**. You don't need to change any settings; `vercel.json` sets everything up.
2. **Connect a database** (needed for device MACs and online subtitles). In your Vercel project, go to **Storage → Create Database → Upstash for Redis** (free plan) and connect it to this project. Vercel adds the connection settings by itself.
3. **Set an access password** (strongly recommended, because the address is public). Go to **Settings → Environment Variables**, add `SEVAK_PASSWORD` with a password of your choice, and save.
4. **Redeploy.** Go to **Deployments**, open the ⋯ menu on the latest one, and choose **Redeploy**, so the database and password take effect.
5. Open `https://<your-project>.vercel.app`, enter the password, and add your playlist.

**Limits on Vercel** (the home version doesn't have these):

- **Function time limit.** Each request may run for at most 60 seconds. Live HLS channels and movies work, because movies are relayed in 8 MB pieces. **Live channels in MPEG-TS format may cut out**, so keep **Settings → Live stream format** on **HLS**.
- **Bandwidth.** All video passes through Vercel. The free (Hobby) plan includes about 100 GB of transfer a month, roughly 25–50 hours of TV, and is for non-commercial use. Heavy video relaying can get a project paused under Vercel's fair-use rules.
- **Data-center addresses.** Your IPTV provider sees Vercel's addresses instead of your home one. Some providers block data-center addresses, and Stalker portals may end your session when the address changes. If a provider refuses streams on Vercel but works at home, use the home version.
- **One shared list.** Device MACs and the subtitle key are stored in your Upstash database. Playlists, favorites and resume positions stay in each browser.

## Files

```
server.js          home server (serves the app + uses lib/)
lib/core.js        relay, stream check, devices, subtitles, access password
lib/storage.js     data/ files at home, Upstash Redis on Vercel
api/sevak.js       Vercel function (uses lib/)
vercel.json        Vercel settings
public/index.html  app markup
public/style.css   styles
public/app.js      app logic (parsing, Xtream/Stalker, playback, guide, resume)
public/player-ui.js player controls, subtitles, gestures, up-next
data/              device list and settings (created automatically; keep it private)
public/vendor/     hls.js 1.6.8 and mpegts.js 1.8.0 (Apache-2.0)
```

## Troubleshooting

| Problem | What to try |
|---|---|
| Stalker: "Couldn't find a Stalker portal" | Type the address exactly as your provider gave it, including the port. Both `http://host:port` and `http://host:port/c/` work. The error lists every address tried; send that list to whoever helps you. |
| Stalker: "didn't accept this device's MAC" | The portal was found, but your provider hasn't activated this device's MAC yet. Copy it from the sign-in screen and send it to them. |
| "Login failed" | Check the server URL includes the port, e.g. `http://example.com:8080`. |
| Channel won't start | SevakTV now tells you why: provider refused (too many connections, expired, blocked), stream not found, or a format the browser can't play (HEVC video, Dolby audio, MPEG-2). Tap **Details** for the technical reasons, or **Copy stream link** / **Open in VLC**. If the other live format works, SevakTV switches to it automatically. |
| Provider blocks the app | Settings → set a **User-Agent override**, e.g. `VLC/3.0.20 LibVLC/3.0.20`. |
| Movie plays without picture or sound | The browser can't decode that codec (common with MKV/HEVC/AC3). Try Safari or Edge, or a native player. |

## Ideas for next steps

- Full XMLTV guide (grid view) for M3U playlists using `url-tvg`
- Catch-up / timeshift for Xtream channels with `tv_archive`
- Resume position for movies and episodes
- Parental PIN for categories
- Package as an installable PWA, or wrap it with Capacitor/Electron for TV and desktop

## Legal

SevakTV is only a player. Use it with content you have the right to watch: your own subscription, free-to-air channels, or your own streams.
