import { app } from './app.js';
const port = Number(process.env.PORT ?? 3003);
await app.listen({ port, host: '0.0.0.0' });

