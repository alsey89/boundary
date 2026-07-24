import { createApp } from "./app.mjs";

const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, () => {
  console.log(`express-basic listening on http://localhost:${port}`);
});
