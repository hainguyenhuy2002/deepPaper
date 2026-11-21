# deepPaper

Open or drop a research PDF to read it. Select text with the mouse, then highlight it, attach a note or ask about the passage. The Notes tab lists saved annotations and jumps to their pages. Reopen the same PDF to see its annotations.

The browser renders the PDF and computes a fingerprint. MongoDB stores the fingerprint, selected text, highlight positions and notes. When you ask a question, the app sends the extracted text of all pages, or the selected passage and its page, to the chosen model. PDFs need a text layer for selection and AI questions. The app keeps the current conversation until you open a paper or reload.

| Shortcut | Action |
| --- | --- |
| H | Highlight selected text |
| N | Add a note to the selection or current page |
| A | Ask about selected text |
| V | Switch to the text selection tool |
| Hold Space and drag | Pan while the PDF reader has focus |
| + / − | Zoom in or out |
| Ctrl or Command + Enter | Send a question |
| Arrow keys / Page Up / Page Down | Scroll when the PDF reader has focus |

## Run on a server

1. Install Node.js 22.13 or newer. Run `npm ci --ignore-scripts`.
2. Create a MongoDB database and a user with the `readWrite` role for it.
3. Copy `.env.example` to `.env`. Set `MONGODB_URI`, `APP_USER` and a strong `APP_PASSWORD`. Restrict the file to the server account.
4. Configure a model. Set `OPENAI_API_KEY` for the Responses API, `ANTHROPIC_API_KEY` for Claude, or `CODEX_BIN` and `CODEX_HOME` for a signed-in Codex CLI. Create `.runtime/job` before enabling Codex. Use a server that can reach the configured provider.
5. Run `npm start`. The app listens on loopback. On the host, use `NGROK_AUTHTOKEN` with an ngrok agent and run `ngrok http http://127.0.0.1:8787 --inspect=false` to publish the HTTPS endpoint. Use the application credentials when opening it.

The PDF size limit is 50 MB. An AI question about the whole paper can include up to 360,000 characters of extracted text. For longer papers, select a passage.
