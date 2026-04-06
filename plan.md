# D7 Lead Finder — Plan

## What is this?

A tool that finds business leads. You give it a list of cities and job types (e.g. "plumber", "dentist"), and it searches the D7 database for matching businesses — returning their name, phone, email, website, address, and review ratings (Google, Yelp, Facebook).

---

## How the D7 API works (important constraints)

- A search = one keyword + one city. So "plumber" in 3 cities = 3 separate searches.
- After starting a search, you must wait a few seconds (the API tells you how long) before you can fetch the results.
- There's a daily limit on how many searches you can run.

---

## What we're building

### 1. Web UI

A simple webpage with:
- A form to enter keywords (e.g. plumber, dentist) and cities — you can add multiple of each
- A "Run" button that queues up all the city × keyword combinations as jobs
- A live job list showing the status of each search (queued → running → done / failed)
- A results table that fills in as jobs complete

### 2. Job runner (backend)

Runs in the background and processes the job queue:
- Picks up jobs one at a time (or a small number at a time)
- Starts each search, waits the required delay, then fetches the results
- Tracks each job's status and result count
- Respects the daily search quota — pauses or warns if the limit is close

### 3. Results export

- Download all results as a CSV file (name, phone, email, website, address, ratings)
- Later: save results to a Supabase table so they're stored permanently

### 4. Account info panel

A small panel showing:
- How many searches you've used today
- How many you have left
- When the quota resets

---

## Tech stack

- **Frontend**: React (or plain HTML to start) — job form + live status list
- **Backend**: Node.js with Express — job queue, D7 API calls, CSV export
- **Storage**: In-memory job state to start → JSON file → Supabase later
- **D7 API key**: stored in a `.env` file, never exposed to the browser
