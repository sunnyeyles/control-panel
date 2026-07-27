## Project overview

We are building a scheduled research pipeline that collects information from external websites and generates structured Markdown briefs.

The pipeline should run on a cron schedule and contain two stages:

1. **Scraper agents**

   - Each scraper agent is responsible for one source or source type.
   - Agents search or scrape configured websites, extract relevant information, and return structured results.
   - Scraping should be implemented behind reusable tools or adapters rather than embedded directly into agent prompts.
   - Use normal HTTP fetching and HTML parsing where possible.
   - Support a headless browser such as Playwright only for websites that require JavaScript rendering.
   - Scrapers must handle timeouts, retries, rate limits, duplicate results, and partial failures.

2. **Synthesiser agent**

   - Receives the results from all scraper agents.
   - Validates, combines, deduplicates, and ranks the collected information.
   - Generates a final brief in Markdown.
   - Stores structured metadata and processing status in the database.
   - Stores the complete `.md` brief in Amazon S3.
   - Updates the database record with the S3 object key and generation details.

## Current and planned infrastructure

- The frontend and application are deployed on Vercel.
- The application database is Neon Postgres.
- Existing cloud infrastructure is managed with Terraform in the `infra/` directory.
- The only existing cloud worker infrastructure is an Azure Function.
- We are migrating the scheduled worker from Azure Functions to AWS Lambda.
- Amazon EventBridge Scheduler will trigger the Lambda worker on a cron schedule.
- Amazon S3 will privately store generated Markdown briefs.
- Neon Postgres will store users, brief metadata, source records, job state, processing status, and S3 object keys.
- AWS IAM will provide least-privilege access.
- Secrets should use AWS Secrets Manager, SSM Parameter Store, or deployment-provided environment variables.
- CloudWatch should provide logs, metrics, and failure visibility.
- All AWS infrastructure must be provisioned through Terraform.

## Desired workflow

1. EventBridge starts the scheduled job.
2. The worker creates a job record in Neon.
3. Scraper agents run against configured sources.
4. Each scraper returns structured source data and citations.
5. Failures from one scraper should not necessarily stop the entire job.
6. The synthesiser processes all successful scraper outputs.
7. The synthesiser generates the Markdown brief.
8. The worker uploads the `.md` file to the private S3 bucket.
9. The worker updates Neon with:

   - Job status.
   - Brief metadata.
   - Source references.
   - S3 object key.
   - Generation timestamp.
   - Errors or warnings.

10. CloudWatch records logs and operational metrics.

## Design requirements

- Keep scraping, synthesis, storage, database, and scheduling concerns separated.
- Define clear typed interfaces between scraper agents and the synthesiser.
- Make individual scrapers replaceable without changing the rest of the pipeline.
- Keep AWS-specific code behind infrastructure or storage adapters.
- Make jobs idempotent so retries do not create duplicate briefs.
- Preserve source URLs and timestamps for traceability.
- Do not make the S3 bucket or generated briefs public.
- Do not store permanent public S3 URLs in the database.
- Use the S3 object key as the persistent file reference.
- Design for local development and automated testing.
- Avoid modifying the Vercel deployment or Neon infrastructure unless integration changes are required.

Use this context when inspecting the repository, proposing architecture, planning work, or implementing the scraper and synthesis pipeline. Clearly distinguish existing functionality from infrastructure that is currently being added.
