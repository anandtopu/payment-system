import Fastify, { FastifyReply, FastifyRequest } from 'fastify';

const app = Fastify({ logger: true });

const port = Number(process.env.PORT ?? 4000);
const failFirstN = Number(process.env.FAIL_FIRST_N ?? 0);

let count = 0;

app.get('/health', async () => ({ ok: true }));

app.post('/webhooks', async (req: FastifyRequest, reply: FastifyReply) => {
  count += 1;

  const signature = req.headers['x-webhook-signature'];
  app.log.info({ count, signature, body: req.body }, 'webhook_received');

  if (count <= failFirstN) {
    return reply.code(500).send({ error: 'intentional_failure', count });
  }

  return reply.code(204).send();
});

await app.listen({ port, host: '0.0.0.0' });
