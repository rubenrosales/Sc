# SC26 Planner

A simple, fast, offline-friendly schedule app for the SC26 supercomputing conference (Nov 15–20, 2026 · McCormick Place, Chicago).
It's a static site (plain HTML/CSS/JS, no build step) hosted on GitHub Pages.

## What it does

- **My Schedule**: shows the events you've starred, with a "Now / Next" card (where to go and when), free gaps between sessions, and overlap warnings.
- **Full Schedule**: browse by day, search titles, speakers and rooms across all days (press `/`), filter by type, and hide sessions that are already over.
- **Mark events**: tap ☆ on any session. Add your own items too (meetings, booth visits, dinners) with **＋ Add**.
- **Share what you're attending**:
  - **🔗 Share my schedule** creates a link with your picks. People who open it see your schedule, and your initials show up on the sessions you're going to. They don't need an account, and there's no server.
  - **📋 Copy as text** gives a plain list to paste into Slack, email or a text message.
  - **📅 Calendar (.ics)** exports to Apple, Google or Outlook calendars, with a reminder 10 minutes before each event.
- **Notes** on any session.
- **Works offline** after the first load. Use *Add to Home Screen* to get an app icon.
- Your data stays on your device (localStorage). You can back it up and restore it under *More*.

All times are Chicago time (the venue's local time), whatever time zone your phone is set to.

## Loading the real program

`data/schedule.json` currently holds a **draft skeleton** of typical SC landmarks, and it is labeled that way in the app.
There are two ways to load the official program:

1. **On your phone:** *More → Import* accepts `.ics`, `.csv` or JSON. Imported sessions are saved on your device.
2. **For everyone using the site:** convert an export and commit it:
   ```sh
   node tools/build-schedule.mjs program.ics --replace --notice ""
   git commit -am "Load official program" && git push
   ```
   CSV needs a `title` column. It also recognizes `date`, `start`, `end` (or a single `time` like `10:30 AM - 12:00 PM`), `room`, `type`, `speakers`, `description` and `url`.

## Deploy (GitHub Pages)

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push. The `.github/workflows/pages.yml` workflow publishes the site to `https://<user>.github.io/<repo>/`.

Free GitHub plans need the repo to be **public** to use Pages. If it's private, you can drag the folder onto [Netlify Drop](https://app.netlify.com/drop) instead, which is free.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```
Add `?now=2026-11-17T10:15` to the URL to preview the app as if it were that moment.
