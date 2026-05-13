-- At most one row may have role = super_admin (prevents duplicates even if API is bypassed).
CREATE UNIQUE INDEX IF NOT EXISTS users_one_super_admin
    ON users ((1))
    WHERE role = 'super_admin';
