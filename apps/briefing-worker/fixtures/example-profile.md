# Alex Rivers — backend engineer

Sydney, NSW · alex.rivers@example.com · github.com/example-alex

## About

Backend engineer, six years, mostly on services that move a lot of data and
have to stay up while they do it. I like the unglamorous half of the job:
queues that drain, migrations that finish, alerts that mean something. Most of
my work has been Python and Postgres on AWS, with enough Terraform to own what
I ship.

## Experience

**Senior Software Engineer — Cadence Data, Sydney (2023–present)**
Own the ingestion side of a market-data platform: a queue-and-worker pipeline
on SQS and ECS that takes roughly 40 million events a day and lands them in
Postgres and S3. Rewrote the worker's batching so a backlog drains in about
twenty minutes rather than the four hours it used to take, mostly by fixing how
we acknowledged messages rather than by adding capacity. Wrote the on-call
runbook the team actually uses, and took the pager one week in four.

**Software Engineer — Kelpie Health, Sydney (2020–2023)**
Built and maintained the internal API two clinical products read from — FastAPI,
Postgres, deployed to ECS with Terraform. Led the move off a single shared
database to per-service schemas, which took two quarters and shipped without a
maintenance window. Set up the first useful dashboards the team had: request
latency, queue depth, and error rate by endpoint.

**Junior Developer — Foundry Interactive, Sydney (2019–2020)**
Django and Postgres for agency clients. Learned to read other people's code
quickly and to ask what a feature was for before building it.

## Tools

Python (FastAPI, Django, asyncio), SQL and Postgres, AWS (ECS, Lambda, SQS, S3,
RDS), Terraform, Docker, GitHub Actions. Some Go — enough to review it, not
enough to claim it.

## Education

BSc Computer Science, University of Technology Sydney, 2019.

## Looking for

A senior backend role in Sydney, hybrid, where the data volume is real and I
own the pipeline end to end rather than a slice of it.
