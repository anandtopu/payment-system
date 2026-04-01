import { app } from './app.js';
const port = Number(process.env.PORT ?? 7000);
await app.listen({ port, host: '0.0.0.0' });

