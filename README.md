# D7 Lead Bot

A web-based automation bot for D7 Lead Finder that searches multiple cities and keywords at once, downloads all results, and exports them as a single combined CSV file.

---

## Requirements

Before you start, make sure you have the following installed on your computer:

- **Node.js** (v18 or later) — https://nodejs.org
- **Git** — https://git-scm.com
- A **D7 Lead Finder account** — https://dash.d7leadfinder.com

---

## Setup (First Time Only)

### Step 1 — Download the bot

Open a terminal (Command Prompt or PowerShell on Windows) and run:

```
git clone https://github.com/Kale-Acquisition/D7-Lead-Bot.git
cd D7-Lead-Bot
```

### Step 2 — Install dependencies

```
npm install
```

### Step 3 — Install the Chromium browser (required for Bulk Search)

```
npx playwright install chromium
```

This installs a lightweight browser that the bot uses to automate D7's Bulk Search. It runs in the background and only shows in your taskbar — it won't pop up on your screen.

### Step 4 — Create your .env file

Copy the example file and fill in your credentials:

```
copy .env.example .env
```

Open the `.env` file in any text editor and fill in the following:

```
D7_API_KEY=your_d7_api_key_here
D7_EMAIL=your_d7_login_email
D7_PASSWORD=your_d7_login_password
HEADLESS=false
PORT=3000
```

- **D7_API_KEY** — found in your D7 dashboard under API settings
- **D7_EMAIL** — the email you use to log in to D7
- **D7_PASSWORD** — your D7 login password
- **HEADLESS** — keep as `false` so the browser shows in your taskbar

---

## Running the Bot

Every time you want to use the bot, open a terminal in the `D7-Lead-Bot` folder and run:

```
npm run dev
```

Then open your browser and go to:

```
http://localhost:3000
```

---

## Connecting Your D7 Account (First Time Only)

D7's Bulk Search requires a one-time manual login to solve a CAPTCHA:

1. In the bot UI, select **D7 Bulk Search (Browser)** as the Source
2. Click **Connect D7 Account**
3. A browser window will open with your credentials pre-filled
4. Solve the CAPTCHA and click Login
5. The window will close automatically and the status will show **Connected**

You only need to do this once. The session is saved and reused automatically.

---

## How to Run a Search

1. Enter your **keywords** (one per line) — e.g. Dentist, Plumber, Electrician
2. Enter your **cities** (one per line) — e.g. New York, Los Angeles, Chicago
3. Select the **Source** (use **D7 Bulk Search (Browser)** for best results)
4. Click **Run**

The bot will:
- Submit each city search to D7 (65 seconds apart to respect D7's rate limit)
- Wait for D7 to process all searches in parallel
- Download all results automatically
- Display everything as one combined table in the UI

---

## Exporting Results

Click the **Export CSV** button in the top right of the results panel. This downloads all leads from all searches as a single CSV file with every column included.

---

## Stopping and Resuming

- Click **Stop Queue** at any time to pause — current job is re-queued
- Click **Resume Queue** to continue from where it left off

---

## Troubleshooting

| Problem | Solution |
|---|---|
| City shows as "failed" | D7 couldn't find that city — check the spelling and try again |
| "D7 login required" error | Click **Connect D7 Account** and complete the login |
| Bot is paused with an error message | Read the error, fix the issue, then click **Resume Queue** |
| Port 3000 already in use | Change `PORT=3001` in your `.env` file |
| Browser not launching | Run `npx playwright install chromium` again |
