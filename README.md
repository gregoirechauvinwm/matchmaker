# Matchmaker - local v1

AI matchmaker, built step by step. This is the Step 1 skeleton: a server that
boots, connects to your Neon database, and proves the foundation works.

## One-time setup

1. Make sure Node is installed (v18 or newer):
   ```
   node --version
   ```

2. Install the project's dependencies (run this inside the project folder):
   ```
   npm install
   ```

3. Create your secrets file by copying the template:
   ```
   cp .env.example .env
   ```
   Then open `.env` in VS Code and fill in:
   - `DATABASE_URL` - your Neon connection string (the pooled one, from the
     Connect button in the Neon dashboard)
   - `OPENAI_API_KEY` - your OpenAI key (not used until later, but set it now)

4. Create the database tables (run once):
   ```
   npm run db:init
   ```
   You should see "Done. Tables created."

## Running it

```
npm run dev
```

Then open http://localhost:3000 in your browser - you'll see the Step 1 page.
And open http://localhost:3000/health - you should see a JSON response with
`"status": "ok"` and the current time from your database. That confirms the
server is talking to Neon.

To stop the server, press Ctrl+C in the terminal.
