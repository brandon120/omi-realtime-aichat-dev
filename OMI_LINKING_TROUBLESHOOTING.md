# OMI Linking Troubleshooting Guide

## Error: 400 Bad Request on `/link/omi/start`

### Possible Causes and Solutions

## 1. Missing Authentication
**Symptom**: 400 or 401 error  
**Solution**: Include session token in request

```javascript
// Include in headers
headers: {
  'Cookie': 'sid=your-session-token',
  'Content-Type': 'application/json'
}

// OR use Authorization header
headers: {
  'Authorization': 'Bearer your-session-token',
  'Content-Type': 'application/json'
}
```

## 2. Missing or Invalid Request Body
**Symptom**: 400 error with "omi_user_id is required"  
**Solution**: Ensure request body is properly formatted

```javascript
// Correct format
{
  "omi_user_id": "device-unique-identifier"
}

// Common mistakes to avoid:
// ❌ { "omiUserId": "..." }  // Wrong field name
// ❌ { "device_id": "..." }   // Wrong field name
// ❌ { "omi_user_id": "" }    // Empty value
// ❌ { }                      // Missing field
```

## 3. Database Configuration Issues
**Symptom**: 503 error or database connection errors  
**Solution**: Ensure database is properly configured

```bash
# Check if DATABASE_URL is set
echo $DATABASE_URL

# Verify Prisma can connect
npx prisma db push

# Ensure migrations are applied
npx prisma migrate deploy

# Regenerate Prisma client
npx prisma generate
```

## 4. Schema Mismatch
**Symptom**: Prisma validation errors  
**Solution**: Ensure schema fields match code

The code expects these fields in `OmiUserLink`:
- `verificationCode` (not `otpCode`)
- `verificationExpiresAt` (not `otpExpiry`)
- `verificationAttempts` (not `otpAttempts`)

## 5. Rate Limiting
**Symptom**: 429 error or intermittent 400 errors  
**Solution**: Wait and retry, or check rate limit settings

Default limits:
- `/link/omi/start`: 5 requests per minute
- `/link/omi/confirm`: 10 requests per minute

## 6. Invalid Session
**Symptom**: 401 error  
**Solution**: Login again to get a new session token

```bash
# Test login
curl -X POST http://your-api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password"}'
```

## Diagnostic Steps

### 1. Run Diagnostic Script
```bash
# Without auth (basic connectivity test)
node diagnose-omi-linking.js

# With auth (full test)
SESSION_TOKEN=your-token API_URL=https://your-api.com node diagnose-omi-linking.js
```

### 2. Check Raw Response
```bash
# See exact error message
curl -X POST http://your-api/link/omi/start \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=your-session-token" \
  -d '{"omi_user_id": "test-device"}' \
  -v
```

### 3. Check Server Logs
Look for error messages in server console or logs:
- Authentication failures
- Database connection errors
- Validation errors
- Rate limiting triggers

### 4. Verify Database Schema
```bash
# Check if OmiUserLink table exists
npx prisma studio

# Or query directly
npx prisma db execute --schema prisma/schema.prisma \
  --sql "SELECT column_name FROM information_schema.columns WHERE table_name = 'OmiUserLink';"
```

## Common Error Messages

### "Database required for OMI linking"
- **Status**: 503
- **Cause**: No database configured
- **Fix**: Set DATABASE_URL environment variable

### "Authentication required"
- **Status**: 401
- **Cause**: No session token provided
- **Fix**: Include session token in request

### "omi_user_id is required"
- **Status**: 400
- **Cause**: Missing or empty omi_user_id
- **Fix**: Include valid omi_user_id in request body

### "This OMI device is already linked"
- **Status**: 400
- **Cause**: Device already linked to another account
- **Fix**: Use a different device ID or unlink first

### "Invalid code"
- **Status**: 400
- **Cause**: Wrong OTP code
- **Fix**: Use correct code from device

### "OTP has expired"
- **Status**: 400
- **Cause**: Code older than 10 minutes
- **Fix**: Start linking process again

## Testing Checklist

- [ ] Database configured (`DATABASE_URL` set)
- [ ] User system enabled (`ENABLE_USER_SYSTEM=true`)
- [ ] Prisma migrations applied
- [ ] Valid session token obtained
- [ ] Request includes `omi_user_id`
- [ ] Content-Type header is `application/json`
- [ ] No rate limiting active

## Quick Test Commands

```bash
# 1. Test without auth (should return 401 or 503)
curl -X POST http://localhost:3000/link/omi/start \
  -H "Content-Type: application/json" \
  -d '{"omi_user_id": "test"}'

# 2. Test with auth (replace SESSION_TOKEN)
curl -X POST http://localhost:3000/link/omi/start \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=SESSION_TOKEN" \
  -d '{"omi_user_id": "test"}'

# 3. Check session validity
curl http://localhost:3000/me \
  -H "Cookie: sid=SESSION_TOKEN"
```

## If All Else Fails

1. **Check server startup logs** for initialization errors
2. **Enable debug logging** with `LOG_LEVEL=debug`
3. **Test with a fresh database** to rule out data issues
4. **Verify network connectivity** between client and server
5. **Check for proxy/firewall** issues if using remote server