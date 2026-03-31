# Payment System (Stripe-like) - Production-Style Demo

This repository is a production-style payment processing system built for system design practice and as a deployable GitHub portfolio project.

## Capabilities (in-scope)
- Create `PaymentIntent`
- Create `charge` `Transaction` for a `PaymentIntent`
- Poll payment status
- Webhooks (server-to-server) for status changes
- Merchant authentication via API key + HMAC request signing + nonce replay protection
- Durable audit trail via Postgres WAL -> Debezium CDC -> Kafka topics

## Local Development
### Prereqs
- Docker Desktop

### Start
```bash
docker compose up --build
```

Gateway: http://localhost:3000

### Demo merchant credentials
- `public_api_key`: `pk_demo_123`
- `secret_api_key`: `sk_demo_123`

## Notes
- This project includes a **mock payment network** for local testing. Real card handling/tokenization is explicitly out of scope.
