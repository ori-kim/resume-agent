import { Hono } from "hono";
import { corsMiddleware } from "./middleware/cors.ts";
import { health } from "./routes/health.ts";
import { provider } from "./routes/provider.ts";
import { rag } from "./routes/rag.ts";
import { chat } from "./routes/chat.ts";
import { form } from "./routes/form.ts";

const app = new Hono();

app.use("*", corsMiddleware);

app.route("/health", health);
app.route("/provider", provider);
app.route("/rag", rag);
app.route("/chat", chat);
app.route("/form", form);

export type AppType = typeof app;
export { app };
