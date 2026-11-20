# Central Admin System

Two independent applications that only communicate over a REST API:

| Folder | What | Start |
|---|---|---|
| [`backend/`](backend/README.md) | Node.js + Express API, Neon PostgreSQL, Cloudflare Access auth. Receives the websites' form submissions and serves the admin API. | `cd backend && npm run dev` → <http://localhost:3000> |
| [`frontend/`](frontend/README.md) | React + Vite admin dashboard for Epineon, QAegis and Epi Well. | `cd frontend && npm run dev` → <http://localhost:5173> |
| [`docs/`](docs/) | [API reference](docs/API_DOCUMENTATION.md) · [development guide](docs/DEVELOPMENT_GUIDE.md) | |

**First time? Follow the step-by-step [development guide, section 4](docs/DEVELOPMENT_GUIDE.md#4-run-both-applications-locally).** Use Node 24 (`nvm use` in each folder) and a *development* database — never production.

Status: complete locally and tested; **nothing is deployed** and no website is connected yet.
