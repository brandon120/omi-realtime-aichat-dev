# OMI Device Linking API Documentation

## Overview

The OMI device linking feature allows users to connect their OMI devices to their accounts using a secure OTP (One-Time Password) verification process.

## Endpoints

### 1. Start OMI Linking
**POST** `/link/omi/start`

Initiates the device linking process by generating a verification code.

#### Request
```json
{
  "omi_user_id": "device-unique-id"
}
```

#### Response (Success)
```json
{
  "ok": true,
  "dev_code": "123456"  // Only in development mode
}
```

#### Response (Already Linked)
```json
{
  "ok": true,
  "already_linked": true
}
```

#### Errors
- `400` - Missing omi_user_id or device already linked to another account
- `401` - Authentication required
- `503` - Database not configured

---

### 2. Confirm OMI Linking
**POST** `/link/omi/confirm`

Confirms the device linking using the verification code.

#### Request
```json
{
  "omi_user_id": "device-unique-id",
  "code": "123456"
}
```

#### Response (Success)
```json
{
  "ok": true
}
```

#### Response (Already Verified)
```json
{
  "ok": true,
  "already_verified": true
}
```

#### Errors
- `400` - Missing fields, invalid code, or expired OTP
- `401` - Authentication required
- `403` - Linking request belongs to another user
- `404` - No linking request found
- `429` - Too many attempts (max 5)
- `503` - Database not configured

---

### 3. Sync OMI Conversations
**POST** `/link/omi/sync-conversations`

Synchronizes conversations from linked OMI devices.

#### Request
```json
{}
```

#### Response
```json
{
  "ok": true,
  "synced": 5,
  "message": "Synced 5 conversations"
}
```

#### Errors
- `401` - Authentication required
- `503` - Database not configured

---

## Implementation Details

### Database Schema

```prisma
model OmiUserLink {
  id                    String    @id @default(uuid())
  userId                String
  user                  User      @relation(...)
  omiUserId             String    @unique
  isVerified            Boolean   @default(false)
  verificationCode      String?
  verificationExpiresAt DateTime?
  verificationAttempts  Int       @default(0)
  verifiedAt            DateTime?
  createdAt             DateTime  @default(now())
}
```

### Security Features

1. **OTP Verification**
   - 6-digit random code
   - 10-minute expiration
   - Maximum 5 attempts

2. **Rate Limiting**
   - Start: 5 requests per minute
   - Confirm: 10 requests per minute

3. **Authentication Required**
   - All endpoints require valid session
   - Session token via cookie or header

### Mobile App Integration

The Expo app includes helper functions in `/mobile/lib/api.ts`:

```typescript
// Start linking process
apiStartOmiLink(omi_user_id: string): Promise<{ dev_code?: string } | null>

// Confirm with OTP
apiConfirmOmiLink(omi_user_id: string, code: string): Promise<boolean>

// Sync conversations
apiSyncOmiConversations(): Promise<{ ok: boolean; message?: string } | null>

// Check linked devices
apiMe(): Promise<{ 
  user: User; 
  omi_links: Array<{ omiUserId: string; isVerified: boolean }> 
} | null>
```

## Testing

### Test Script
Use the provided test script:

```bash
# Without authentication (will show appropriate errors)
node test-omi-linking.js

# With authentication
SESSION_TOKEN=your-session-token node test-omi-linking.js
```

### Manual Testing

1. **Start Linking**:
```bash
curl -X POST http://localhost:3000/link/omi/start \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=YOUR_SESSION_TOKEN" \
  -d '{"omi_user_id": "test-device-123"}'
```

2. **Confirm Linking**:
```bash
curl -X POST http://localhost:3000/link/omi/confirm \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=YOUR_SESSION_TOKEN" \
  -d '{"omi_user_id": "test-device-123", "code": "123456"}'
```

3. **Check Profile**:
```bash
curl http://localhost:3000/me \
  -H "Cookie: sid=YOUR_SESSION_TOKEN"
```

## Setup Requirements

### Database Configuration

The OMI linking feature requires a PostgreSQL database:

```bash
# Set database URL
export DATABASE_URL="postgresql://user:password@host:port/database"

# Enable user system
export ENABLE_USER_SYSTEM=true

# Run migrations
npx prisma migrate deploy

# Start server
npm start
```

### Without Database

When no database is configured:
- Endpoints return `503 Service Unavailable`
- Clear error messages guide setup
- System gracefully degrades

## Flow Diagram

```
User → Start Link → Generate OTP → Send to Device
         ↓
    Device Shows OTP
         ↓
User → Confirm Link → Verify OTP → Link Established
         ↓
    Sync Conversations
```

## Error Handling

All endpoints follow consistent error response format:

```json
{
  "error": "Error message",
  "message": "Additional context or help"
}
```

## Rate Limiting

Implemented using custom throttling:
- Tracks requests per user
- Sliding window algorithm
- Configurable limits

## Development Mode

In development (`NODE_ENV=development`):
- OTP code returned in response
- Additional debug logging
- Relaxed rate limits

## Production Considerations

1. **OTP Delivery**: Implement actual OTP delivery to device
2. **Monitoring**: Track linking success/failure rates
3. **Analytics**: Monitor device types and usage
4. **Security**: Regular security audits
5. **Backup**: Device recovery mechanisms