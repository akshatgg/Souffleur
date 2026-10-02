'use strict';

/**
 * Technologies and concepts an interviewer asks about by name.
 *
 * The router needs to tell "what is PostgreSQL" (a knowledge question, answered
 * without the documents) from "what is Beryl" (a name that only exists in this
 * person's own history). A word found in the documents but absent from this
 * list is taken to be theirs; a word on it is taken to be common knowledge.
 *
 * The list also says which technology a question about the person's work is
 * really asking after, so the answer can say plainly when the documents never
 * mention it instead of inventing a use for it.
 *
 * Lower case, as the tokenizer leaves them. Multi-word entries are matched as
 * phrases. A missing entry costs little: the question is still answered, only
 * with or without a few document sections it did not strictly need.
 */
const TERMS = [
  // languages
  'python', 'javascript', 'typescript', 'java', 'kotlin', 'swift', 'golang', 'rust',
  'c++', 'c#', 'php', 'ruby', 'dart', 'scala', 'sql', 'html', 'css', 'bash', 

  // backend and apis
  'fastapi', 'django', 'flask', 'node.js', 'nodejs', 'express.js',
  'nestjs', 'spring boot', 'laravel', 'rails', '.net', 'asp.net', 'graphql',
  'rest api', 'grpc', 'websocket', 'websockets', 'sse', 'server-sent events',
  'webhook', 'webhooks', 'oauth', 'oauth2', 'jwt', 'pkce', 'cors', 'middleware',
  'sqlalchemy', 'alembic', 'pydantic', 'prisma', 'mongoose', 'orm', 'celery', 'uvicorn',
  'socket.io', 'api gateway', 'rate limiting', 'rate limiter', 'pagination', 'idempotency',

  // frontend
  'react', 'react.js', 'next.js', 'nextjs', 'vue', 'angular', 'svelte', 'redux',
  'zustand', 'tailwind', 'tailwind css', 'vite', 'webpack', 'three.js', 'webgl', 'd3',
  'tanstack query', 'react query', 'ssr', 'server-side rendering', 'hydration',
  'virtual dom', 'electron', 'tiptap', 'chart.js', 'recharts', 'webcodecs',

  // mobile
  'android', 'ios', 'flutter', 'react native', 'jetpack compose', 'compose multiplatform',
  'exoplayer', 'workmanager', 'apk', 'device owner', 'swiftui',

  // data
  'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'mongo', 'redis', 'clickhouse',
  'elasticsearch', 'dynamodb', 'cassandra', 'firebase', 'firestore', 'supabase', 'kafka',
  'rabbitmq', 'nosql', 'acid', 'indexing', 'b-tree', 'sharding', 'replication',
  'normalization', 
  'caching', 'connection pooling', 'pub/sub', 'message queue', 's3', 'gcs', 'signed url',
  'signed urls', 'cdn', 'cloud sql',

  // cloud, devops, networking
  'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'k8s', 'eks', 'ecs', 'ec2', 'lambda',
  'cloud run', 'terraform', 'ci/cd', 'github actions', 'jenkins', 'nginx', 'caddy',
  'load balancer', 'load balancing', 'round robin', 'serverless', 'microservices',
  'monolith', 'tailscale', 'headscale', 'vpn', 'wireguard', 'dns', 'tcp', 'udp', 
  'tls', 'ssl', 'ssh', 'adb', 'workload identity federation', 'iam', 'linux',
  'github', 'homebrew',

  // observability
  'prometheus', 'grafana', 'datadog', 'new relic', 'cloudwatch', 'opentelemetry', 'sentry',
  'observability',

  // ai
  'llm', 'rag', 'langchain', 'langgraph', 'openai', 'gemini', 'bedrock', 'claude',
  'embedding', 'embeddings', 'vector database', 'fine-tuning', 'prompt engineering',
  'tool calling', 'whisper', 'onnx', 'ocr', 'tesseract', 
  'machine learning', 'neural network',

  // payments and third parties
  'stripe', 'razorpay', 'twilio', 'whatsapp api', 'playwright', 'selenium',

  // concepts
  'event loop', 'closure', 'closures', 
  'concurrency', 'multithreading', 'mutex', 'deadlock',
  'race condition', 'garbage collection', 'recursion', 'big o', 'hash map', 'hashmap',
  'linked list', 'binary tree', 'binary search', 'dynamic programming', 'oop',
  'polymorphism', 'inheritance', 'encapsulation', 'dependency injection', 'design pattern',
  'design patterns', 'singleton', 'mvc', 'cap theorem', 
  'eventual consistency', 'horizontal scaling', 'vertical scaling', 'scalability',
  'authentication', 'authorization', 'encryption', 'hashing', 'bcrypt', 'xss', 'csrf',
  'sql injection', 'ssrf', 'unit test', 'unit testing', 'integration test', 'tdd',
  'long polling', 'state management', 

  // tools and formats everyone knows, so never mistaken for the person's own
  'slack', 'notion', 'postman', 'swagger', 'cloudflare', 'dependabot', 'gmail', 'junit',
  'crud', 'gpu', 'gps', 'pdf', 'seo', 'rbac', 'pii', 'mailgun', 'postmark', 'lightsail',
  'loki', 'tempo', 'gsap', 'blender', 'restful', 'd3.js', 'excel', 'docx', 'wifi', 'sms',
  'otp', 'ethernet', 'google', 'amazon', 'material-ui', 'figma', 'jira', 'confluence',
];

/**
 * Technical words that are also plain English ("go", "process", "rest").
 *
 * Too ambiguous to say a question is about that technology -- "how did you go
 * about it" is not a question about Go -- but still common knowledge, so
 * finding one capitalised in the documents does not make it the person's own.
 */
const AMBIGUOUS = [
  'go', 'c', 'next', 'rest', 'process', 'solid', 'express', 'spring', 'shell',
  'node', 'index', 'thread', 'threads', 'agent', 'agents', 'async', 'await', 'cache',
  'transaction', 'transactions', 'migration', 'migrations', 'consistency', 'polling', 'promise', 'promises', 'api',
  'sdk', 'metrics', 'logging', 'tracing', 'http', 'https', 'git', 'cron', 'transformer',
  'transformers', 'heartbeat', 'throttle', 'debounce', 'ai', 'ml',
  'app', 'web', 'cloud', 'server', 'client', 'frontend', 'backend', 'database', 'software',
  // CV vocabulary: capitalised in headings and job titles, but nobody's own name
  'engineer', 'engineering', 'developer', 'built', 'error', 'computer', 'science', 'stack',
  'summary', 'value', 'period', 'primary', 'secondary', 'skill', 'technology', 'lead',
  'freelance', 'internship', 'institution', 'club', 'english', 'duration', 'root',
  'retrieval', 'saturation', 'boundary', 'boundaries', 'women', 'monitor', 'fit', 'role',
  'team', 'platform', 'product', 'company', 'experience', 'education', 'project',
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
];

const SET = new Set(TERMS);
const COMMON = new Set([...TERMS, ...AMBIGUOUS]);
const PHRASES = TERMS.filter((t) => /[ /]/.test(t));

module.exports = { TERMS, AMBIGUOUS, SET, COMMON, PHRASES };
