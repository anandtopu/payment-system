import { app } from './app.js';
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });

