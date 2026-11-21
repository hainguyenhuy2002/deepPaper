# deepPaper

Add PDFs by opening or dropping them into the library. Create folders, move papers between them, and click a paper to read it. The browser renders the PDF from MongoDB GridFS. Select PDF text to add a colored highlight or click an existing highlight to change its color or remove it. The Notes tab lets you write and edit notes beside the paper.

The Ask AI tab saves conversations per paper. Show or hide the session list. Hover over a session to pin, rename or delete it. A new session stays blank until you send a question. Choose **Explain**, **Critique** or **Brainstorm** before asking. The reading harness selects relevant page evidence for long papers, includes neighboring pages for a highlighted passage, and asks for page citations and an explicit distinction between findings and interpretation. The reader displays model text as it arrives and saves completed exchanges to MongoDB. Answers support LaTeX equations, Markdown tables and code, and Mermaid diagrams. Quoted citations find and briefly highlight the supporting text in the PDF. Select text in an AI reply to quote it in a follow-up question.

Removing a PDF removes its library listing and stored file. Re-adding an identical file restores its notes and sessions. Remove a folder from its menu to move its papers to Unfiled. Drag the divider between the PDF and chat to resize the panels, or focus it and use the arrow keys.

| Shortcut | Action |
| --- | --- |
| H | Highlight or unhighlight selected text |
| N | Add a note to the selection or current page |
| A | Ask about selected text |
| V | Switch to the text selection tool |
| Hold Space and drag | Pan while the PDF reader has focus |
| + / − | Zoom in or out |
| Enter | Send a question |
| Shift + Enter | Insert a line break |
| Arrow keys / Page Up / Page Down | Scroll when the PDF reader has focus |

## Run on a server

1. Install Node.js 22.13 or newer. Run `npm ci --ignore-scripts`.
2. Create a MongoDB database and a user with the `readWrite` role for it.
3. Copy `.env.example` to `.env`. Set `MONGODB_URI`, `APP_USER` and a strong `APP_PASSWORD`. Restrict the file to the server account.
4. Configure a model. Set `OPENAI_API_KEY` for the Responses API, `ANTHROPIC_API_KEY` for Claude, or `CODEX_BIN` and `CODEX_HOME` for a signed-in Codex CLI with the App Server protocol. Create `.runtime/job` before enabling Codex. Use a server that can reach the configured provider.
5. Run `npm start`. The app listens on loopback. On the host, use `NGROK_AUTHTOKEN` with an ngrok agent and run `ngrok http http://127.0.0.1:8787 --inspect=false` to publish the HTTPS endpoint. Use the application credentials when opening it.

For a local deployment, set `CODEX_HOME` to the directory holding your existing Codex sign-in. If your terminal needs a proxy to reach ChatGPT, set `HTTPS_PROXY` in `.env`. The Codex subprocess inherits the proxy settings.

The PDF size limit is 50 MB. Scanned PDFs need a text layer for selection and AI questions. An AI question about the whole paper can include up to 360,000 characters of extracted text. For longer papers, select a passage.
