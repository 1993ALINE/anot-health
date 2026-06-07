# Login Performance Analysis & Fixes

## Issues Identified

### 1. Schema Check on Every Login
**Location**: `authController.js` line 41  
**Issue**: `ensureUserProfileSchema()` runs on every login request
- First login after server restart: Checks 4 database columns
- Subsequent logins: Fast (uses `ready` flag)
- **Impact**: Adds unnecessary overhead, especially on first login

### 2. bcrypt Rounds
**Location**: Registration uses 10 rounds (line 158)
- Current setting: **10 rounds** (good for development)
- Login compares against stored hash (line 74)
- If old passwords were hashed with 12+ rounds, they'll be slower

### 3. Database Queries
**Current State**: ✅ OPTIMAL
- Only **1 query** to find user by email (line 50-53)
- No N+1 queries or unnecessary joins

### 4. Sequential Operations
**Current Flow**:
1. Schema check (ensureUserProfileSchema)
2. DB query (find user by email)
3. bcrypt compare (password verification)
4. JWT sign (token generation)
5. Audit logs (fire-and-forget, non-blocking)

**Analysis**: The operations MUST be sequential (can't parallelize auth steps), but audit logs are already optimized with `void` keyword.

## Changes Applied

### Added Detailed Timing Logs
Now logs the time spent in each operation:
```
[LOGIN TIMING] Schema: 5ms | DB: 12ms | bcrypt: 180ms | JWT: 3ms | Total: 200ms
```

This will help identify the actual bottleneck.

## Recommendations

### If bcrypt is slow (>150ms):
1. **Check existing user passwords**:
   - Query database to see what bcrypt rounds were used for existing users
   - Old passwords hashed with 12+ rounds will be slower

2. **Option 1**: Rehash passwords on successful login
   - When user logs in successfully, check if password uses old rounds
   - If yes, rehash with 10 rounds and update database

3. **Option 2**: Wait for users to change passwords naturally
   - New passwords will use 10 rounds
   - Old passwords will gradually phase out

### If schema check is slow on first login:
- Consider moving `ensureUserProfileSchema()` to server startup
- Remove it from the login flow entirely (it's not required for auth)

### If DB query is slow (>50ms):
- Add index on `users.email` column:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  ```

## Next Steps

1. **Test login and check server logs** for timing breakdown
2. **Identify the slowest operation** from the timing logs
3. **Apply appropriate fix** based on the bottleneck identified

## Expected Performance

With optimizations:
- Schema check: 0-5ms (after first login)
- DB query: 5-20ms (with index)
- bcrypt compare: 80-120ms (10 rounds)
- JWT sign: 1-5ms
- **Total: 100-150ms** (acceptable for development)

If you're seeing >200ms consistently, the bcrypt rounds are likely the culprit.
