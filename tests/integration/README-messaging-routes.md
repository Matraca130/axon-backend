# Messaging Routes Integration Tests

Complete integration test suite for Telegram and WhatsApp messaging integrations.

## File Location
`tests/integration/messaging-routes.test.ts` (1341 lines)

## What's Tested

### Telegram Routes
- **POST /webhooks/telegram** — Incoming message webhook
  - Secret token verification
  - Message deduplication
  - Linking code validation
  - Rate limiting
  
- **POST /telegram/link-code** — Generate linking code
  - Authentication required
  - Duplicate link detection
  - 6-digit code generation with 5-min expiry
  
- **GET /telegram/link-status** — Check if linked
  - Returns linked status and username
  - Handles unlinked users
  
- **POST /telegram/setup-webhook** (Admin) — Configure webhook URL
  - Service role key validation
  - Bot info retrieval
  
- **POST /telegram/process-queue** — Job queue processing
  - Service role key validation
  - Async job batch processing

### WhatsApp Routes
- **GET /webhooks/whatsapp** — Meta verification challenge
  - Verify token validation
  - Challenge echo for webhook setup
  
- **POST /webhooks/whatsapp** — Incoming webhook
  - HMAC-SHA256 signature verification
  - Message parsing (text, voice, image, interactive)
  - Deduplication
  - Linking code validation
  - Rate limiting
  
- **POST /whatsapp/link-code** — Generate linking code
  - Authentication required
  - Duplicate link detection
  - Phone number hashing
  
- **POST /whatsapp/unlink** — Deactivate phone link
  - Authentication required
  
- **POST /whatsapp/process-queue** — Job queue processing
  - Service role key validation

### Feature Flags
- Both integrations respect `TELEGRAM_ENABLED` and `WHATSAPP_ENABLED` env vars
- Returns 503 when disabled

## Test Coverage

**58 test cases total:**
- 28 Telegram tests
- 28 WhatsApp tests
- 2 feature flag tests

### Categories
- **Happy paths**: Valid inputs, correct authentication, successful responses
- **Error paths**: Missing/invalid credentials, bad signatures, expired codes
- **Security**: Token validation, HMAC verification, rate limiting
- **Admin paths**: Service role key validation
- **Queue processing**: Async job handling

## Running Tests

```bash
deno test tests/integration/messaging-routes.test.ts --allow-all
```

All tests are self-contained with mocked databases and external APIs. No real network calls or database connections needed.

## Mock Architecture

### Database
- Configurable per-table responses (select/insert/update/delete)
- Chainable fluent API matching Supabase patterns
- Isolated state per test

### Authentication
- JWT token helper function
- `authenticate()` stubbing with configurable auth state
- Both authenticated and unauthenticated paths tested

### External APIs
- **Telegram**: `sendTextPlain()`, `setWebhook()`, `getMe()`
- **WhatsApp**: `sendText()`, `hashPhone()`
- HMAC-SHA256 signature generation for WhatsApp

## Key Test Patterns

### Webhook Secret Verification (Telegram)
```typescript
// Without secret token → 401
// With wrong secret → 401
// With correct secret → 200
```

### HMAC Signature Verification (WhatsApp)
```typescript
// Missing signature → 401
// Invalid signature → 401
// Valid signature → 200
```

### Authentication Flows
```typescript
// Without JWT → 401
// With JWT → 200 (on valid operation)
```

### Admin Operations
```typescript
// Without Bearer token → 401
// With wrong Bearer token → 401
// With correct Bearer token → 200
```

## Test Data

**Telegram:**
- Chat ID: 123456789
- Message ID: 1
- Bot token: 123456:ABC-DEF1234...
- Webhook secret: tg_secret_token_12345

**WhatsApp:**
- Phone: +12025551234
- Phone ID: 123456789
- Message ID: wamid.HBEUGoNkJWEJAgo...
- App secret: whatsapp_app_secret_12345
- Verify token: whatsapp_verify_token_12345

**Shared:**
- User ID: aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb
- Linking code: 123456
- Service role key: fake-service-role-key

## Assertions

Tests use Deno std assertions:
- `assertEquals()` — exact value comparison
- `assertExists()` — value is not null/undefined
- `assertStringIncludes()` — substring matching
- `assertFalse()` — boolean false
- `assert()` — truthy check

## Important Notes

1. **No External Dependencies**: All tests use mocks. No real Telegram/WhatsApp API calls.
2. **Isolated**: Each test has its own database mock and stub list.
3. **Cleanup**: All stubs restored in finally blocks.
4. **Parallelizable**: Tests don't share state and can run concurrently.
5. **Environment Variables**: All required env vars configured at module load time.

## Adding New Tests

Follow the pattern:

```typescript
Deno.test("feature-path: describes what is tested", async () => {
  const stubs: StubList = [];
  const mockDb = createMockDb();
  setupAuthStub(stubs, mockDb);
  setupGetAdminClientStub(stubs, mockDb);
  
  // Configure mock responses
  mockDb.setTable("table_name", {
    selectResponse: { data: {...}, error: null },
  });
  
  // Optional: stub external APIs
  const stub1 = stub(moduleName, "funcName", async () => {...});
  stubs.push(stub1);
  
  try {
    const app = buildApp();
    const res = await app.request("/path", {
      method: "POST",
      headers: {...},
      body: JSON.stringify({...}),
    });
    
    assertEquals(res.status, expectedCode);
    const json = await res.json();
    assertExists(json.data);
  } finally {
    restore(); // Cleans up all stubs
  }
});
```

## References

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Deno Testing](https://docs.deno.com/runtime/manual/testing)
- [Hono Framework](https://hono.dev/)
